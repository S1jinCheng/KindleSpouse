package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"time"
)

type SleepProfile struct {
	Version     int             `json:"version"`
	Revision    string          `json:"revision"`
	Enabled     bool            `json:"enabled"`
	DisplayName string          `json:"displayName"`
	Avatar      string          `json:"avatar"`
	AvatarHash  string          `json:"avatarHash,omitempty"`
	Clouds      []ProfileCloud  `json:"clouds"`
	Reading     *ProfileReading `json:"reading,omitempty"`
}

type ProfileReading struct {
	AsOf         string              `json:"asOf"`
	TotalSeconds float64             `json:"totalSeconds"`
	TodaySeconds float64             `json:"todaySeconds"`
	ReadingDays  int                 `json:"readingDays"`
	BookCount    int                 `json:"bookCount"`
	Days         []ProfileReadingDay `json:"days"`
}

type ProfileReadingDay struct {
	Date    string  `json:"date"`
	Seconds float64 `json:"seconds"`
}

func validProfileReading(reading *ProfileReading) bool {
	if reading == nil {
		return true
	}
	asOf, err := time.Parse("2006-01-02", reading.AsOf)
	if err != nil || len(reading.Days) > 366 || reading.ReadingDays < len(reading.Days) || reading.ReadingDays > 1000000 || reading.BookCount < 0 || reading.BookCount > 1000000 {
		return false
	}
	for _, seconds := range []float64{reading.TotalSeconds, reading.TodaySeconds} {
		if math.IsNaN(seconds) || math.IsInf(seconds, 0) || seconds < 0 || seconds > 1e12 {
			return false
		}
	}
	seen := map[string]bool{}
	total, today := 0.0, 0.0
	for _, day := range reading.Days {
		date, err := time.Parse("2006-01-02", day.Date)
		if err != nil || date.After(asOf) || date.Before(asOf.AddDate(0, 0, -365)) || seen[day.Date] || math.IsNaN(day.Seconds) || math.IsInf(day.Seconds, 0) || day.Seconds <= 0 || day.Seconds > 1e9 {
			return false
		}
		seen[day.Date] = true
		total += day.Seconds
		if day.Date == reading.AsOf {
			today = day.Seconds
		}
	}
	return total <= reading.TotalSeconds+0.01 && math.Abs(today-reading.TodaySeconds) < 0.01
}

type ProfileCloud struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	Connected bool   `json:"connected"`
}

func validProfileClouds(clouds []ProfileCloud) bool {
	if len(clouds) > 20 {
		return false
	}
	seen := map[string]bool{}
	for _, cloud := range clouds {
		if len(cloud.ID) == 0 || len(cloud.ID) > 100 || len(cloud.Name) > 240 || cloud.Provider != "drive" && cloud.Provider != "onedrive" || seen[cloud.ID] {
			return false
		}
		seen[cloud.ID] = true
	}
	return true
}

type ProfileReceipt struct {
	Version        int    `json:"version"`
	ProfileVersion int    `json:"profileVersion"`
	DeviceID       string `json:"deviceId"`
	Revision       string `json:"revision"`
	AvatarHash     string `json:"avatarHash,omitempty"`
	ReceivedAt     string `json:"receivedAt"`
}

func validAvatar(data []byte, hash string) bool {
	if len(data) > 512*1024 || sha(data) != hash {
		return false
	}
	config, err := png.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width < 1 || config.Width > 512 || config.Width != config.Height {
		return false
	}
	_, err = png.Decode(bytes.NewReader(data))
	return err == nil
}

func (a *Agent) saveSleepProfile(profile SleepProfile, avatar []byte) error {
	if profile.Version != 1 || !fingerprint.MatchString(profile.Revision) || len(profile.DisplayName) > 240 || len(profile.Avatar) > 32 || profile.AvatarHash != "" && !fingerprint.MatchString(profile.AvatarHash) || !validProfileClouds(profile.Clouds) || !validProfileReading(profile.Reading) {
		return errors.New("invalid sleep profile")
	}
	if profile.AvatarHash != "" {
		if !validAvatar(avatar, profile.AvatarHash) {
			return errors.New("avatar verification failed")
		}
		folder := filepath.Join(a.Directory, "avatars")
		if err := os.MkdirAll(folder, 0700); err != nil {
			return err
		}
		filename := filepath.Join(folder, profile.AvatarHash+".png")
		if previous, _ := os.ReadFile(filename); !validAvatar(previous, profile.AvatarHash) {
			if err := os.WriteFile(filename+".partial", avatar, 0600); err != nil {
				return err
			}
			if err := os.Rename(filename+".partial", filename); err != nil {
				return err
			}
		}
	}
	return atomicJSON(filepath.Join(a.Directory, "sleep-profile.json"), profile)
}

func (a *Agent) sleepSettings(base string, entries []RemoteEntry) error {
	found := false
	for _, entry := range entries {
		if entry.Name == "device-settings.json" && !entry.IsDir {
			found = true
		}
	}
	if !found {
		return nil
	}
	data, err := a.read(base+"/device-settings.json", 65536)
	if err != nil {
		return err
	}
	var profile SleepProfile
	if json.Unmarshal(data, &profile) != nil || profile.Version != 1 || !fingerprint.MatchString(profile.Revision) || len(profile.DisplayName) > 240 || len(profile.Avatar) > 32 || profile.AvatarHash != "" && !fingerprint.MatchString(profile.AvatarHash) {
		return errors.New("invalid sleep profile")
	}
	var avatar []byte
	if profile.AvatarHash != "" {
		avatar, _ = os.ReadFile(filepath.Join(a.Directory, "avatars", profile.AvatarHash+".png"))
		if !validAvatar(avatar, profile.AvatarHash) {
			avatar, err = a.read(a.Config.RemoteRoot+"/avatars/"+profile.AvatarHash+".png", 512*1024)
			if err != nil {
				return err
			}
		}
	}
	if err = a.saveSleepProfile(profile, avatar); err != nil {
		return err
	}
	filename := filepath.Join(a.Directory, "profile-receipt.json")
	previous, _ := os.ReadFile(filename)
	var receipt ProfileReceipt
	if json.Unmarshal(previous, &receipt) == nil && receipt.Revision == profile.Revision && receipt.ProfileVersion == 2 && receipt.DeviceID == a.Config.DeviceID && receipt.AvatarHash == profile.AvatarHash {
		return nil
	}
	receipt = ProfileReceipt{Version: 1, ProfileVersion: 2, DeviceID: a.Config.DeviceID, Revision: profile.Revision, AvatarHash: profile.AvatarHash, ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	data, err = json.Marshal(receipt)
	if err != nil {
		return err
	}
	if err = a.write(base+"/profile-receipt.json", data); err != nil {
		return err
	}
	return atomicJSON(filename, receipt)
}

func (a *Agent) receiveSleepSettings() error {
	a.progress("receiving_profile", 0, 0)
	base := a.Config.RemoteRoot + "/devices/" + a.Config.DeviceID
	data, err := a.run("lsjson", "remote:"+base, "--max-depth", "1")
	if err != nil {
		var missing *cloudCommandError
		if errors.As(err, &missing) && missing.exitCode == 3 {
			return nil
		}
		return err
	}
	var entries []RemoteEntry
	if json.Unmarshal(data, &entries) != nil || len(entries) > 20000 {
		return errors.New("invalid device directories")
	}
	return a.sleepSettings(base, entries)
}
