package main

import (
	"encoding/json"
	"errors"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"time"
)

func (a *Agent) publishInstallationReceipt() error {
	filename := filepath.Join(a.Directory, "component-manifest.json")
	info, err := os.Stat(filename)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil || info.Size() > 2097152 {
		return errors.New("cannot read installation metadata")
	}
	data, err := os.ReadFile(filename)
	if err != nil {
		return err
	}
	var component struct {
		Version        int    `json:"version"`
		Protocol       int    `json:"protocol"`
		Revision       string `json:"revision"`
		InstallationID string `json:"installationId"`
	}
	if json.Unmarshal(data, &component) != nil || component.Version != 1 || component.Protocol != 1 {
		return errors.New("unsupported installation protocol")
	}
	if component.InstallationID == "" {
		return nil
	}
	if !regexp.MustCompile(`^[a-f0-9-]{36}$`).MatchString(component.InstallationID) || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(component.Revision) {
		return errors.New("invalid installation identity")
	}
	marker := filepath.Join(a.Directory, "installation-receipt-published.json")
	if previous, err := os.ReadFile(marker); err == nil {
		var saved struct {
			DeviceID       string `json:"deviceId"`
			InstallationID string `json:"installationId"`
			Revision       string `json:"revision"`
		}
		if json.Unmarshal(previous, &saved) == nil && saved.DeviceID == a.Config.DeviceID && saved.InstallationID == component.InstallationID && saved.Revision == component.Revision {
			return nil
		}
	}
	receipt, err := json.Marshal(map[string]any{"version": 1, "protocol": component.Protocol, "deviceId": a.Config.DeviceID, "installationId": component.InstallationID, "revision": component.Revision, "checkedAt": time.Now().UTC().Format(time.RFC3339Nano)})
	if err != nil {
		return err
	}
	if err = a.write(path.Join(a.Config.RemoteRoot, "devices", a.Config.DeviceID, "installation-receipt.json"), receipt); err != nil {
		return err
	}
	return os.WriteFile(marker, receipt, 0600)
}
