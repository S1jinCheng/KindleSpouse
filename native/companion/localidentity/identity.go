package localidentity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"os"
	"path/filepath"
	"time"
)

func Create(directory string) error {
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	certFile, keyFile := filepath.Join(directory, "certificate.pem"), filepath.Join(directory, "private-key.pem")
	_, certErr := os.Stat(certFile)
	_, keyErr := os.Stat(keyFile)
	if certErr == nil || keyErr == nil {
		_, err := tls.LoadX509KeyPair(certFile, keyFile)
		return err
	}
	if !os.IsNotExist(certErr) || !os.IsNotExist(keyErr) {
		return errors.New("cannot access local identity")
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return err
	}
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "KindleSpouse local profile"}, NotBefore: time.Now().Add(-24 * time.Hour), NotAfter: time.Now().AddDate(10, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}, DNSNames: []string{"kindlespouse.local"}}
	certificate, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return err
	}
	privateKey, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	if err = os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privateKey}), 0600); err != nil {
		return err
	}
	return os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate}), 0600)
}
