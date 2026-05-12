package config

import (
	"fmt"
	"os"
)

type Config struct {
	Port                 string
	DatabaseURL          string
	RabbitURL            string
	JWKSURL              string
	JWTIssuer            string
	DefaultPaymentMethod string
}

func Load() (*Config, error) {
	cfg := &Config{
		Port:                 getEnv("PORT", "8080"),
		DatabaseURL:          mustEnv("DATABASE_URL"),
		RabbitURL:            mustEnv("RABBIT_URL"),
		JWKSURL:              mustEnv("JWKS_URL"),
		JWTIssuer:            getEnv("JWT_ISSUER", "user-service"),
		DefaultPaymentMethod: getEnv("DEFAULT_PAYMENT_METHOD", "mock-card"),
	}
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
