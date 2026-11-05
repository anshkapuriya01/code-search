// Small per-isolate caches. A Worker isolate serves many requests, so these remove most
// database reads for hot API keys and sessions. They are best-effort: each isolate has its own.

/** Bounded map with per-entry expiry; oldest entries are evicted first. */
export class TtlCache {
  constructor(maxEntries) {
    this.max = maxEntries;
    this.map = new Map();
  }

  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key, value, ttlMs) {
    this.map.delete(key);
    this.map.set(key, { value, expires: Date.now() + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }

  delete(key) {
    this.map.delete(key);
  }

  /** Removes every entry whose value matches the predicate. */
  deleteWhere(predicate) {
    for (const [key, entry] of this.map) if (predicate(entry.value)) this.map.delete(key);
  }
}

/**
 * Fixed-window counter per key, used when the Cloudflare rate-limit binding is not configured.
 * Per isolate only, so it is a backstop rather than an exact limit.
 */
export class WindowLimiter {
  constructor(limit, windowMs, maxKeys = 10000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.cache = new TtlCache(maxKeys);
  }

  /** Returns { ok, retryAfter } and counts the attempt. */
  take(key) {
    const now = Date.now();
    let w = this.cache.get(key);
    if (!w) {
      w = { start: now, count: 0 };
      this.cache.set(key, w, this.windowMs);
    }
    w.count++;
    if (w.count <= this.limit) return { ok: true, retryAfter: 0 };
    return { ok: false, retryAfter: Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000)) };
  }
}
