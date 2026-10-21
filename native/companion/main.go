package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type Config struct {
	Version        int    `json:"version"`
	DeviceID       string `json:"deviceId"`
	Name           string `json:"name"`
	RemoteRoot     string `json:"remoteRoot"`
	Mount          string `json:"mount"`
	Rclone         string `json:"rclone,omitempty"`
	IncludeLibrary bool   `json:"includeLibrary,omitempty"`
}
type File struct {
	Relative string `json:"relative"`
	Bytes    int64  `json:"bytes"`
	SHA256   string `json:"sha256"`
}
type Manifest struct {
	Version   int      `json:"version"`
	DeviceID  string   `json:"deviceId"`
	CreatedAt string   `json:"createdAt"`
	Files     []File   `json:"files"`
	Bundles   []Bundle `json:"bundles,omitempty"`
}
type Book struct {
	Version    int    `json:"version"`
	JobID      string `json:"jobId"`
	SHA256     string `json:"sha256"`
	Filename   string `json:"filename"`
	RemotePath string `json:"remotePath"`
	Bytes      int64  `json:"bytes"`
}
type Received struct {
	JobID  string `json:"jobId"`
	SHA256 string `json:"sha256"`
}
type Receipts struct {
	BookFormatsVersion int        `json:"bookFormatsVersion"`
	Version            int        `json:"version"`
	DeviceID           string     `json:"deviceId"`
	ReceivedAt         string     `json:"receivedAt"`
	Books              []Received `json:"books"`
}
type RemoteEntry struct {
	Name    string `json:"Name"`
	Path    string `json:"Path"`
	Size    int64  `json:"Size"`
	IsDir   bool   `json:"IsDir"`
	ModTime string `json:"ModTime"`
}
type Agent struct {
	Config         Config
	Directory      string
	Scratch        string
	Context        context.Context
	Progress       Progress
	TitlesOnly     bool
	ProfileOnly    bool
	BooksOnly      bool
	UpdatesOnly    bool
	CatalogFiles   []File
	CatalogObjects map[string]string
	CatalogBundles []Bundle
	BundleSizes    map[string]int64
}

type Progress struct {
	State        string  `json:"state"`
	Stage        string  `json:"stage"`
	Done         int     `json:"done"`
	Total        int     `json:"total"`
	StartedAt    int64   `json:"startedAt"`
	UpdatedAt    int64   `json:"updatedAt"`
	CompletedAt  int64   `json:"completedAt,omitempty"`
	Received     int     `json:"received"`
	Files        int     `json:"files"`
	Error        string  `json:"error,omitempty"`
	TitlesOnly   bool    `json:"titlesOnly,omitempty"`
	ProfileOnly  bool    `json:"profileOnly,omitempty"`
	BooksOnly    bool    `json:"booksOnly,omitempty"`
	UpdatesOnly  bool    `json:"updatesOnly,omitempty"`
	ProfileRoute string  `json:"profileRoute,omitempty"`
	Bytes        int64   `json:"bytes,omitempty"`
	TotalBytes   int64   `json:"totalBytes,omitempty"`
	Speed        float64 `json:"speed,omitempty"`
}

func atomicJSON(filename string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(filename), ".status-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(append(data, '\n'))
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(f.Name(), filename)
}

func (a *Agent) progress(stage string, done, total int) {
	if a.Progress.Stage != stage {
		a.Progress.Bytes, a.Progress.TotalBytes, a.Progress.Speed = 0, 0, 0
	}
	a.Progress.Stage, a.Progress.Done, a.Progress.Total = stage, done, total
	a.Progress.UpdatedAt = time.Now().Unix()
	atomicJSON(filepath.Join(a.Directory, "progress.json"), a.Progress)
}

var uuid = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
var fingerprint = regexp.MustCompile(`^[0-9a-f]{64}$`)

const maxFile = 200 * 1024 * 1024

var errPaused = errors.New("sync paused")

type cloudCommandError struct {
	exitCode int
}

func (e *cloudCommandError) Error() string {
	return "cloud operation failed; check network and cloud authorization"
}

func (a *Agent) paused() bool {
	name := "pause.requested"
	if a.TitlesOnly {
		name = "titles-pause.requested"
	}
	if a.ProfileOnly {
		name = "profile-pause.requested"
	}
	if a.BooksOnly {
		name = "books-pause.requested"
	}
	_, err := os.Stat(filepath.Join(a.Directory, name))
	return err == nil
}

func safeRemote(value string) (string, error) {
	if value == "" || strings.ContainsAny(value, "\\:\x00\r\n") || strings.HasPrefix(value, "/") {
		return "", errors.New("invalid cloud path")
	}
	for _, part := range strings.Split(value, "/") {
		if part == ".." || part == "." || part == "" {
			return "", errors.New("invalid cloud path")
		}
	}
	return value, nil
}
func sha(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }
func hashFile(filename string) (string, error) {
	f, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, io.LimitReader(f, maxFile+1)); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func hashFileUnlimited(filename string) (string, error) {
	f, err := os.Open(filename)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
func (a *Agent) run(args ...string) ([]byte, error) {
	return a.runCommand("", 0, args...)
}

func (a *Agent) runCommand(stage string, total int, args ...string) ([]byte, error) {
	if a.paused() {
		return nil, errPaused
	}
	binary := a.Config.Rclone
	if binary == "" {
		binary = filepath.Join(a.Directory, "rclone")
	}
	args = append(args, "--config", filepath.Join(a.Directory, "rclone.conf"), "--retries", "2", "--contimeout", "15s", "--timeout", "60s", "--log-level", "ERROR")
	if _, err := os.Stat(filepath.Join(a.Directory, "ca.pem")); err == nil {
		args = append(args, "--ca-cert", filepath.Join(a.Directory, "ca.pem"))
	}
	ctx, cancel := context.WithCancel(a.Context)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(200 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				if a.paused() {
					cancel()
					return
				}
			}
		}
	}()
	command := exec.CommandContext(ctx, binary, args...)
	if stage != "" {
		command.Args = append(command.Args, "--stats", "2s", "--stats-log-level", "NOTICE", "--use-json-log", "--log-level", "NOTICE")
		command.Stderr = &statsWriter{update: func(stats TransferStats) {
			a.Progress.Bytes, a.Progress.TotalBytes, a.Progress.Speed = stats.Bytes, stats.TotalBytes, stats.Speed
			done := stats.Transfers
			if done > total {
				done = total
			}
			a.progress(stage, done, total)
		}}
	}
	output, err := command.Output()
	if err != nil {
		if a.paused() {
			return nil, errPaused
		}
		if a.Context.Err() != nil {
			return nil, errors.New("sync timed out; reconnect Wi-Fi and try again")
		}
		var failure *exec.ExitError
		if errors.As(err, &failure) {
			return nil, &cloudCommandError{exitCode: failure.ExitCode()}
		}
		return nil, &cloudCommandError{exitCode: -1}
	}
	return output, nil
}
func (a *Agent) read(remote string, limit int64) ([]byte, error) {
	if _, err := safeRemote(remote); err != nil {
		return nil, err
	}
	file := filepath.Join(a.Scratch, "read-"+sha([]byte(remote)))
	defer os.Remove(file)
	_, err := a.run("copyto", "remote:"+remote, file, "--max-transfer", fmt.Sprint(limit), "--cutoff-mode", "HARD")
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(file)
	if err != nil || info.Size() > limit {
		return nil, errors.New("cloud data exceeds limit")
	}
	return os.ReadFile(file)
}
func (a *Agent) write(remote string, data []byte) error {
	file := filepath.Join(a.Scratch, "write-"+sha(data))
	if err := os.WriteFile(file, data, 0600); err != nil {
		return err
	}
	defer os.Remove(file)
	if _, err := a.run("copyto", file, "remote:"+remote); err != nil {
		return err
	}
	verify, err := a.read(remote, int64(len(data))+1024)
	if err != nil {
		return err
	}
	if sha(verify) != sha(data) {
		return errors.New("cloud write verification failed")
	}
	return nil
}
func (a *Agent) receive() (int, error) {
	count, err := a.receiveJobs()
	if err != nil {
		return count, err
	}
	additional, err := a.receiveBookFolder()
	a.Progress.Received = count + additional
	return count + additional, err
}

func (a *Agent) receiveJobs() (int, error) {
	a.progress("checking_inbox", 0, 0)
	out, err := a.run("lsjson", "remote:"+a.Config.RemoteRoot+"/outbox", "--files-only", "--max-depth", "1")
	if err != nil {
		return 0, err
	}
	var entries []RemoteEntry
	if err = json.Unmarshal(out, &entries); err != nil {
		return 0, errors.New("invalid outbox")
	}
	if len(entries) > 10000 {
		return 0, errors.New("outbox exceeds limit")
	}
	receipts := Receipts{Version: 1, DeviceID: a.Config.DeviceID, Books: []Received{}}
	local := filepath.Join(a.Directory, "receipts.json")
	if data, e := os.ReadFile(local); e == nil {
		json.Unmarshal(data, &receipts)
	}
	receipts.BookFormatsVersion = 2
	received := map[string]string{}
	for _, r := range receipts.Books {
		received[r.JobID] = r.SHA256
	}
	cache := a.loadBookJobs()
	previousCount := len(receipts.Books)
	count := 0
	processed := 0
	jobs := 0
	for _, entry := range entries {
		if uuid.MatchString(strings.TrimSuffix(entry.Name, ".json")) && !entry.IsDir && strings.HasSuffix(entry.Name, ".json") {
			jobs++
		}
	}
	for _, entry := range entries {
		if !uuid.MatchString(strings.TrimSuffix(entry.Name, ".json")) || entry.IsDir || !strings.HasSuffix(entry.Name, ".json") {
			continue
		}
		a.progress("receiving_books", processed, jobs)
		if a.cachedBookJob(entry, cache, received) {
			processed++
			continue
		}
		data, e := a.read(a.Config.RemoteRoot+"/outbox/"+entry.Name, 65536)
		if e != nil {
			return count, e
		}
		var book Book
		if json.Unmarshal(data, &book) != nil || book.Version != 1 || !uuid.MatchString(book.JobID) || book.JobID+".json" != entry.Name || !fingerprint.MatchString(book.SHA256) || book.Bytes < 1 || book.Bytes > maxFile {
			return count, errors.New("invalid book manifest")
		}
		if _, e = safeRemote(book.RemotePath); e != nil {
			return count, e
		}
		if filepath.Base(book.Filename) != book.Filename || strings.ContainsAny(book.Filename, "\\/:\x00") || !readableBookFilename(book.Filename) {
			return count, errors.New("invalid book filename")
		}
		filename := filepath.Join(a.Config.Mount, "Books", "Inbox", book.SHA256[:12]+"-"+book.Filename)
		if h, e := hashFile(filename); e == nil && h == book.SHA256 {
			if received[book.JobID] != book.SHA256 {
				receipts.Books = append(receipts.Books, Received{book.JobID, book.SHA256})
				received[book.JobID] = book.SHA256
			}
			processed++
			a.rememberBookJob(entry, book, filename, &cache)
			a.progress("receiving_books", processed, jobs)
			continue
		}
		if err = ensureBookInbox(a.Config.Mount); err != nil {
			return count, err
		}
		temporary := filename + ".partial"
		os.Remove(temporary)
		if _, err = a.run("copyto", "remote:"+book.RemotePath, temporary, "--max-transfer", fmt.Sprint(maxFile), "--cutoff-mode", "HARD"); err != nil {
			os.Remove(temporary)
			return count, err
		}
		info, e := os.Stat(temporary)
		h, he := hashFile(temporary)
		if e != nil || he != nil || info.Size() != book.Bytes || h != book.SHA256 {
			os.Remove(temporary)
			return count, errors.New("download verification failed")
		}
		if _, e = os.Lstat(filename); e == nil {
			os.Remove(temporary)
			return count, errors.New("existing device file differs; preserved both originals")
		}
		if err = os.Rename(temporary, filename); err != nil {
			return count, err
		}
		check, e := hashFile(filename)
		if e != nil || check != book.SHA256 {
			return count, errors.New("device readback verification failed")
		}
		if received[book.JobID] != book.SHA256 {
			receipts.Books = append(receipts.Books, Received{book.JobID, book.SHA256})
			received[book.JobID] = book.SHA256
		}
		count++
		a.rememberBookJob(entry, book, filename, &cache)
		processed++
		a.Progress.Received = count
		a.progress("receiving_books", processed, jobs)
	}
	a.progress("saving_receipts", 0, 0)
	if receipts.ReceivedAt == "" || len(receipts.Books) != previousCount || count > 0 {
		receipts.ReceivedAt = time.Now().UTC().Format(time.RFC3339Nano)
	}
	data, _ := json.Marshal(receipts)
	if err = os.WriteFile(local, data, 0600); err != nil {
		return count, err
	}
	if cache.Published != sha(data) {
		if err = a.write(a.Config.RemoteRoot+"/devices/"+a.Config.DeviceID+"/receipts.json", data); err != nil {
			return count, err
		}
		cache.Published = sha(data)
	}
	return count, atomicJSON(filepath.Join(a.Directory, "book-job-cache.json"), cache)
}
func (a *Agent) stableCopy(source, relative string) (File, string, error) {
	info, err := os.Lstat(source)
	if err != nil {
		return File{}, "", err
	}
	if !info.Mode().IsRegular() || info.Size() > maxFile {
		return File{}, "", errors.New("unsupported source file")
	}
	bytes, err := os.ReadFile(source)
	if err != nil {
		return File{}, "", err
	}
	after, err := os.Lstat(source)
	if err != nil || info.Size() != after.Size() || !info.ModTime().Equal(after.ModTime()) {
		return File{}, "", errors.New("source changed during sync; retry after saving")
	}
	hash := sha(bytes)
	filename := filepath.Join(a.Scratch, hash)
	if err = os.WriteFile(filename, bytes, 0600); err != nil {
		return File{}, "", err
	}
	return File{relative, int64(len(bytes)), hash}, filename, nil
}
func (a *Agent) snapshot() (int, error) {
	a.progress("scanning_notes", 0, 0)
	manifest := Manifest{Version: 1, DeviceID: a.Config.DeviceID, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Files: []File{}}
	objects := map[string]string{}
	manifest.Files = append(manifest.Files, a.CatalogFiles...)
	for hash, filename := range a.CatalogObjects {
		objects[hash] = filename
	}
	var total int64
	for _, root := range []string{".notebooks", "documents", "Books"} {
		base := filepath.Join(a.Config.Mount, root)
		if _, err := os.Stat(base); os.IsNotExist(err) {
			continue
		}
		err := filepath.WalkDir(base, func(filename string, entry os.DirEntry, walkErr error) error {
			if a.paused() {
				return errPaused
			}
			if walkErr != nil {
				return walkErr
			}
			name := entry.Name()
			if entry.IsDir() {
				if name == ".backups" || name == "clipboard" || name == "page_cache" {
					return filepath.SkipDir
				}
				return nil
			}
			if entry.Type()&os.ModeSymlink != 0 || strings.HasSuffix(name, ".partial") || strings.HasSuffix(name, "-journal") || strings.HasSuffix(name, ".log") {
				return nil
			}
			relative, err := filepath.Rel(a.Config.Mount, filename)
			if err != nil {
				return err
			}
			normalized := filepath.ToSlash(relative)
			if !a.Config.IncludeLibrary && root != ".notebooks" && !strings.Contains(normalized, ".sdr/") && name != "My Clippings.txt" {
				return nil
			}
			f, copy, err := a.stableCopy(filename, normalized)
			if err != nil {
				return err
			}
			total += f.Bytes
			if total > 5*1024*1024*1024 || len(manifest.Files) >= 20000 {
				return errors.New("snapshot exceeds limit")
			}
			manifest.Files = append(manifest.Files, f)
			objects[f.SHA256] = copy
			a.progress("scanning_notes", len(manifest.Files), 0)
			return nil
		})
		if err != nil {
			return 0, err
		}
	}
	for _, item := range []struct{ source, relative string }{{"/var/local/cc.db", "cc.db"}, {filepath.Join(a.Config.Mount, "koreader/settings/statistics.sqlite3"), "statistics.sqlite3"}, {filepath.Join(a.Config.Mount, "koreader/statistics.sqlite3"), "statistics.sqlite3"}} {
		if a.paused() {
			return 0, errPaused
		}
		if _, err := os.Stat(item.source); err != nil {
			continue
		}
		duplicate := false
		for _, f := range manifest.Files {
			if f.Relative == item.relative {
				duplicate = true
			}
		}
		if duplicate {
			continue
		}
		a.progress("backing_up_catalog", len(manifest.Files), 0)
		filename := filepath.Join(a.Scratch, item.relative)
		if sqlite, err := exec.LookPath("sqlite3"); err == nil {
			command := exec.CommandContext(a.Context, sqlite, "-readonly", item.source, ".backup '"+strings.ReplaceAll(filename, "'", "''")+"'")
			if err = command.Run(); err != nil {
				return 0, errors.New("cannot take consistent reading database snapshot")
			}
		} else {
			return 0, errors.New("sqlite3 is required for a consistent device catalog snapshot")
		}
		f, copy, err := a.stableCopy(filename, item.relative)
		if err != nil {
			return 0, err
		}
		manifest.Files = append(manifest.Files, f)
		objects[f.SHA256] = copy
	}
	a.Progress.Files = len(manifest.Files)
	a.progress("checking_cloud", 0, 0)
	out, err := a.run("lsjson", "remote:"+a.Config.RemoteRoot+"/objects", "--files-only", "--max-depth", "1")
	if err != nil {
		return 0, err
	}
	var existing []RemoteEntry
	if json.Unmarshal(out, &existing) != nil {
		return 0, errors.New("invalid object listing")
	}
	known := map[string]int64{}
	for _, e := range existing {
		known[e.Name] = e.Size
	}
	manifest.Bundles, err = a.uploadBundles(objects, known)
	if err != nil {
		return 0, err
	}
	manifest.Version = 2
	a.progress("publishing", 0, 0)
	data, _ := json.Marshal(manifest)
	hash := sha(data)
	base := a.Config.RemoteRoot + "/devices/" + a.Config.DeviceID
	if err = a.write(base+"/snapshots/"+hash+".json", data); err != nil {
		return 0, err
	}
	pointer, _ := json.Marshal(map[string]string{"manifest": hash})
	if err = a.write(base+"/latest.json", pointer); err != nil {
		return 0, err
	}
	return len(manifest.Files), nil
}
func (a *Agent) publishCatalog() (int, error) {
	a.progress("syncing_titles", 0, 0)
	manifest := Manifest{Version: 1, DeviceID: a.Config.DeviceID, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Files: []File{}}
	a.CatalogObjects = map[string]string{}
	for _, name := range []string{"ksdk.content.db", "cc.db"} {
		filename := filepath.Join(a.Directory, "catalog", name)
		if _, err := os.Stat(filename); os.IsNotExist(err) {
			continue
		}
		file, copy, err := a.stableCopy(filename, name)
		if err != nil {
			return 0, err
		}
		manifest.Files = append(manifest.Files, file)
		a.CatalogObjects[file.SHA256] = copy
		a.progress("syncing_titles", len(manifest.Files), 0)
	}
	if len(manifest.Files) == 0 {
		return 0, nil
	}
	a.CatalogFiles = manifest.Files
	var err error
	manifest.Bundles, err = a.uploadBundles(a.CatalogObjects, map[string]int64{})
	if err != nil {
		return 0, err
	}
	a.CatalogBundles = manifest.Bundles
	manifest.Version = 2
	data, _ := json.Marshal(manifest)
	hash := sha(data)
	base := a.Config.RemoteRoot + "/devices/" + a.Config.DeviceID + "/catalog"
	if err := a.write(base+"/snapshots/"+hash+".json", data); err != nil {
		return 0, err
	}
	pointer, _ := json.Marshal(map[string]string{"manifest": hash})
	if err := a.write(base+"/latest.json", pointer); err != nil {
		return 0, err
	}
	return len(manifest.Files), nil
}

func execute(filename string) (map[string]any, error) { return executeMode(filename, false) }

func executeMode(filename string, titlesOnly bool) (result map[string]any, resultErr error) {
	return executeOptions(filename, titlesOnly, false)
}

func executeOptions(filename string, titlesOnly, profileOnly bool) (result map[string]any, resultErr error) {
	return executeSyncMode(filename, titlesOnly, profileOnly, false)
}

func executeSyncMode(filename string, titlesOnly, profileOnly, booksOnly bool) (map[string]any, error) {
	return executeBackgroundMode(filename, titlesOnly, profileOnly, booksOnly, false)
}

func executeBackgroundMode(filename string, titlesOnly, profileOnly, booksOnly, updatesOnly bool) (result map[string]any, resultErr error) {
	data, err := os.ReadFile(filename)
	if err != nil {
		return nil, errors.New("device pairing configuration is missing")
	}
	var config Config
	if json.Unmarshal(data, &config) != nil || config.Version != 1 || !uuid.MatchString(config.DeviceID) || !filepath.IsAbs(config.Mount) {
		return nil, errors.New("invalid pairing configuration")
	}
	if _, err = safeRemote(config.RemoteRoot); err != nil {
		return nil, err
	}
	directory := filepath.Dir(filename)
	lock := filepath.Join(directory, "sync.lock")
	f, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, errors.New("another sync is running; remove a stale lock only after confirming it has stopped")
	}
	_, err = fmt.Fprintln(f, os.Getpid())
	closeErr := f.Close()
	defer os.Remove(lock)
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	agent := Agent{Config: config, Directory: directory, TitlesOnly: titlesOnly, ProfileOnly: profileOnly, BooksOnly: booksOnly, UpdatesOnly: updatesOnly, Progress: Progress{State: "running", StartedAt: time.Now().Unix(), TitlesOnly: titlesOnly, ProfileOnly: profileOnly, BooksOnly: booksOnly, UpdatesOnly: updatesOnly}}
	if err = atomicJSON(filepath.Join(directory, "progress.json"), agent.Progress); err != nil {
		return nil, err
	}
	defer func() {
		agent.Progress.CompletedAt = time.Now().Unix()
		agent.Progress.State = "completed"
		if errors.Is(resultErr, errPaused) {
			agent.Progress.State = "paused"
			result = map[string]any{"ok": false, "paused": true}
			agent.progress(agent.Progress.Stage, agent.Progress.Done, agent.Progress.Total)
			return
		}
		if resultErr != nil {
			agent.Progress.State = "failed"
			agent.Progress.Error = resultErr.Error()
			result = map[string]any{"ok": false, "error": resultErr.Error(), "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}
		}
		if err := atomicJSON(filepath.Join(directory, "last-result.json"), result); err != nil && resultErr == nil {
			resultErr = errors.New("cannot save sync result on device")
			agent.Progress.State, agent.Progress.Error = "failed", resultErr.Error()
		}
		agent.progress(agent.Progress.Stage, agent.Progress.Done, agent.Progress.Total)
	}()
	scratch, err := os.MkdirTemp(directory, "sync-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(scratch)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Hour)
	defer cancel()
	agent.Scratch, agent.Context = scratch, ctx
	localProfile := false
	if !titlesOnly && !booksOnly {
		localProfile, err = agent.receiveLANProfile()
		if err != nil {
			return nil, err
		}
		if localProfile && profileOnly {
			return map[string]any{"ok": true, "profileOnly": true, "profileRoute": "lan", "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}, nil
		}
	}
	agent.progress("checking_pairing", 0, 0)
	data, err = agent.read(path.Join(config.RemoteRoot, "pairings", config.DeviceID+".json"), 65536)
	if err != nil {
		return nil, err
	}
	var pairing struct {
		Version  int    `json:"version"`
		DeviceID string `json:"deviceId"`
		Active   bool   `json:"active"`
	}
	if json.Unmarshal(data, &pairing) != nil || pairing.Version != 1 || pairing.DeviceID != config.DeviceID || !pairing.Active {
		return nil, errors.New("device pairing has been revoked")
	}
	if err = agent.publishInstallationReceipt(); err != nil {
		return nil, err
	}
	if booksOnly {
		count, err := agent.receive()
		if err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "booksOnly": true, "received": count, "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}, nil
	}
	if !titlesOnly && !localProfile {
		agent.Progress.ProfileRoute = "cloud"
		if err = agent.receiveSleepSettings(); err != nil {
			return nil, err
		}
	}
	if profileOnly {
		return map[string]any{"ok": true, "profileOnly": true, "profileRoute": agent.Progress.ProfileRoute, "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}, nil
	}
	if updatesOnly {
		if err = agent.annotations(); err != nil {
			return nil, err
		}
		return map[string]any{"ok": true, "updatesOnly": true, "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}, nil
	}
	catalogs, err := agent.publishCatalog()
	if err != nil {
		return nil, err
	}
	if titlesOnly {
		if catalogs == 0 {
			return nil, errors.New("notebook title index unavailable; collect notebook titles first")
		}
		agent.Progress.Files = catalogs
		return map[string]any{"ok": true, "titlesOnly": true, "files": catalogs, "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}, nil
	}
	count, err := agent.receive()
	if err != nil {
		return nil, err
	}
	files, err := agent.snapshot()
	if err != nil {
		if errors.Is(err, errPaused) {
			return nil, err
		}
		status, _ := json.Marshal(map[string]any{"ok": false, "error": err.Error()})
		agent.write(config.RemoteRoot+"/devices/"+config.DeviceID+"/status.json", status)
		return nil, err
	}
	if err = agent.annotations(); err != nil {
		return nil, err
	}
	status, _ := json.Marshal(map[string]any{"ok": true})
	if err = agent.write(config.RemoteRoot+"/devices/"+config.DeviceID+"/status.json", status); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "received": count, "files": files, "completedAt": time.Now().UTC().Format(time.RFC3339Nano)}, nil
}
func main() {
	config := flag.String("config", "/mnt/us/kindlespouse/config.json", "configuration path")
	titlesOnly := flag.Bool("titles-only", false, "sync notebook title index only")
	profileOnly := flag.Bool("profile-only", false, "sync profile without books and notes")
	booksOnly := flag.Bool("books-only", false, "receive books without backing up notes")
	updatesOnly := flag.Bool("updates-only", false, "receive profile and annotation edits without scanning notes")
	flag.Parse()
	if *titlesOnly && *profileOnly || *booksOnly && (*titlesOnly || *profileOnly) || *updatesOnly && (*titlesOnly || *profileOnly || *booksOnly) {
		os.Exit(1)
	}
	result, err := executeBackgroundMode(*config, *titlesOnly, *profileOnly, *booksOnly, *updatesOnly)
	if err != nil {
		result = map[string]any{"ok": false, "error": err.Error()}
	}
	json.NewEncoder(os.Stdout).Encode(result)
	if err != nil {
		os.Exit(1)
	}
}
