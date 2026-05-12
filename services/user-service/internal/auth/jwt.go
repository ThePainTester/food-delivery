package auth

import (
	"crypto/rsa"
	"errors"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
	jwt.RegisteredClaims
}

type Signer struct {
	priv   *rsa.PrivateKey
	pub    *rsa.PublicKey
	issuer string
	ttl    time.Duration
	kid    string
}

// NewSigner builds the token signer from the RSA private key PEM. The public
// key (and the JWKS published to verifiers) is derived from it.
func NewSigner(privPEM []byte, issuer string, ttl time.Duration) (*Signer, error) {
	priv, err := jwt.ParseRSAPrivateKeyFromPEM(privPEM)
	if err != nil {
		return nil, err
	}
	pub := &priv.PublicKey
	return &Signer{priv: priv, pub: pub, issuer: issuer, ttl: ttl, kid: publicJWK(pub).Kid}, nil
}

func (s *Signer) Issue(userID, role string) (string, error) {
	now := time.Now()
	claims := Claims{
		UserID: userID,
		Role:   role,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    s.issuer,
			Subject:   userID,
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(s.ttl)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = s.kid
	return token.SignedString(s.priv)
}

func (s *Signer) Parse(tokenStr string) (*Claims, error) {
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return s.pub, nil
	})
	if err != nil {
		return nil, err
	}
	return claims, nil
}

// JWKS returns the public-key set published at /.well-known/jwks.json.
func (s *Signer) JWKS() JWKS {
	return JWKS{Keys: []JWK{publicJWK(s.pub)}}
}
