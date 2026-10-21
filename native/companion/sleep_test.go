package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProfileReadingPersistsAndInvalidUpdatesKeepPrevious(t *testing.T) {
	agent := Agent{Directory: t.TempDir()}
	reading := ProfileReading{AsOf: "2026-10-20", TotalSeconds: 7200.5, TodaySeconds: 2820, ReadingDays: 3, BookCount: 2,
		Days: []ProfileReadingDay{{Date: "2026-10-19", Seconds: 600.5}, {Date: "2026-10-20", Seconds: 2820}}}
	profile := SleepProfile{Version: 1, Revision: sha([]byte("reading")), DisplayName: "Reader", Reading: &reading}
	if err := agent.saveSleepProfile(profile, nil); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(agent.Directory, "sleep-profile.json")
	before, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	var saved SleepProfile
	if json.Unmarshal(before, &saved) != nil || saved.Reading == nil || saved.Reading.TotalSeconds != reading.TotalSeconds || len(saved.Reading.Days) != 2 {
		t.Fatal("reading snapshot was not persisted")
	}
	for _, mutate := range []func(*ProfileReading){
		func(r *ProfileReading) { r.AsOf = "2026-02-30" },
		func(r *ProfileReading) { r.TotalSeconds = math.NaN() },
		func(r *ProfileReading) { r.TotalSeconds = 1 },
		func(r *ProfileReading) { r.TodaySeconds = 1 },
		func(r *ProfileReading) { r.ReadingDays = -1 },
		func(r *ProfileReading) { r.BookCount = -1 },
		func(r *ProfileReading) { r.Days = append(r.Days, r.Days[0]) },
		func(r *ProfileReading) { r.Days[0].Date = "2026-10-21" },
		func(r *ProfileReading) { r.Days[0].Date = "2024-01-01" },
		func(r *ProfileReading) { r.Days[0].Seconds = -60 },
	} {
		bad := reading
		bad.Days = append([]ProfileReadingDay(nil), reading.Days...)
		mutate(&bad)
		profile.Reading = &bad
		if agent.saveSleepProfile(profile, nil) == nil {
			t.Fatal("invalid reading snapshot accepted")
		}
		after, _ := os.ReadFile(filename)
		if !bytes.Equal(before, after) {
			t.Fatal("invalid update replaced the previous profile")
		}
	}
	profile.Reading = &ProfileReading{AsOf: "2026-10-20", Days: []ProfileReadingDay{}}
	if err := agent.saveSleepProfile(profile, nil); err != nil {
		t.Fatal(err)
	}
	profile.Reading = nil
	if err := agent.saveSleepProfile(profile, nil); err != nil {
		t.Fatal(err)
	}
}

func TestProfileCloudMetadataPersistsAndInvalidUpdatesKeepPrevious(t *testing.T) {
	agent := Agent{Directory: t.TempDir()}
	profile := SleepProfile{Version: 1, Revision: sha([]byte("clouds")), DisplayName: "Reader", Clouds: []ProfileCloud{
		{ID: "primary", Name: "Reading library", Provider: "drive", Connected: true},
		{ID: "backup", Name: "Notebook backup", Provider: "onedrive", Connected: false},
	}}
	if err := agent.saveSleepProfile(profile, nil); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(agent.Directory, "sleep-profile.json")
	before, _ := os.ReadFile(filename)
	var saved SleepProfile
	if json.Unmarshal(before, &saved) != nil || len(saved.Clouds) != 2 || !saved.Clouds[0].Connected || saved.Clouds[1].Connected {
		t.Fatal("cloud connection metadata was lost")
	}
	for _, invalid := range [][]ProfileCloud{
		{{ID: "x", Provider: "unknown"}},
		{{ID: "x", Provider: "drive", Name: strings.Repeat("x", 241)}},
		{{ID: "x", Provider: "drive"}, {ID: "x", Provider: "onedrive"}},
		make([]ProfileCloud, 21),
	} {
		profile.Clouds = invalid
		if agent.saveSleepProfile(profile, nil) == nil {
			t.Fatal("invalid cloud update was accepted")
		}
		after, _ := os.ReadFile(filename)
		if !bytes.Equal(before, after) {
			t.Fatal("invalid cloud update replaced working profile")
		}
	}
	profile.Clouds = []ProfileCloud{}
	if err := agent.saveSleepProfile(profile, nil); err != nil {
		t.Fatal(err)
	}
	cleared, _ := os.ReadFile(filename)
	if !bytes.Contains(cleared, []byte(`"clouds":[]`)) {
		t.Fatal("removed clouds were retained")
	}
}

func TestPhotoProfileKeepsPreviousOnInvalidAvatarAndAllowsRemoval(t *testing.T) {
	agent := Agent{Directory: t.TempDir()}
	avatar := image.NewRGBA(image.Rect(0, 0, 32, 32))
	avatar.Set(0, 0, color.RGBA{R: 230, G: 80, B: 60, A: 255})
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, avatar); err != nil {
		t.Fatal(err)
	}
	data := buffer.Bytes()
	profile := SleepProfile{Version: 1, Revision: sha([]byte("first")), Enabled: true, DisplayName: "Reader", Avatar: "R", AvatarHash: sha(data)}
	if err := agent.saveSleepProfile(profile, data); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(agent.Directory, "sleep-profile.json")
	previous, _ := os.ReadFile(filename)
	if saved, err := os.ReadFile(filepath.Join(agent.Directory, "avatars", profile.AvatarHash+".png")); err != nil || !bytes.Equal(saved, data) {
		t.Fatal("photo was not saved intact")
	}
	profile.Revision = sha([]byte("second"))
	if err := agent.saveSleepProfile(profile, []byte("corrupted")); err == nil {
		t.Fatal("invalid photo was accepted")
	}
	if saved, _ := os.ReadFile(filename); !bytes.Equal(saved, previous) {
		t.Fatal("failed photo replaced working profile")
	}
	profile.AvatarHash = "../untrusted"
	if err := agent.saveSleepProfile(profile, data); err == nil {
		t.Fatal("avatar path traversal was accepted")
	}
	profile.AvatarHash = ""
	if err := agent.saveSleepProfile(profile, nil); err != nil {
		t.Fatal(err)
	}
	var saved SleepProfile
	current, _ := os.ReadFile(filename)
	if json.Unmarshal(current, &saved) != nil || saved.AvatarHash != "" || saved.Avatar != "R" {
		t.Fatal("photo removal failed")
	}
	oversized := image.NewGray(image.Rect(0, 0, 1024, 1024))
	buffer.Reset()
	png.Encode(&buffer, oversized)
	if validAvatar(buffer.Bytes(), sha(buffer.Bytes())) {
		t.Fatal("unbounded image dimensions accepted")
	}
}
