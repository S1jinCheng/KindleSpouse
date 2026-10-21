package localidentity

import (
	"bytes"
	"crypto/tls"
	"os"
	"path/filepath"
	"testing"
)

func TestIdentityPersistsAndBrokenIdentityIsNotSilentlyReplaced(t *testing.T) {
	directory := t.TempDir()
	if err := Create(directory); err != nil {
		t.Fatal(err)
	}
	cert, key := filepath.Join(directory, "certificate.pem"), filepath.Join(directory, "private-key.pem")
	before, _ := os.ReadFile(key)
	if _, err := tls.LoadX509KeyPair(cert, key); err != nil {
		t.Fatal(err)
	}
	if err := Create(directory); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(key)
	if !bytes.Equal(before, after) {
		t.Fatal("identity changed across restart")
	}
	os.Remove(cert)
	if err := Create(directory); err == nil {
		t.Fatal("partial identity was silently replaced")
	}
}
