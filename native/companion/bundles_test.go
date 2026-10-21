package main

import (
	"archive/zip"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestBundlesAreDeterministicAndPreserveHashes(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "original")
	content := []byte("Fixture notebook with private handwriting")
	if err := os.WriteFile(source, content, 0600); err != nil {
		t.Fatal(err)
	}
	hash := sha(content)
	objects := map[string]string{hash: source}
	agent := Agent{Directory: root}
	var previous Bundle
	for index := 0; index < 2; index++ {
		directory := filepath.Join(root, string(rune('a'+index)))
		os.Mkdir(directory, 0700)
		bundle, err := agent.makeBundle(directory, []string{hash}, objects)
		if err != nil {
			t.Fatal(err)
		}
		if index > 0 && previous.SHA256 != bundle.SHA256 {
			t.Fatal("identical objects changed bundle identity")
		}
		previous = bundle
		file := filepath.Join(directory, bundle.SHA256+".zip")
		archive, err := zip.OpenReader(file)
		if err != nil {
			t.Fatal(err)
		}
		if len(archive.File) != 1 || archive.File[0].Name != hash {
			t.Fatal("invalid bundle contents")
		}
		entry, err := archive.File[0].Open()
		if err != nil {
			t.Fatal(err)
		}
		restored, err := io.ReadAll(entry)
		entry.Close()
		archive.Close()
		if err != nil || sha(restored) != hash {
			t.Fatal("bundle modified an original")
		}
	}
	os.WriteFile(filepath.Join(root, "pause.requested"), []byte("paused"), 0600)
	if _, err := agent.makeBundle(root, []string{hash}, objects); !errors.Is(err, errPaused) {
		t.Fatalf("pause returned %v", err)
	}
}

func TestRcloneStatsAcceptChunkedJsonWithoutExposingLogs(t *testing.T) {
	var updates []TransferStats
	writer := statsWriter{update: func(value TransferStats) { updates = append(updates, value) }}
	writer.Write([]byte("{\"msg\":\"unrelated\"}\n{\"stats\":{\"bytes\":"))
	writer.Write([]byte("1024,\"totalBytes\":4096,\"speed\":512,\"transfers\":1}}\ninvalid\n"))
	if len(updates) != 1 || updates[0].Bytes != 1024 || updates[0].TotalBytes != 4096 || updates[0].Transfers != 1 {
		t.Fatalf("invalid progress: %+v", updates)
	}
}
