package main

import (
 "os"
 "path/filepath"
 "testing"
)

func TestAnnotationEditionAndPaths(t *testing.T) {
 mount := t.TempDir()
 if err := os.MkdirAll(filepath.Join(mount, "Books", "Book.sdr"), 0700); err != nil { t.Fatal(err) }
 content := []byte("original bytes")
 os.WriteFile(filepath.Join(mount, "Books", "Book.epub"), content, 0600)
 os.WriteFile(filepath.Join(mount, "Books", "Book.sdr", "metadata.epub.lua"), []byte("return {}"), 0600)
 id := "11111111-1111-4111-8111-111111111111"
 a := Agent{Config: Config{Mount: mount, DeviceID: id}}
 job := AnnotationJob{Version: 1, JobID: id, DeviceID: id, NoteID: sha([]byte("note")), BookHash: sha(content), BookRelative: "Books/Book.epub", Relative: "Books/Book.sdr/metadata.epub.lua", Operation: "edit"}
 if err := a.prepareAnnotation(&job); err != nil { t.Fatal(err) }
 if job.BookSize != int64(len(content)) || job.BookModified == 0 { t.Fatal("missing validated edition metadata") }
 job.BookHash = sha([]byte("wrong edition"))
 if a.prepareAnnotation(&job) == nil { t.Fatal("accepted another edition") }
 for _, relative := range []string{"Books/../secrets", "Books/./Book.epub", "kindlespouse/config.json", "Books\\Book.epub", "/Books/Book.epub"} {
  if _, err := localAnnotationPath(mount, relative); err == nil { t.Fatalf("accepted %s", relative) }
 }
}
