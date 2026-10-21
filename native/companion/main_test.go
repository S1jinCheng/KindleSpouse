package main

import (
	"context"
	"errors"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func init() {
	if ready := os.Getenv("KS_PAUSE_TEST_READY"); ready != "" {
		os.WriteFile(ready, []byte("running"), 0600)
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
}

func TestPauseCancelsAnInflightCloudProcess(t *testing.T) {
	directory := t.TempDir()
	ready := filepath.Join(directory, "ready")
	t.Setenv("KS_PAUSE_TEST_READY", ready)
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	agent := Agent{Config: Config{Rclone: binary}, Directory: directory, Context: ctx}
	finished := make(chan error, 1)
	go func() { _, err := agent.run("copyto"); finished <- err }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cloud helper did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := os.WriteFile(filepath.Join(directory, "pause.requested"), []byte("paused"), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if !errors.Is(err, errPaused) {
			t.Fatalf("pause returned %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("pause did not stop the inflight process")
	}
}

func TestRemotePathsRemainInsideAccount(t *testing.T) {
	for _, value := range []string{"../secret", "folder/../secret", "folder/./secret", "/root", "remote:secret", "folder\\secret", "folder//secret", ""} {
		if _, err := safeRemote(value); err == nil {
			t.Fatalf("accepted invalid cloud path %q", value)
		}
	}
	for _, value := range []string{"KindleSpouse/Sync", "My files/阅读.epub"} {
		if _, err := safeRemote(value); err != nil {
			t.Fatalf("rejected valid path %q", value)
		}
	}
}

func TestReadingFormatsMatchNativeDocuments(t *testing.T) {
	for _, filename := range []string{"Original.MOBI", "Book.FB2.ZIP", "Book.docx", "Comic.cbz", "Page.djvu", "Reading.txt", "Book.htmlz", "Image.png"} {
		if !readableBookFilename(filename) {
			t.Fatalf("rejected readable document %q", filename)
		}
	}
	for _, filename := range []string{"program.exe", "script.sh", "script.py", "Book.kfx", "Book.azw3", "Book.mobi.partial"} {
		if readableBookFilename(filename) {
			t.Fatalf("accepted non-document %q", filename)
		}
	}
}

func TestStableSnapshotCopiesPreserveOriginals(t *testing.T) {
	directory := t.TempDir()
	source := filepath.Join(directory, "original")
	scratch := filepath.Join(directory, "scratch")
	os.Mkdir(scratch, 0700)
	original := []byte("Private note fixture")
	os.WriteFile(source, original, 0600)
	agent := Agent{Scratch: scratch}
	item, snapshot, err := agent.stableCopy(source, ".notebooks/one/nbk")
	if err != nil {
		t.Fatal(err)
	}
	if item.SHA256 != sha(original) || item.Bytes != int64(len(original)) {
		t.Fatal("snapshot identity mismatch")
	}
	bytes, _ := os.ReadFile(snapshot)
	if string(bytes) != string(original) {
		t.Fatal("snapshot bytes changed")
	}
	os.WriteFile(source, []byte("Later revision"), 0600)
	bytes, _ = os.ReadFile(snapshot)
	if string(bytes) != string(original) {
		t.Fatal("later changes modified the original snapshot")
	}
}

func TestAuthoredGoHasNoComments(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	for _, filename := range files {
		source, err := parser.ParseFile(token.NewFileSet(), filename, nil, parser.ParseComments)
		if err != nil {
			t.Fatal(err)
		}
		if len(source.Comments) != 0 {
			t.Fatalf("comments found in %s", filename)
		}
	}
}
