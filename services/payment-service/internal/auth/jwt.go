package auth

import (
	"errors"

	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	UserID string `json:"user_id"`
	Role   string `json:"role"`
	jwt.RegisteredClaims
}

type Verifier struct {
	jwks   *JWKSClient
	issuer string
}

func NewVerifier(jwks *JWKSClient, issuer string) *Verifier {
	return &Verifier{jwks: jwks, issuer: issuer}
}

func (v *Verifier) Parse(tokenStr string) (*Claims, error) {
	claims := &Claims{}
	_, err := jwt.ParseWithClaims(tokenStr, claims, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
			return nil, errors.New("unexpected signing method")
		}
		kid, _ := t.Header["kid"].(string)
		return v.jwks.Key(kid)
	}, jwt.WithIssuer(v.issuer))
	if err != nil {
		return nil, err
	}
	return claims, nil
}
