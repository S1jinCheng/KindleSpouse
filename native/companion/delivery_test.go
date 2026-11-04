package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestFirstReceiptSurvivesALaterDownloadFailure(t *testing.T) {
	root := t.TempDir()
	t.Setenv("KS_FOLDER_RCLONE_HELPER", root)
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	settings, mount := filepath.Join(root, "settings"), filepath.Join(root, "device")
	for _, folder := range []string{settings, mount, filepath.Join(root, "KindleSpouse/Sync/outbox"), filepath.Join(root, "KindleSpouse/Inbox")} {
		if err := os.MkdirAll(folder, 0700); err != nil {
			t.Fatal(err)
		}
	}
	put := func(filename string, value any) {
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filename, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	first := "00000000-0000-4000-8000-000000000001"
	second := "00000000-0000-4000-8000-000000000002"
	device := "00000000-0000-4000-8000-000000000003"
	body := []byte("Synthetic verified document")
	if err := os.WriteFile(filepath.Join(root, "KindleSpouse/Inbox/first.txt"), body, 0600); err != nil {
		t.Fatal(err)
	}
	put(filepath.Join(root, "listing.json"), []RemoteEntry{{Name: first + ".json"}, {Name: second + ".json"}})
	for _, id := range []string{first, second} {
		remote := "KindleSpouse/Inbox/first.txt"
		if id == second {
			remote = "KindleSpouse/Inbox/unavailable.txt"
		}
		put(filepath.Join(root, "KindleSpouse/Sync/outbox", id+".json"), Book{Version: 1, JobID: id, SHA256: sha(body), Bytes: int64(len(body)), Filename: id + ".txt", RemotePath: remote})
	}
	agent := Agent{Directory: settings, Scratch: t.TempDir(), Context: context.Background(), Config: Config{Version: 1, DeviceID: device, RemoteRoot: "KindleSpouse/Sync", Mount: mount, Rclone: binary}}
	agent.Progress = Progress{State: "running", Stage: "uploading_bundles", Done: 2, Total: 6, Received: 2}
	agent.bookCheckAt = time.Now().Add(-time.Minute)
	err = agent.yieldBooks(time.Now())
	count := agent.Progress.Received - 2
	if agent.Progress.Stage != "uploading_bundles" || agent.Progress.Done != 2 || agent.Progress.Total != 6 {
		t.Fatal("book priority discarded backup progress")
	}
	if err == nil || count != 1 {
		t.Fatalf("expected one verified delivery followed by failure, got %d %v", count, err)
	}
	data, err := os.ReadFile(filepath.Join(root, "KindleSpouse/Sync/devices", device, "receipts.json"))
	if err != nil {
		t.Fatal("first book receipt was not published before the later failure", err)
	}
	var receipts Receipts
	if json.Unmarshal(data, &receipts) != nil || len(receipts.Books) != 1 || receipts.Books[0].JobID != first || receipts.Books[0].SHA256 != sha(body) {
		t.Fatal("receipt does not identify the verified book")
	}
	downloaded := filepath.Join(mount, "Books/Inbox", sha(body)[:12]+"-"+first+".txt")
	if hash, err := hashFile(downloaded); err != nil || hash != sha(body) {
		t.Fatal("verified first book was not preserved")
	}
}
