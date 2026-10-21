package main

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLANProfilePinAndTokenProtectWorkingProfile(t *testing.T) {
	for _, scenario := range []string{"valid", "wrong-pin", "wrong-token", "corrupt-avatar", "confirmation-fails"} {
		t.Run(scenario, func(t *testing.T) {
			directory := t.TempDir()
			deviceID := "155a4717-fce2-4be0-8061-b327e94a424d"
			previous := SleepProfile{Version: 1, Revision: sha([]byte("previous")), DisplayName: "Original", Avatar: "O"}
			agent := Agent{Config: Config{DeviceID: deviceID}, Directory: directory, Context: context.Background()}
			if err := agent.saveSleepProfile(previous, nil); err != nil {
				t.Fatal(err)
			}
			profile := SleepProfile{Version: 1, Revision: sha([]byte("next")), DisplayName: "Updated", Avatar: "U", Enabled: true}
			if scenario == "corrupt-avatar" {
				profile.AvatarHash = sha([]byte("not PNG"))
			}
			received := false
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("a", 64) {
					w.WriteHeader(401)
					return
				}
				if r.Method == "POST" {
					if scenario == "confirmation-fails" {
						w.WriteHeader(409)
						return
					}
					received = true
					w.Write([]byte(`{"ok":true}`))
					return
				}
				json.NewEncoder(w).Encode(map[string]any{"version": 1, "deviceId": deviceID, "profile": profile, "avatar": "bm90IFBORw=="})
			}))
			defer server.Close()
			certificate, err := x509.ParseCertificate(server.TLS.Certificates[0].Certificate[0])
			if err != nil {
				t.Fatal(err)
			}
			config := LANProfileConfig{Version: 1, DeviceID: deviceID, URLs: []string{server.URL}, CertificateSHA256: sha(certificate.Raw), Token: strings.Repeat("a", 64)}
			if scenario == "wrong-pin" {
				config.CertificateSHA256 = strings.Repeat("0", 64)
			}
			if scenario == "wrong-token" {
				config.Token = strings.Repeat("b", 64)
			}
			atomicJSON(filepath.Join(directory, "lan.json"), config)
			accepted, syncErr := agent.receiveLANProfile()
			var saved SleepProfile
			bytes, _ := os.ReadFile(filepath.Join(directory, "sleep-profile.json"))
			json.Unmarshal(bytes, &saved)
			if scenario == "valid" {
				if !accepted || syncErr != nil || !received || saved.Revision != profile.Revision {
					t.Fatal("valid profile failed")
				}
			} else if scenario == "confirmation-fails" {
				if !accepted || syncErr == nil || saved.Revision != profile.Revision {
					t.Fatal("failed receipt must preserve received profile and prevent cloud rollback")
				}
			} else if accepted || syncErr != nil || saved.Revision != previous.Revision {
				t.Fatal("untrusted local source replaced working profile")
			}
		})
	}
}

func TestLANConnectionFailureIsBoundedAndPublicHostsAreRejected(t *testing.T) {
	for _, url := range []string{"http://192.168.1.2:8080", "https://example.com:443", "https://8.8.8.8:443", "https://user@10.0.0.1:443", "https://10.0.0.1:443/path"} {
		if validLANURL(url) {
			t.Fatalf("accepted unsafe endpoint %s", url)
		}
	}
	for _, url := range []string{"https://192.168.1.2:41943", "https://10.0.0.1:41943", "https://127.0.0.1:41943"} {
		if !validLANURL(url) {
			t.Fatal("private endpoint rejected")
		}
	}
	directory := t.TempDir()
	id := "155a4717-fce2-4be0-8061-b327e94a424d"
	atomicJSON(filepath.Join(directory, "lan.json"), LANProfileConfig{Version: 1, DeviceID: id, URLs: []string{"https://127.0.0.1:1"}, CertificateSHA256: strings.Repeat("a", 64), Token: strings.Repeat("b", 64)})
	agent := Agent{Config: Config{DeviceID: id}, Directory: directory, Context: context.Background()}
	started := time.Now()
	accepted, err := agent.receiveLANProfile()
	if accepted || err != nil || time.Since(started) > 7*time.Second {
		t.Fatal("local fallback was not bounded")
	}
}
