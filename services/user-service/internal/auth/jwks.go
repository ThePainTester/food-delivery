package auth

import (
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
)

// JWK is a single RSA public key in JWK form (RFC 7517).
type JWK struct {
	Kty string `json:"kty"`
	Use string `json:"use"`
	Alg string `json:"alg"`
	Kid string `json:"kid"`
	N   string `json:"n"`
	E   string `json:"e"`
}

// JWKS is the document served at /.well-known/jwks.json.
type JWKS struct {
	Keys []JWK `json:"keys"`
}

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// rfc7638Thumbprint is the canonical JWK thumbprint, used as the `kid` so
// verifiers can match a token to a key without any out-of-band config.
func rfc7638Thumbprint(n, e string) string {
	// RFC 7638: hash the JSON object with members in lexicographic order:
	// {"e":...,"kty":"RSA","n":...}
	canonical, _ := json.Marshal(struct {
		E   string `json:"e"`
		Kty string `json:"kty"`
		N   string `json:"n"`
	}{E: e, Kty: "RSA", N: n})
	sum := sha256.Sum256(canonical)
	return b64url(sum[:])
}

// publicJWK renders an RSA public key as a JWK with a stable kid.
func publicJWK(pub *rsa.PublicKey) JWK {
	n := b64url(pub.N.Bytes())
	e := b64url(big.NewInt(int64(pub.E)).Bytes())
	return JWK{Kty: "RSA", Use: "sig", Alg: "RS256", Kid: rfc7638Thumbprint(n, e), N: n, E: e}
}
