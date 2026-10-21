package main

import (
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
)

type LocalBook struct {
	Bytes    int64  `json:"bytes"`
	Modified int64  `json:"modified"`
	SHA256   string `json:"sha256"`
	MD5      string `json:"md5"`
	SHA1     string `json:"sha1"`
}

type FolderBook struct {
	Path    string            `json:"Path"`
	Size    int64             `json:"Size"`
	IsDir   bool              `json:"IsDir"`
	ModTime string            `json:"ModTime"`
	Hashes  map[string]string `json:"Hashes"`
}

type CloudBook struct {
	Version  string `json:"version"`
	SHA256   string `json:"sha256"`
	Filename string `json:"filename"`
}

type BookFolderCache struct {
	Local     map[string]LocalBook `json:"local"`
	Cloud     map[string]CloudBook `json:"cloud"`
	Published string               `json:"published"`
}

func bookFolderPath(folder, root string) (string, error) {
	if _, err := safeRemote(folder); err != nil {
		return "", err
	}
	if folder == root || strings.HasPrefix(folder, root+"/") || strings.HasPrefix(root, folder+"/") {
		return "", errors.New("book folder overlaps private sync data")
	}
	return folder, nil
}

func folderBookPath(relative string) bool {
	if _, err := safeRemote(relative); err != nil || !readableBookFilename(relative) {
		return false
	}
	for _, part := range strings.Split(relative, "/") {
		if strings.HasPrefix(part, ".") || strings.HasSuffix(strings.ToLower(part), ".sdr") {
			return false
		}
	}
	return true
}

func (a *Agent) bookFolder() (string, error) {
	content, err := a.read(a.Config.RemoteRoot+"/book-folder.json", 4096)
	if err != nil {
		var failure *cloudCommandError
		if errors.As(err, &failure) && (failure.exitCode == 3 || failure.exitCode == 4) {
			return bookFolderPath(path.Join(path.Dir(a.Config.RemoteRoot), "Inbox"), a.Config.RemoteRoot)
		}
		return "", err
	}
	var config struct {
		Version int    `json:"version"`
		Folder  string `json:"folder"`
	}
	if json.Unmarshal(content, &config) != nil || config.Version != 1 {
		return "", errors.New("invalid Kindle book folder configuration")
	}
	return bookFolderPath(config.Folder, a.Config.RemoteRoot)
}

func (a *Agent) localBookHashes(cache *BookFolderCache) (map[string]string, error) {
	known := map[string]string{}
	current := map[string]LocalBook{}
	for _, root := range []string{"Books", "documents"} {
		err := filepath.WalkDir(filepath.Join(a.Config.Mount, root), func(filename string, entry fs.DirEntry, err error) error {
			if a.paused() {
				return errPaused
			}
			if os.IsNotExist(err) {
				return nil
			}
			if err != nil {
				return err
			}
			relative, err := filepath.Rel(a.Config.Mount, filename)
			if err != nil {
				return err
			}
			if entry.IsDir() {
				if strings.HasPrefix(entry.Name(), ".") || strings.HasSuffix(strings.ToLower(entry.Name()), ".sdr") {
					return filepath.SkipDir
				}
				return nil
			}
			if !folderBookPath(filepath.ToSlash(relative)) || entry.Type()&os.ModeSymlink != 0 {
				return nil
			}
			info, err := entry.Info()
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() || info.Size() < 1 || info.Size() > maxFile {
				return nil
			}
			if len(current) >= 20000 {
				return errors.New("device book index exceeds limit")
			}
			item := cache.Local[relative]
			if item.Bytes != info.Size() || item.Modified != info.ModTime().UnixNano() || !fingerprint.MatchString(item.SHA256) || item.MD5 == "" || item.SHA1 == "" {
				digests, err := bookDigests(filename)
				if err != nil {
					return err
				}
				item = LocalBook{info.Size(), info.ModTime().UnixNano(), digests["sha256"], digests["md5"], digests["sha1"]}
			}
			current[relative] = item
			known[item.SHA256] = filename
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	cache.Local = current
	return known, nil
}

func bookDigests(filename string) (map[string]string, error) {
	file, err := os.Open(filename)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	strong, legacy, older := sha256.New(), md5.New(), sha1.New()
	if _, err = io.Copy(io.MultiWriter(strong, legacy, older), io.LimitReader(file, maxFile+1)); err != nil {
		return nil, err
	}
	digest := hex.EncodeToString(strong.Sum(nil))
	return map[string]string{"sha256": digest, "md5": hex.EncodeToString(legacy.Sum(nil)), "sha1": hex.EncodeToString(older.Sum(nil))}, nil
}

func verifyCloudBookHashes(values map[string]string, entry FolderBook) error {
	for algorithm, expected := range entry.Hashes {
		key := strings.ReplaceAll(strings.ToLower(algorithm), "-", "")
		if actual, ok := values[key]; ok && expected != "" && !strings.EqualFold(actual, expected) {
			return errors.New("cloud book hash changed during download")
		}
	}
	return nil
}

func cloudBookIdentity(entry FolderBook) string {
	values := map[string]string{}
	for algorithm, value := range entry.Hashes {
		values[strings.ReplaceAll(strings.ToLower(algorithm), "-", "")] = strings.ToLower(value)
	}
	for _, algorithm := range []string{"sha256", "sha1", "md5"} {
		if values[algorithm] != "" {
			return fmt.Sprintf("%s:%s:%d", algorithm, values[algorithm], entry.Size)
		}
	}
	return ""
}

func ensureBookInbox(mount string) error {
	for _, directory := range []string{mount, filepath.Join(mount, "Books"), filepath.Join(mount, "Books", "Inbox")} {
		info, err := os.Lstat(directory)
		if os.IsNotExist(err) {
			if err = os.Mkdir(directory, 0755); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("unsafe device book directory")
		}
	}
	return nil
}

func (a *Agent) receiveBookFolder() (int, error) {
	folder, err := a.bookFolder()
	if err != nil {
		return 0, err
	}
	a.progress("checking_book_folder", 0, 0)
	data, err := a.run("lsjson", "remote:"+folder, "--recursive", "--max-depth", "8", "--files-only", "--hash")
	if err != nil {
		var failure *cloudCommandError
		if errors.As(err, &failure) && (failure.exitCode == 3 || failure.exitCode == 4) {
			return 0, nil
		}
		return 0, err
	}
	var entries []FolderBook
	if json.Unmarshal(data, &entries) != nil || len(entries) > 20000 {
		return 0, errors.New("invalid cloud book folder listing")
	}
	cache := BookFolderCache{Local: map[string]LocalBook{}, Cloud: map[string]CloudBook{}}
	filename := filepath.Join(a.Directory, "book-folder-cache.json")
	if previous, err := os.ReadFile(filename); err == nil {
		json.Unmarshal(previous, &cache)
	}
	if cache.Local == nil {
		cache.Local = map[string]LocalBook{}
	}
	if cache.Cloud == nil {
		cache.Cloud = map[string]CloudBook{}
	}
	known, err := a.localBookHashes(&cache)
	if err != nil {
		return 0, err
	}
	providerKnown := map[string]string{}
	for _, item := range cache.Local {
		for algorithm, digest := range map[string]string{"sha256": item.SHA256, "md5": item.MD5, "sha1": item.SHA1} {
			providerKnown[fmt.Sprintf("%s:%s:%d", algorithm, digest, item.Bytes)] = item.SHA256
		}
	}
	received, processed := 0, 0
	receipts := map[string]CloudBook{}
	for _, entry := range entries {
		if a.paused() {
			return received, errPaused
		}
		if entry.IsDir || entry.Size < 1 || entry.Size > maxFile || !folderBookPath(entry.Path) {
			continue
		}
		remote := folder + "/" + entry.Path
		version, _ := json.Marshal(entry)
		previous := cache.Cloud[remote]
		identity := cloudBookIdentity(entry)
		stable := entry.ModTime != "" || identity != ""
		if stable && previous.Version == sha(version) && known[previous.SHA256] != "" {
			relative, err := filepath.Rel(a.Config.Mount, known[previous.SHA256])
			if err != nil {
				return received, err
			}
			previous.Filename = filepath.ToSlash(relative)
			cache.Cloud[remote] = previous
			receipts[remote] = previous
			processed++
			continue
		}
		a.progress("receiving_folder_books", processed, len(entries))
		temporary := filepath.Join(a.Scratch, "folder-book-"+sha([]byte(remote)))
		digest := providerKnown[identity]
		var digests map[string]string
		if digest == "" {
			if _, err = a.run("copyto", "remote:"+remote, temporary, "--max-transfer", fmt.Sprint(maxFile), "--cutoff-mode", "HARD"); err != nil {
				return received, err
			}
			info, err := os.Stat(temporary)
			if err != nil || info.Size() != entry.Size {
				return received, errors.New("cloud book size changed during download")
			}
			digests, err = bookDigests(temporary)
			if err != nil {
				return received, err
			}
			if err = verifyCloudBookHashes(digests, entry); err != nil {
				return received, err
			}
			digest = digests["sha256"]
		}
		target := known[digest]
		if target == "" {
			target = filepath.Join(a.Config.Mount, "Books", "Inbox", digest[:12]+"-"+path.Base(entry.Path))
			if err = ensureBookInbox(a.Config.Mount); err != nil {
				return received, err
			}
			if _, err = os.Lstat(target); err == nil {
				return received, errors.New("existing book differs; original preserved")
			} else if !os.IsNotExist(err) {
				return received, err
			}
			if err = os.Rename(temporary, target); err != nil {
				return received, err
			}
			actual, err := hashFile(target)
			if err != nil || actual != digest {
				return received, errors.New("folder book readback verification failed")
			}
			received++
			known[digest] = target
		}
		os.Remove(temporary)
		relative, err := filepath.Rel(a.Config.Mount, target)
		if err != nil {
			return received, err
		}
		info, err := os.Stat(target)
		if err != nil {
			return received, err
		}
		if digests == nil {
			digests = map[string]string{"sha256": cache.Local[relative].SHA256, "md5": cache.Local[relative].MD5, "sha1": cache.Local[relative].SHA1}
		}
		cache.Local[relative] = LocalBook{info.Size(), info.ModTime().UnixNano(), digest, digests["md5"], digests["sha1"]}
		for algorithm, value := range digests {
			providerKnown[fmt.Sprintf("%s:%s:%d", algorithm, value, info.Size())] = digest
		}
		item := CloudBook{sha(version), digest, filepath.ToSlash(relative)}
		cache.Cloud[remote], receipts[remote] = item, item
		processed++
		if err = atomicJSON(filename, cache); err != nil {
			return received, err
		}
	}
	payload, _ := json.Marshal(map[string]any{"version": 1, "deviceId": a.Config.DeviceID, "folder": folder, "books": receipts})
	cache.Cloud = receipts
	if cache.Published != sha(payload) {
		if err = a.write(a.Config.RemoteRoot+"/devices/"+a.Config.DeviceID+"/folder-receipts.json", payload); err != nil {
			return received, err
		}
		cache.Published = sha(payload)
	}
	return received, atomicJSON(filename, cache)
}
