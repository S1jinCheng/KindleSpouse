package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

type BookJobEntry struct {
	Version  string `json:"version"`
	Book     Book   `json:"book"`
	Bytes    int64  `json:"bytes"`
	Modified int64  `json:"modified"`
}

type BookJobCache struct {
	DeviceID  string                  `json:"deviceId"`
	Root      string                  `json:"root"`
	Published string                  `json:"published"`
	Jobs      map[string]BookJobEntry `json:"jobs"`
}

func (a *Agent) loadBookJobs() BookJobCache {
	cache := BookJobCache{}
	if data, err := os.ReadFile(filepath.Join(a.Directory, "book-job-cache.json")); err == nil {
		json.Unmarshal(data, &cache)
	}
	if cache.DeviceID != a.Config.DeviceID || cache.Root != a.Config.RemoteRoot || cache.Jobs == nil {
		return BookJobCache{DeviceID: a.Config.DeviceID, Root: a.Config.RemoteRoot, Jobs: map[string]BookJobEntry{}}
	}
	return cache
}

func bookJobVersion(entry RemoteEntry) string {
	data, _ := json.Marshal(entry)
	return sha(data)
}

func (a *Agent) cachedBookJob(entry RemoteEntry, cache BookJobCache, received map[string]string) bool {
	item, ok := cache.Jobs[entry.Name]
	if !ok || entry.ModTime == "" || item.Version != bookJobVersion(entry) || !fingerprint.MatchString(item.Book.SHA256) || received[item.Book.JobID] != item.Book.SHA256 || filepath.Base(item.Book.Filename) != item.Book.Filename {
		return false
	}
	filename := filepath.Join(a.Config.Mount, "Books", "Inbox", item.Book.SHA256[:12]+"-"+item.Book.Filename)
	info, err := os.Lstat(filename)
	return err == nil && info.Mode().IsRegular() && info.Size() == item.Bytes && info.ModTime().UnixNano() == item.Modified
}

func (a *Agent) rememberBookJob(entry RemoteEntry, book Book, filename string, cache *BookJobCache) {
	if info, err := os.Lstat(filename); err == nil && info.Mode().IsRegular() {
		cache.Jobs[entry.Name] = BookJobEntry{bookJobVersion(entry), book, info.Size(), info.ModTime().UnixNano()}
	}
}
