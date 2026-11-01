// Two layers of per-client rate limiting:
//  1. Cloudflare's native Rate Limiting binding (env.RATE_LIMITER) — shared
//     across isolates within a Cloudflare location, approximate.
//  2. An in-isolate token bucket — always on, cheap burst guard, and the only
//     layer when running locally or without the binding.
// Neither is a global/strict limit; the Durable Object daily quota (quota.js)
// is the hard ceiling on provider calls.

export class TokenBucketLimiter {
  constructor({ capacity = 5, refillPerSec = 5 / 60, maxKeys = 5000, now = () => Date.now() } = {}) {
    this.capacity = capacity;
    this.refillPerSec = refillPerSec;
    this.maxKeys = maxKeys;
    this.now = now;
    this.buckets = new Map();
  }

  take(key, cost = 1) {
    const t = this.now() / 1000;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) {
        // Evict the oldest entry (Map preserves insertion order) to bound memory.
        this.buckets.delete(this.buckets.keys().next().value);
      }
      b = { tokens: this.capacity, last: t };
    } else {
      b.tokens = Math.min(this.capacity, b.tokens + (t - b.last) * this.refillPerSec);
      b.last = t;
      this.buckets.delete(key); // re-insert to mark as recently used
    }
    this.buckets.set(key, b);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, remaining: Math.floor(b.tokens) };
    }
    const retryAfterSec = Math.max(1, Math.ceil((cost - b.tokens) / this.refillPerSec));
    return { ok: false, retryAfterSec };
  }
}

export async function checkRateLimit(env, key, bucket) {
  const local = bucket.take(key);
  if (!local.ok) return local;
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function') {
    try {
      const { success } = await env.RATE_LIMITER.limit({ key });
      if (!success) return { ok: false, retryAfterSec: 60 };
    } catch {
      // Fail closed: if the platform limiter errors, refuse rather than spend provider credits.
      return { ok: false, retryAfterSec: 30 };
    }
  }
  return { ok: true };
}
