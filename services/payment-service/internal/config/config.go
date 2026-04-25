package config

import (
	"fmt"
	"os"
)

type Config struct {
	Port                 string
	DatabaseURL          string
	RabbitURL            string
	JWTPublicKey         []byte
	JWTIssuer            string
	DefaultPaymentMethod string
}

func Load() (*Config, error) {
	cfg := &Config{
		Port:                 getEnv("PORT", "8080"),
		DatabaseURL:          mustEnv("DATABASE_URL"),
		RabbitURL:            mustEnv("RABBIT_URL"),
		JWTIssuer:            getEnv("JWT_ISSUER", "user-service"),
		DefaultPaymentMethod: getEnv("DEFAULT_PAYMENT_METHOD", "mock-card"),
	}
	pubPath := mustEnv("JWT_PUBLIC_KEY_PATH")
	pub, err := os.ReadFile(pubPath)
	if err != nil {
		return nil, fmt.Errorf("read public key: %w", err)
	}
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
