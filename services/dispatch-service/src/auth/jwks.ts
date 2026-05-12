import crypto, { KeyObject } from "node:crypto";

// Minimal JWKS client: fetches the issuer's RSA public keys (RFC 7517) from
// its JWKS endpoint, caches them by `kid`, and refetches on a cache miss
// (throttled) so key rotation is picked up without a restart. Uses Node 20's
// global fetch and crypto.createPublicKey({ format: "jwk" }) — no extra deps.

interface Jwk {
  kty: string;
  kid: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

export class JwksCache {
  private keys = new Map<string, KeyObject>();
  private lastFetch = 0;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly url: string,
    private readonly minRefetchMs = 30_000,
  ) {}

  // Block until the JWKS has been fetched once, retrying — user-service may
  // not be reachable yet at boot.
  async init(retries = 30, delayMs = 2_000): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.refresh();
        return;
      } catch (err) {
        if (attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }

  async getKey(kid: string | undefined): Promise<KeyObject | undefined> {
    const hit = kid ? this.keys.get(kid) : undefined;
    if (hit) return hit;
    if (Date.now() - this.lastFetch > this.minRefetchMs) {
      try {
        await this.refresh();
      } catch {
        // keep serving the stale cache on a transient fetch failure
      }
    }
    if (kid) return this.keys.get(kid);
    // No kid in the token header: fall back to the sole key when unambiguous.
    return this.keys.size === 1 ? this.keys.values().next().value : undefined;
  }

  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const res = await fetch(this.url);
      if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
      const body = (await res.json()) as { keys?: Jwk[] };
      const next = new Map<string, KeyObject>();
      for (const jwk of body.keys ?? []) {
        if (jwk.kty !== "RSA") continue;
        const key: crypto.JsonWebKey = { kty: jwk.kty, n: jwk.n, e: jwk.e };
        next.set(jwk.kid, crypto.createPublicKey({ key, format: "jwk" }));
      }
      if (next.size === 0) throw new Error("JWKS has no RSA keys");
      this.keys = next;
      this.lastFetch = Date.now();
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
}
