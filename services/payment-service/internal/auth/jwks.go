package auth

import (
	"context"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/big"
	"net/http"
	"sync"
	"time"
)

// JWKSClient fetches and caches the issuer's RSA public keys (RFC 7517) from
// its JWKS endpoint, indexed by `kid`. It refetches on a cache miss (throttled)
// so key rotation is picked up without a restart.
type JWKSClient struct {
	url        string
	hc         *http.Client
	minRefetch time.Duration

	mu        sync.RWMutex
	keys      map[string]*rsa.PublicKey
	lastFetch time.Time
}

func NewJWKSClient(url string) *JWKSClient {
	return &JWKSClient{
		url:        url,
		hc:         &http.Client{Timeout: 5 * time.Second},
		minRefetch: 30 * time.Second,
		keys:       map[string]*rsa.PublicKey{},
	}
}

// Init blocks until the JWKS has been fetched once, retrying — the issuer
// (user-service) may not be reachable yet at boot.
func (c *JWKSClient) Init(ctx context.Context, retries int, delay time.Duration) error {
	var err error
	for i := 0; i <= retries; i++ {
		if err = c.refresh(); err == nil {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
	return fmt.Errorf("jwks: giving up after %d retries: %w", retries, err)
}

// Key returns the public key for the given `kid`, refreshing once (throttled)
// if it isn't cached. With an empty kid it returns the sole key when there is
// exactly one.
func (c *JWKSClient) Key(kid string) (*rsa.PublicKey, error) {
	if k := c.lookup(kid); k != nil {
		return k, nil
	}
	c.mu.RLock()
	stale := time.Since(c.lastFetch) > c.minRefetch
	c.mu.RUnlock()
	if stale {
		_ = c.refresh()
		if k := c.lookup(kid); k != nil {
			return k, nil
		}
	}
	return nil, fmt.Errorf("jwks: no key for kid %q", kid)
}

func (c *JWKSClient) lookup(kid string) *rsa.PublicKey {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if kid != "" {
		return c.keys[kid]
	}
	if len(c.keys) == 1 {
		for _, k := range c.keys {
			return k
		}
	}
	return nil
}

func (c *JWKSClient) refresh() error {
	resp, err := c.hc.Get(c.url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("jwks: status %d", resp.StatusCode)
	}
	var doc struct {
		Keys []struct {
			Kty string `json:"kty"`
			Kid string `json:"kid"`
			N   string `json:"n"`
			E   string `json:"e"`
		} `json:"keys"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&doc); err != nil {
		return err
	}
	next := map[string]*rsa.PublicKey{}
	for _, k := range doc.Keys {
		if k.Kty != "RSA" {
			continue
		}
		nb, err := base64.RawURLEncoding.DecodeString(k.N)
		if err != nil {
			continue
		}
		eb, err := base64.RawURLEncoding.DecodeString(k.E)
		if err != nil {
			continue
		}
		next[k.Kid] = &rsa.PublicKey{
			N: new(big.Int).SetBytes(nb),
			E: int(new(big.Int).SetBytes(eb).Int64()),
		}
	}
	if len(next) == 0 {
		return fmt.Errorf("jwks: no RSA keys in document")
	}
	c.mu.Lock()
	c.keys = next
	c.lastFetch = time.Now()
	c.mu.Unlock()
	return nil
}
