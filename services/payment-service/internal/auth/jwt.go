package auth

import (
	"crypto/rsa"
	"errors"

	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
	jwt.RegisteredClaims
}

type Verifier struct {
	pub    *rsa.PublicKey
	issuer string
}

func NewVerifier(pubPEM []byte, issuer string) (*Verifier, error) {
	pub, err := jwt.ParseRSAPublicKeyFromPEM(pubPEM)
	if err != nil {
		return nil, err
	}
	return &Verifier{pub: pub, issuer: issuer}, nil
}

func (v *Verifier) Parse(tokenStr string) (*Claims, error) {
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return v.pub, nil
	}, jwt.WithIssuer(v.issuer))
	if err != nil {
		return nil, err
	}
	return claims, nil
}
