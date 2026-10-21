package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

type AnnotationExpected struct {
	Text     string `json:"text"`
	Note     string `json:"note"`
	Datetime string `json:"datetime"`
	Pos0     string `json:"pos0"`
	Pos1     string `json:"pos1"`
	Page     int    `json:"page,omitempty"`
}
type AnnotationJob struct {
	Version      int                `json:"version"`
	JobID        string             `json:"jobId"`
	DeviceID     string             `json:"deviceId"`
	NoteID       string             `json:"noteId"`
	BookHash     string             `json:"bookHash"`
	BookRelative string             `json:"bookRelative"`
	Relative     string             `json:"relative"`
	Expected     AnnotationExpected `json:"expected"`
	Operation    string             `json:"operation"`
	Note         string             `json:"note"`
	BookSize     int64              `json:"bookSize,omitempty"`
	BookModified int64              `json:"bookModified,omitempty"`
}

func localAnnotationPath(mount, relative string) (string, error) {
	if _, err := safeRemote(relative); err != nil {
		return "", err
	}
	if !strings.HasPrefix(relative, "Books/") && !strings.HasPrefix(relative, "documents/") {
		return "", errors.New("invalid annotation root")
	}
	current := mount
	for _, part := range strings.Split(relative, "/") {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("annotation symlink rejected")
		}
	}
	return current, nil
}

func (a *Agent) prepareAnnotation(job *AnnotationJob) error {
	if job.Version != 1 || !uuid.MatchString(job.JobID) || job.DeviceID != a.Config.DeviceID || !fingerprint.MatchString(job.BookHash) || !fingerprint.MatchString(job.NoteID) || len(job.Note) > 60000 || len(job.Expected.Text) > 60000 || job.Operation != "edit" && job.Operation != "delete" {
		return errors.New("invalid annotation job")
	}
	extension := filepath.Ext(job.BookRelative)
	if !readableBookFilename(job.BookRelative) || extension == "" || job.Relative != strings.TrimSuffix(job.BookRelative, extension)+".sdr/metadata"+extension+".lua" {
		return errors.New("annotation sidecar does not match book")
	}
	filename, err := localAnnotationPath(a.Config.Mount, job.BookRelative)
	if err != nil {
		return err
	}
	if _, err = localAnnotationPath(a.Config.Mount, job.Relative); err != nil {
		return err
	}
	actual, err := hashFile(filename)
	if err != nil || actual != job.BookHash {
		return errors.New("annotation edition conflict")
	}
	info, err := os.Stat(filename)
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("annotation book missing")
	}
	job.BookSize, job.BookModified = info.Size(), info.ModTime().Unix()
	return nil
}

func (a *Agent) annotations() error {
	a.progress("receiving_annotations", 0, 0)
	base := a.Config.RemoteRoot + "/devices/" + a.Config.DeviceID
	queue := filepath.Join(a.Directory, "annotation-jobs")
	results := filepath.Join(a.Directory, "annotation-results")
	if err := os.MkdirAll(queue, 0700); err != nil {
		return err
	}
	if err := os.MkdirAll(results, 0700); err != nil {
		return err
	}
	data, err := a.run("lsjson", "remote:"+base, "--max-depth", "1")
	if err != nil {
		return err
	}
	var dirs []RemoteEntry
	if json.Unmarshal(data, &dirs) != nil {
		return errors.New("invalid device directories")
	}
	exists := false
	for _, entry := range dirs {
		if entry.Name == "annotation-outbox" {
			exists = true
		}
	}
	if exists {
		data, err = a.run("lsjson", "remote:"+base+"/annotation-outbox", "--files-only", "--max-depth", "1")
		if err != nil {
			return err
		}
		var entries []RemoteEntry
		if json.Unmarshal(data, &entries) != nil || len(entries) > 10000 {
			return errors.New("invalid annotation queue")
		}
		for _, entry := range entries {
			if !uuid.MatchString(strings.TrimSuffix(entry.Name, ".json")) || !strings.HasSuffix(entry.Name, ".json") || entry.Size > 200000 {
				continue
			}
			if _, e := os.Stat(filepath.Join(results, entry.Name)); e == nil {
				continue
			}
			if _, e := os.Stat(filepath.Join(queue, entry.Name)); e == nil {
				continue
			}
			content, e := a.read(base+"/annotation-outbox/"+entry.Name, 200000)
			if e != nil {
				return e
			}
			var job AnnotationJob
			if json.Unmarshal(content, &job) != nil || job.JobID+".json" != entry.Name {
				return errors.New("invalid annotation request")
			}
			if e = a.prepareAnnotation(&job); e != nil {
				if e = atomicJSON(filepath.Join(results, entry.Name), map[string]any{"jobId": job.JobID, "status": "conflict"}); e != nil {
					return e
				}
				continue
			}
			if e = atomicJSON(filepath.Join(queue, entry.Name), job); e != nil {
				return e
			}
		}
	}
	entries, err := os.ReadDir(results)
	if err != nil {
		return err
	}
	type Result struct {
		JobID  string `json:"jobId"`
		Status string `json:"status"`
	}
	receipts := []Result{}
	for _, entry := range entries {
		if !uuid.MatchString(strings.TrimSuffix(entry.Name(), ".json")) {
			continue
		}
		bytes, e := os.ReadFile(filepath.Join(results, entry.Name()))
		if e != nil || len(bytes) > 4096 {
			continue
		}
		var result Result
		if json.Unmarshal(bytes, &result) != nil || result.JobID+".json" != entry.Name() || result.Status != "applied" && result.Status != "conflict" {
			continue
		}
		receipts = append(receipts, result)
		if _, e := os.Stat(filepath.Join(results, entry.Name()+".uploaded")); e != nil {
			if e = a.write(base+"/annotation-results/"+entry.Name(), bytes); e != nil {
				return e
			}
			if e = os.WriteFile(filepath.Join(results, entry.Name()+".uploaded"), []byte("ok"), 0600); e != nil {
				return e
			}
		}
	}
	if len(receipts) > 400 {
		receipts = receipts[len(receipts)-400:]
	}
	if len(receipts) > 0 {
		bytes, _ := json.Marshal(map[string]any{"version": 1, "deviceId": a.Config.DeviceID, "results": receipts})
		return a.write(base+"/annotation-receipts.json", bytes)
	}
	return nil
}
