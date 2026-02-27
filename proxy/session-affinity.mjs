/**
 * Session Affinity — sticky routing for conversation sessions.
 *
 * Maps session keys to workers so the same conversation always
 * routes to the same CLI instance (preserving rate-limit budgets
 * and enabling future persistent sessions).
 *
 * Session key priority:
 *   1. x-session-id header (explicit, most precise)
 *   2. source + systemPrompt hash (same conversation = same prompt prefix)
 *   3. source alone (coarse fallback)
 *
 * Entries expire after TTL_MS of inactivity.
 */

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 min
const SWEEP_INTERVAL_MS = 60 * 1000;   // 1 min

/**
 * @param {object} opts
 * @param {number} [opts.ttlMs]           Inactivity TTL (default 30 min)
 * @param {number} [opts.sweepIntervalMs] Cleanup interval (default 60s)
 * @returns {SessionAffinity}
 */
export function createSessionAffinity(opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const sweepMs = opts.sweepIntervalMs ?? SWEEP_INTERVAL_MS;

  // sessionKey -> { workerName, lastUsedAt, createdAt, requestCount }
  const _map = new Map();

  let _hits = 0;
  let _misses = 0;
  let _reassigns = 0;

  // Periodic sweep of stale entries
  const _sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of _map) {
      if (now - entry.lastUsedAt > ttlMs) {
        _map.delete(key);
      }
    }
  }, sweepMs);
  _sweepTimer.unref?.();

  /**
   * Derive a session key from request context.
   *
   * @param {object} ctx
   * @param {string} ctx.source        - Client source identifier
   * @param {string} [ctx.sessionId]   - Explicit session ID (x-session-id header)
   * @param {string} [ctx.systemPrompt] - System prompt (for fingerprinting)
   * @returns {string} sessionKey
   */
  function deriveKey(ctx) {
    // 1. Explicit session ID is most precise
    if (ctx.sessionId) {
      return `sid:${ctx.sessionId}`;
    }

    // 2. Source + system prompt hash — same conversation usually keeps
    //    the same system prompt across turns
    if (ctx.systemPrompt) {
      const hash = simpleHash(ctx.systemPrompt.slice(0, 200));
      return `sp:${ctx.source}:${hash}`;
    }

    // 3. Source alone
    return `src:${ctx.source}`;
  }

  /**
   * Look up the affinity worker for a session.
   *
   * @param {string} sessionKey
   * @param {function} isWorkerHealthy - (workerName) => boolean
   * @returns {{ workerName: string, hit: boolean } | null}
   *   - hit=true: existing affinity, worker is healthy
   *   - hit=false: existing affinity but worker unhealthy (caller should reassign)
   *   - null: no affinity exists (caller should assign via round-robin)
   */
  function lookup(sessionKey, isWorkerHealthy) {
    const entry = _map.get(sessionKey);
    if (!entry) {
      _misses++;
      return null;
    }

    // Touch the entry
    entry.lastUsedAt = Date.now();
    entry.requestCount++;

    if (isWorkerHealthy(entry.workerName)) {
      _hits++;
      return { workerName: entry.workerName, hit: true };
    }

    // Worker is unhealthy — caller will reassign
    _reassigns++;
    return { workerName: entry.workerName, hit: false };
  }

  /**
   * Assign (or reassign) a worker to a session.
   *
   * @param {string} sessionKey
   * @param {string} workerName
   */
  function assign(sessionKey, workerName) {
    const existing = _map.get(sessionKey);
    if (existing) {
      // Reassign — preserve creation time and count
      existing.workerName = workerName;
      existing.lastUsedAt = Date.now();
      return;
    }
    _map.set(sessionKey, {
      workerName,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      requestCount: 1,
    });
  }

  /**
   * Remove a specific session's affinity.
   */
  function remove(sessionKey) {
    _map.delete(sessionKey);
  }

  /**
   * Get stats for monitoring.
   */
  function getStats() {
    const total = _hits + _misses + _reassigns;
    return {
      activeSessions: _map.size,
      hits: _hits,
      misses: _misses,
      reassigns: _reassigns,
      hitRate: total > 0 ? (_hits / total * 100).toFixed(1) + "%" : "0%",
      totalLookups: total,
    };
  }

  /**
   * Shutdown — clear timer.
   */
  function shutdown() {
    clearInterval(_sweepTimer);
    _map.clear();
  }

  return {
    deriveKey,
    lookup,
    assign,
    remove,
    getStats,
    shutdown,
  };
}

/**
 * Fast, non-crypto hash for session fingerprinting.
 * FNV-1a 32-bit.
 */
function simpleHash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
}
