package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"time"
)

type LANProfileConfig struct {
	Version           int      `json:"version"`
	DeviceID          string   `json:"deviceId"`
	URLs              []string `json:"urls"`
	CertificateSHA256 string   `json:"certificateSha256"`
	Token             string   `json:"token"`
}

func validLANURL(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || u.Port() == "" {
		return false
	}
	ip := net.ParseIP(u.Hostname())
	return ip != nil && (ip.IsPrivate() || ip.IsLoopback())
}

func (a *Agent) receiveLANProfile() (bool, error) {
	data, err := os.ReadFile(filepath.Join(a.Directory, "lan.json"))
	if err != nil || len(data) > 8192 {
		return false, nil
	}
	var config LANProfileConfig
	if json.Unmarshal(data, &config) != nil || config.Version != 1 || config.DeviceID != a.Config.DeviceID || !fingerprint.MatchString(config.CertificateSHA256) || len(config.Token) != 64 || len(config.URLs) == 0 || len(config.URLs) > 8 {
		return false, nil
	}
	if _, err := hex.DecodeString(config.Token); err != nil {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(a.Context, 6*time.Second)
	defer cancel()
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 1500 * time.Millisecond}).DialContext, TLSHandshakeTimeout: 1500 * time.Millisecond, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true, VerifyConnection: func(state tls.ConnectionState) error {
		if len(state.PeerCertificates) == 0 || sha(state.PeerCertificates[0].Raw) != config.CertificateSHA256 {
			return errors.New("local computer identity mismatch")
		}
		return nil
	}}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 2500 * time.Millisecond, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return errors.New("local redirects are not allowed") }}
	a.progress("checking_local_profile", 0, 0)
	for _, base := range config.URLs {
		if a.paused() {
			return false, errPaused
		}
		if !validLANURL(base) || ctx.Err() != nil {
			continue
		}
		endpoint := base + "/v1/profiles/" + config.DeviceID
		request, err := http.NewRequestWithContext(ctx, "GET", endpoint, nil)
		if err != nil {
			continue
		}
		request.Header.Set("Authorization", "Bearer "+config.Token)
		response, err := client.Do(request)
		if err != nil {
			continue
		}
		payload, readErr := io.ReadAll(io.LimitReader(response.Body, 800001))
		response.Body.Close()
		if response.StatusCode != 200 || readErr != nil || len(payload) > 800000 {
			continue
		}
		var packet struct {
			Version  int          `json:"version"`
			DeviceID string       `json:"deviceId"`
			Profile  SleepProfile `json:"profile"`
			Avatar   string       `json:"avatar,omitempty"`
		}
		if json.Unmarshal(payload, &packet) != nil || packet.Version != 1 || packet.DeviceID != config.DeviceID {
			continue
		}
		var avatar []byte
		if packet.Profile.AvatarHash != "" {
			avatar, err = base64.StdEncoding.DecodeString(packet.Avatar)
			if err != nil || !validAvatar(avatar, packet.Profile.AvatarHash) {
				continue
			}
		}
		if a.paused() {
			return false, errPaused
		}
		if err = a.saveSleepProfile(packet.Profile, avatar); err != nil {
			return true, err
		}
		a.Progress.ProfileRoute = "lan"
		a.progress("receiving_local_profile", 1, 1)
		receipt := ProfileReceipt{Version: 1, ProfileVersion: 2, DeviceID: config.DeviceID, Revision: packet.Profile.Revision, AvatarHash: packet.Profile.AvatarHash, ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano)}
		body, _ := json.Marshal(receipt)
		request, err = http.NewRequestWithContext(ctx, "POST", endpoint+"/receipt", bytes.NewReader(body))
		if err != nil {
			return true, err
		}
		request.Header.Set("Authorization", "Bearer "+config.Token)
		request.Header.Set("Content-Type", "application/json")
		response, err = client.Do(request)
		if err != nil {
			return true, errors.New("profile received locally; confirmation failed, retry profile sync")
		}
		io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
		response.Body.Close()
		if response.StatusCode != 200 {
			return true, errors.New("profile changed or confirmation failed; retry profile sync")
		}
		return true, atomicJSON(filepath.Join(a.Directory, "lan-profile-receipt.json"), receipt)
	}
	return false, nil
}
