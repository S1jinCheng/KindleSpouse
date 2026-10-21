package main

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const bundleTarget = 16 * 1024 * 1024
const maxBundle = maxFile + 1024*1024

type Bundle struct {
	SHA256  string   `json:"sha256"`
	Bytes   int64    `json:"bytes"`
	Objects []string `json:"objects"`
}

type TransferStats struct {
	Transfers  int     `json:"transfers"`
	Bytes      int64   `json:"bytes"`
	TotalBytes int64   `json:"totalBytes"`
	Speed      float64 `json:"speed"`
}

type statsWriter struct {
	buffer []byte
	update func(TransferStats)
}

func (w *statsWriter) Write(data []byte) (int, error) {
	length := len(data)
	w.buffer = append(w.buffer, data...)
	for {
		index := bytes.IndexByte(w.buffer, '\n')
		if index < 0 {
			break
		}
		var message struct {
			Stats *TransferStats `json:"stats"`
		}
		if json.Unmarshal(w.buffer[:index], &message) == nil && message.Stats != nil {
			w.update(*message.Stats)
		}
		w.buffer = w.buffer[index+1:]
	}
	if len(w.buffer) > 256*1024 {
		w.buffer = nil
	}
	return length, nil
}

func validBundle(bundle Bundle) bool {
	if !fingerprint.MatchString(bundle.SHA256) || bundle.Bytes < 1 || bundle.Bytes > maxBundle || len(bundle.Objects) < 1 || len(bundle.Objects) > 20000 {
		return false
	}
	seen := map[string]bool{}
	for _, hash := range bundle.Objects {
		if !fingerprint.MatchString(hash) || seen[hash] {
			return false
		}
		seen[hash] = true
	}
	return true
}

func (a *Agent) makeBundle(directory string, hashes []string, objects map[string]string) (Bundle, error) {
	if a.paused() {
		return Bundle{}, errPaused
	}
	f, err := os.CreateTemp(directory, ".pack-*")
	if err != nil {
		return Bundle{}, err
	}
	defer os.Remove(f.Name())
	writer := zip.NewWriter(f)
	writer.RegisterCompressor(zip.Deflate, func(target io.Writer) (io.WriteCloser, error) { return flate.NewWriter(target, flate.BestSpeed) })
	for _, hash := range hashes {
		if a.paused() {
			writer.Close()
			f.Close()
			return Bundle{}, errPaused
		}
		entry, err := writer.CreateHeader(&zip.FileHeader{Name: hash, Method: zip.Deflate, Modified: time.Date(1980, 1, 1, 0, 0, 0, 0, time.UTC)})
		if err != nil {
			writer.Close()
			f.Close()
			return Bundle{}, err
		}
		source, err := os.Open(objects[hash])
		if err != nil {
			writer.Close()
			f.Close()
			return Bundle{}, err
		}
		_, err = io.Copy(entry, source)
		source.Close()
		if err != nil {
			writer.Close()
			f.Close()
			return Bundle{}, err
		}
	}
	if err := writer.Close(); err != nil {
		f.Close()
		return Bundle{}, err
	}
	if err := f.Close(); err != nil {
		return Bundle{}, err
	}
	info, err := os.Stat(f.Name())
	if err != nil || info.Size() > maxBundle {
		return Bundle{}, errors.New("compressed changes exceed bundle limit")
	}
	hash, err := hashFileUnlimited(f.Name())
	if err != nil {
		return Bundle{}, err
	}
	if err := os.Rename(f.Name(), filepath.Join(directory, hash+".zip")); err != nil {
		return Bundle{}, err
	}
	return Bundle{SHA256: hash, Bytes: info.Size(), Objects: append([]string{}, hashes...)}, nil
}

func (a *Agent) uploadBundles(objects map[string]string, known map[string]int64) ([]Bundle, error) {
	ledgerFile := filepath.Join(a.Directory, "bundle-index.json")
	ledger := []Bundle{}
	if info, err := os.Stat(ledgerFile); err == nil && info.Size() <= 16*1024*1024 {
		data, _ := os.ReadFile(ledgerFile)
		json.Unmarshal(data, &ledger)
	}
	if a.BundleSizes == nil {
		a.BundleSizes = map[string]int64{}
		if len(ledger) > 0 {
			out, err := a.run("lsjson", "remote:"+a.Config.RemoteRoot+"/bundles", "--files-only", "--max-depth", "1")
			if err != nil {
				if errors.Is(err, errPaused) {
					return nil, err
				}
				if _, createErr := a.run("mkdir", "remote:"+a.Config.RemoteRoot+"/bundles"); createErr != nil {
					return nil, createErr
				}
				out, err = a.run("lsjson", "remote:"+a.Config.RemoteRoot+"/bundles", "--files-only", "--max-depth", "1")
				if err != nil {
					return nil, err
				}
			}
			var entries []RemoteEntry
			if json.Unmarshal(out, &entries) != nil {
				return nil, errors.New("invalid bundle listing")
			}
			for _, entry := range entries {
				a.BundleSizes[entry.Name] = entry.Size
			}
		}
	}
	needed := map[string]bool{}
	for hash, filename := range objects {
		info, err := os.Stat(filename)
		if err != nil {
			return nil, err
		}
		if size, ok := known[hash]; !ok || size != info.Size() {
			needed[hash] = true
		}
	}
	used := []Bundle{}
	validLedger := []Bundle{}
	seenBundles := map[string]bool{}
	for _, bundle := range ledger {
		if !validBundle(bundle) || seenBundles[bundle.SHA256] {
			continue
		}
		seenBundles[bundle.SHA256] = true
		validLedger = append(validLedger, bundle)
		if size, ok := a.BundleSizes[bundle.SHA256+".zip"]; !ok || size != bundle.Bytes {
			continue
		}
		relevant := false
		for _, hash := range bundle.Objects {
			if needed[hash] {
				relevant = true
				delete(needed, hash)
			}
		}
		if relevant {
			used = append(used, bundle)
		}
	}
	hashes := []string{}
	for hash := range needed {
		hashes = append(hashes, hash)
	}
	sort.Strings(hashes)
	if len(hashes) == 0 {
		return used, nil
	}
	directory := filepath.Join(a.Scratch, "bundles")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	created := []Bundle{}
	group := []string{}
	var size int64
	flush := func() error {
		if len(group) == 0 {
			return nil
		}
		bundle, err := a.makeBundle(directory, group, objects)
		if err != nil {
			return err
		}
		created = append(created, bundle)
		group, size = nil, 0
		return nil
	}
	a.progress("packing_notes", 0, len(hashes))
	for index, hash := range hashes {
		info, err := os.Stat(objects[hash])
		if err != nil {
			return nil, err
		}
		if len(group) > 0 && size+info.Size() > bundleTarget {
			if err := flush(); err != nil {
				return nil, err
			}
		}
		group = append(group, hash)
		size += info.Size()
		a.progress("packing_notes", index+1, len(hashes))
	}
	if err := flush(); err != nil {
		return nil, err
	}
	if err := atomicJSON(ledgerFile, append(validLedger, created...)); err != nil {
		return nil, err
	}
	names := []string{}
	for _, bundle := range created {
		names = append(names, bundle.SHA256+".zip")
	}
	list := filepath.Join(a.Scratch, "bundle-files.txt")
	if err := os.WriteFile(list, []byte(strings.Join(names, "\n")+"\n"), 0600); err != nil {
		return nil, err
	}
	a.progress("uploading_bundles", 0, len(created))
	if _, err := a.runCommand("uploading_bundles", len(created), "copy", directory, "remote:"+a.Config.RemoteRoot+"/bundles", "--files-from-raw", list, "--immutable", "--transfers", "2", "--checkers", "2", "--buffer-size", "256k", "--multi-thread-streams", "0"); err != nil {
		return nil, err
	}
	for _, bundle := range created {
		a.BundleSizes[bundle.SHA256+".zip"] = bundle.Bytes
	}
	a.progress("uploading_bundles", len(created), len(created))
	return append(used, created...), nil
}
