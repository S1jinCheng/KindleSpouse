package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func init() {
	root := os.Getenv("KS_FOLDER_RCLONE_HELPER")
	if root == "" {
		return
	}
	args := os.Args[1:]
	if len(args) < 2 {
		os.Exit(1)
	}
	if args[0] == "lsjson" {
		data, err := os.ReadFile(filepath.Join(root, "listing.json"))
		if err != nil {
			os.Exit(1)
		}
		os.Stdout.Write(data)
		os.Exit(0)
	}
	if args[0] != "copyto" || len(args) < 3 {
		os.Exit(1)
	}
	source, destination := args[1], args[2]
	if strings.HasPrefix(source, "remote:") {
		relative := strings.TrimPrefix(source, "remote:")
		if strings.HasSuffix(relative, ".epub") {
			log, err := os.OpenFile(filepath.Join(root, "downloads"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
			if err != nil {
				os.Exit(1)
			}
			log.WriteString(relative + "\n")
			log.Close()
		}
		source = filepath.Join(root, filepath.FromSlash(relative))
	}
	if strings.HasPrefix(destination, "remote:") {
		destination = filepath.Join(root, filepath.FromSlash(strings.TrimPrefix(destination, "remote:")))
	}
	data, err := os.ReadFile(source)
	if err != nil {
		os.Exit(4)
	}
	if os.MkdirAll(filepath.Dir(destination), 0700) != nil || os.WriteFile(destination, data, 0600) != nil {
		os.Exit(1)
	}
	os.Exit(0)
}

func TestBookFolderKeepsPrivateSyncDataSeparate(t *testing.T) {
	for _, folder := range []string{"", "KindleSpouse", "KindleSpouse/Sync", "KindleSpouse/Sync/objects", "../Inbox", "remote:Inbox"} {
		if _, err := bookFolderPath(folder, "KindleSpouse/Sync"); err == nil {
			t.Fatalf("accepted unsafe folder %q", folder)
		}
	}
	if _, err := bookFolderPath("KindleSpouse/Inbox", "KindleSpouse/Sync"); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{"../book.epub", "Book.sdr/cover.png", ".notebooks/page.png", "Folder/.cache/image.png", "notes.json", "program.exe"} {
		if folderBookPath(file) {
			t.Fatalf("accepted non-book asset %q", file)
		}
	}
	for _, file := range []string{"原著.epub", "作者/作品.mobi", "Folder/article.pdf", "Comics/volume.cbz"} {
		if !folderBookPath(file) {
			t.Fatalf("rejected book %q", file)
		}
	}
}

func TestFolderSkipsExistingContentAndTransfersOnlyMissingOrChangedBooks(t *testing.T) {
	root := t.TempDir()
	t.Setenv("KS_FOLDER_RCLONE_HELPER", root)
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	mount, settings := filepath.Join(root, "device"), filepath.Join(root, "settings")
	for _, directory := range []string{filepath.Join(mount, "Books", "Library"), settings, filepath.Join(root, "KindleSpouse", "Sync"), filepath.Join(root, "KindleSpouse", "Inbox")} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := atomicJSON(filepath.Join(root, "KindleSpouse", "Sync", "book-folder.json"), map[string]any{"version": 1, "folder": "KindleSpouse/Inbox"}); err != nil {
		t.Fatal(err)
	}
	book := []byte("A fixture book already on Kindle under another filename")
	existing := filepath.Join(mount, "Books", "Library", "Different name.epub")
	if err := os.WriteFile(existing, book, 0600); err != nil {
		t.Fatal(err)
	}
	remoteBook := filepath.Join(root, "KindleSpouse", "Inbox", "Original.epub")
	setBook := func(bytes []byte, expected string) {
		t.Helper()
		if err := os.WriteFile(remoteBook, bytes, 0600); err != nil {
			t.Fatal(err)
		}
		digests, err := bookDigests(remoteBook)
		if err != nil {
			t.Fatal(err)
		}
		if expected != "" {
			digests["md5"] = expected
		}
		entry := FolderBook{Path: "Original.epub", Size: int64(len(bytes)), ModTime: "fixed timestamp", Hashes: map[string]string{"MD5": digests["md5"]}}
		if err := atomicJSON(filepath.Join(root, "listing.json"), []FolderBook{entry}); err != nil {
			t.Fatal(err)
		}
	}
	setBook(book, "")
	agent := Agent{Config: Config{DeviceID: "72726486-01ad-4d46-a410-f0e6dc99cc54", RemoteRoot: "KindleSpouse/Sync", Mount: mount, Rclone: binary}, Directory: settings, Scratch: settings, Context: context.Background()}
	if count, err := agent.receiveBookFolder(); err != nil || count != 0 {
		t.Fatalf("existing content: %d, %v", count, err)
	}
	if _, err := os.Stat(filepath.Join(root, "downloads")); !os.IsNotExist(err) {
		t.Fatal("downloaded an existing book just because its filename differs")
	}
	if err := os.Remove(existing); err != nil {
		t.Fatal(err)
	}
	if count, err := agent.receiveBookFolder(); err != nil || count != 1 {
		t.Fatalf("missing content: %d, %v", count, err)
	}
	if count, err := agent.receiveBookFolder(); err != nil || count != 0 {
		t.Fatalf("unchanged folder: %d, %v", count, err)
	}
	data, _ := os.ReadFile(filepath.Join(root, "downloads"))
	if len(strings.Fields(string(data))) != 1 {
		t.Fatal("downloaded unchanged cloud content again")
	}
	updated := []byte("An updated edition with different content")
	setBook(updated, "")
	if count, err := agent.receiveBookFolder(); err != nil || count != 1 {
		t.Fatalf("updated content: %d, %v", count, err)
	}
	for _, bytes := range [][]byte{book, updated} {
		filename := filepath.Join(mount, "Books", "Inbox", sha(bytes)[:12]+"-Original.epub")
		data, err := os.ReadFile(filename)
		if err != nil || string(data) != string(bytes) {
			t.Fatal("lost or changed an original book")
		}
	}
	setBook([]byte("Changed during download"), strings.Repeat("0", 32))
	if _, err := agent.receiveBookFolder(); err == nil {
		t.Fatal("accepted bytes that differ from the listed cloud checksum")
	}
}
