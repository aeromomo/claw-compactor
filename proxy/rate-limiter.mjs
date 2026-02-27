/**
 * Rate Limiter — Sliding Window Per-Model
 *
 * Tracks request and token rates using a 60-second sliding window.
 * Optionally backed by Redis ZSET for persistence.
 * Falls back to in-memory if Redis is unavailable.
 *
 * All public methods return new objects (immutable pattern).
 */

/**
 * @param {object} options
 * @param {object} options.limits - { [model]: { requestsPerMin, tokensPerMin } }
 * @param {object} [options.redis] - Redis client from redis-client.mjs
 */
export function createRateLimiter({ limits, redis } = {}) {
  // In-memory fallback
  let windows = {};

  const WINDOW_MS = 60_000;

  // --------------------------------------------------
  // In-memory window (always maintained as source of truth for this process)
  // --------------------------------------------------

  function getWindow(model) {
    const now = Date.now();
    const existing = windows[model] || { requests: [] };
    const valid = existing.requests.filter((r) => now - r.ts < WINDOW_MS);
    const tokens = valid.reduce((sum, r) => sum + r.tok, 0);
    return { requests: valid, tokens };
  }

  /**
   * Check if a request is within rate limits.
   * @param {string} model
   * @param {number} [estTokens=1000]
   * @returns {{ ok: boolean, waitMs: number, reason: string|null }}
   */
  function check(model, estTokens = 1000) {
    const modelLimits = limits[model] || limits.sonnet;
    const win = getWindow(model);

    if (win.requests.length >= modelLimits.requestsPerMin) {
      const waitMs = WINDOW_MS - (Date.now() - win.requests[0].ts);
      return Object.freeze({
        ok: false,
        waitMs: Math.max(waitMs, 1000),
        reason: `${win.requests.length}/${modelLimits.requestsPerMin} req/min`,
      });
    }

    if (win.tokens + estTokens > modelLimits.tokensPerMin) {
      // If window is empty, allow a single large request through
      // (can't split one request, and chars/4 over-estimates tokens)
      if (win.requests.length === 0) {
        return Object.freeze({ ok: true, waitMs: 0, reason: null });
      }
      const waitMs = win.requests[0] ? WINDOW_MS - (Date.now() - win.requests[0].ts) : 5000;
      return Object.freeze({
        ok: false,
        waitMs: Math.max(waitMs, 1000),
        reason: `~${win.tokens}/${modelLimits.tokensPerMin} tok/min`,
      });
    }

    return Object.freeze({ ok: true, waitMs: 0, reason: null });
  }

  /**
   * Record a request in the sliding window.
   * @param {string} model
   * @param {number} [estTokens=1000]
   */
  function record(model, estTokens = 1000) {
    const now = Date.now();
    const win = getWindow(model);
    windows = {
      ...windows,
      [model]: { requests: [...win.requests, { ts: now, tok: estTokens }] },
    };

    // Also record to Redis (fire-and-forget)
    if (redis?.isReady()) {
      const key = `rate:${model}`;
      const member = `${now}:${estTokens}`;
      redis.client
        .pipeline()
        .zadd(key, now, member)
        .zremrangebyscore(key, "-inf", now - WINDOW_MS)
        .expire(key, 120)
        .exec()
        .catch((err) => {
          console.error(`[RateLimiter] Redis error: ${err.message}`);
        });
    }
  }

  /**
   * Get formatted stats for dashboard.
   * @returns {{ [model]: { requests: string, tokens: string } }}
   */
  function stats() {
    const out = {};
    for (const model of Object.keys(limits)) {
      const win = getWindow(model);
      const lim = limits[model];
      out[model] = {
        requests: `${win.requests.length}/${lim.requestsPerMin}`,
        tokens: `~${win.tokens}/${lim.tokensPerMin}`,
      };
    }
    return Object.freeze(out);
  }

  return Object.freeze({ check, record, stats });
}
