package config

import (
	"fmt"
	"os"
	"time"
)

type Config struct {
	Port            string
	DatabaseURL     string
	JWTPrivateKey   []byte
	JWTPublicKey    []byte
	JWTIssuer       string
	JWTTTL          time.Duration
}

func Load() (*Config, error) {
	cfg := &Config{
		Port:        getEnv("PORT", "8080"),
		DatabaseURL: mustEnv("DATABASE_URL"),
		JWTIssuer:   getEnv("JWT_ISSUER", "user-service"),
		JWTTTL:      24 * time.Hour,
	}

	privPath := mustEnv("JWT_PRIVATE_KEY_PATH")
	pubPath := mustEnv("JWT_PUBLIC_KEY_PATH")

	priv, err := os.ReadFile(privPath)
	if err != nil {
		return nil, fmt.Errorf("read private key: %w", err)
	}
	pub, err := os.ReadFile(pubPath)
	if err != nil {
		return nil, fmt.Errorf("read public key: %w", err)
	}
	cfg.JWTPrivateKey = priv
	cfg.JWTPublicKey = pub
	return cfg, nil
}

func getEnv(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func mustEnv(k string) string {
	v := os.Getenv(k)
	if v == "" {
		panic(fmt.Sprintf("missing required env var %s", k))
	}
	return v
}
