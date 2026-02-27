/**
 * Process Registry — Persistent PID Tracking + Zombie Reaper
 *
 * Tracks every spawned CLI process by PID. Periodic reaper kills
 * processes that exceed age or idle thresholds. Persists to Redis HASH.
 *
 * Redis keys (with ccp: prefix):
 *   procs:entries — HASH { pid: JSON(entry) }
 *   procs:metrics — HASH { totalRegistered, totalReaped, totalKilled, reapErrors }
 *
 * All public methods return new objects (immutable pattern).
 * Internal state is encapsulated in closure.
 */

const DEFAULTS = Object.freeze({
  maxProcessAgeMs: 600_000,   // 10 minutes — absolute max lifetime
  maxIdleMs: 120_000,         // 2 minutes — kill if no stdout activity
  reaperIntervalMs: 15_000,   // sweep every 15 seconds
});

const REDIS_KEY_ENTRIES = "procs:entries";
const REDIS_KEY_METRICS = "procs:metrics";

function ts() {
  return new Date().toISOString();
}

/**
 * @param {object} [options]
 * @param {number} [options.maxProcessAgeMs]
 * @param {number} [options.maxIdleMs]
 * @param {number} [options.reaperIntervalMs]
 * @param {object} [options.redis] - Redis client from redis-client.mjs
 */
export function createProcessRegistry(options = {}) {
  const { redis, ...rest } = options;
  const config = Object.freeze({ ...DEFAULTS, ...rest });

  let onReapCallback = null;

  // Internal state: Map<pid, frozenEntry>
  let entries = new Map();

  // Cumulative metrics (persisted across restarts in Redis)
  let metrics = Object.freeze({
    totalRegistered: 0,
    totalReaped: 0,
    totalKilled: 0,
    reapErrors: 0,
  });

  // Session-only metrics (reset on each restart, not persisted)
  let sessionMetrics = Object.freeze({
    registered: 0,
    reaped: 0,
    killed: 0,
  });

  // --------------------------------------------------
  // Redis persistence
  // --------------------------------------------------

  async function loadFromRedis() {
    if (!redis?.isReady()) return false;

    try {
      // Load cumulative metrics
      const rawMetrics = await redis.client.hgetall(REDIS_KEY_METRICS);
      if (rawMetrics && Object.keys(rawMetrics).length > 0) {
        metrics = Object.freeze({
          totalRegistered: parseInt(rawMetrics.totalRegistered, 10) || 0,
          totalReaped: parseInt(rawMetrics.totalReaped, 10) || 0,
          totalKilled: parseInt(rawMetrics.totalKilled, 10) || 0,
          reapErrors: parseInt(rawMetrics.reapErrors, 10) || 0,
        });
      }

      // Load entries and check for stale PIDs from previous server run
      const rawEntries = await redis.client.hgetall(REDIS_KEY_ENTRIES);
      if (rawEntries && Object.keys(rawEntries).length > 0) {
        const staleCount = cleanStaleEntries(rawEntries);
        if (staleCount > 0) {
          console.log(
            `[${ts()}] REGISTRY cleaned ${staleCount} stale PIDs from Redis`
          );
        }
      }

      return true;
    } catch (err) {
      console.error(`[${ts()}] REGISTRY Redis load error: ${err.message}`);
      return false;
    }
  }

  /**
   * Check if PIDs from a previous session are still alive.
   * Dead PIDs are removed from Redis.
   */
  function cleanStaleEntries(rawEntries) {
    let staleCount = 0;
    const stalePids = [];

    for (const [pidStr] of Object.entries(rawEntries)) {
      const pid = parseInt(pidStr, 10);
      try {
        // signal 0 = check if process exists without killing
        process.kill(pid, 0);
        // Process alive but from previous server — don't import to memory
        // (can't track its stdout); reaper will handle if it's a zombie
      } catch {
        // ESRCH = process doesn't exist = stale
        stalePids.push(pidStr);
        staleCount++;
      }
    }

    // Remove stale entries from Redis
    if (stalePids.length > 0 && redis?.isReady()) {
      redis.client
        .hdel(REDIS_KEY_ENTRIES, ...stalePids)
        .catch((err) => {
          console.error(
            `[${ts()}] REGISTRY Redis stale cleanup error: ${err.message}`
          );
        });
    }

    return staleCount;
  }

  function saveEntryToRedis(pid, entry) {
    if (!redis?.isReady()) return;
    redis.client
      .hset(REDIS_KEY_ENTRIES, String(pid), JSON.stringify(entry))
      .catch((err) => {
        console.error(
          `[${ts()}] REGISTRY Redis entry save error: ${err.message}`
        );
      });
  }

  function removeEntryFromRedis(pid) {
    if (!redis?.isReady()) return;
    redis.client
      .hdel(REDIS_KEY_ENTRIES, String(pid))
      .catch((err) => {
        console.error(
          `[${ts()}] REGISTRY Redis entry remove error: ${err.message}`
        );
      });
  }

  function saveMetricsToRedis() {
    if (!redis?.isReady()) return;
    redis.client
      .hmset(REDIS_KEY_METRICS, {
        totalRegistered: String(metrics.totalRegistered),
        totalReaped: String(metrics.totalReaped),
        totalKilled: String(metrics.totalKilled),
        reapErrors: String(metrics.reapErrors),
      })
      .catch((err) => {
        console.error(
          `[${ts()}] REGISTRY Redis metrics save error: ${err.message}`
        );
      });
  }

  // -------------------------------------------------------
  // Core operations
  // -------------------------------------------------------

  function register({ pid, requestId, model, mode, source, promptPreview }) {
    if (pid == null) return null;

    const now = Date.now();
    const entry = Object.freeze({
      pid,
      requestId,
      model,
      mode,
      source,
      promptPreview: (promptPreview || "").slice(0, 80),
      spawnedAt: now,
      lastActivityAt: now,
    });

    if (entries.has(pid)) {
      console.warn(`[${ts()}] REGISTRY_WARN duplicate pid=${pid}, replacing`);
    }

    const next = new Map(entries);
    next.set(pid, entry);
    entries = next;

    metrics = Object.freeze({
      ...metrics,
      totalRegistered: metrics.totalRegistered + 1,
    });
    sessionMetrics = Object.freeze({
      ...sessionMetrics,
      registered: sessionMetrics.registered + 1,
    });

    saveEntryToRedis(pid, entry);
    saveMetricsToRedis();

    return entry;
  }

  function unregister(pid) {
    const entry = entries.get(pid);
    if (!entry) return null;

    const next = new Map(entries);
    next.delete(pid);
    entries = next;

    removeEntryFromRedis(pid);

    return entry;
  }

  /**
   * Update lastActivityAt and optionally merge extra fields.
   * @param {number} pid
   * @param {object} [extra] - Additional fields to merge into the entry
   */
  function touch(pid, extra = {}) {
    const entry = entries.get(pid);
    if (!entry) return null;

    const updated = Object.freeze({
      ...entry,
      ...extra,
      lastActivityAt: Date.now(),
    });

    const next = new Map(entries);
    next.set(pid, updated);
    entries = next;

    // Fire-and-forget — don't slow down hot path
    saveEntryToRedis(pid, updated);

    return updated;
  }

  function get(pid) {
    return entries.get(pid) || null;
  }

  function getAll() {
    return Array.from(entries.values());
  }

  // -------------------------------------------------------
  // Zombie detection
  // -------------------------------------------------------

  function getZombies(maxAgeMs = config.maxProcessAgeMs, maxIdleMs = config.maxIdleMs) {
    const now = Date.now();
    const zombies = [];

    for (const entry of entries.values()) {
      const age = now - entry.spawnedAt;
      const idle = now - entry.lastActivityAt;
      if (age > maxAgeMs || idle > maxIdleMs) {
        zombies.push(Object.freeze({ ...entry, age, idle }));
      }
    }

    return Object.freeze(zombies);
  }

  function kill(pid, signal = "SIGTERM") {
    const entry = entries.get(pid);
    let killed = false;

    try {
      process.kill(pid, signal);
      killed = true;
    } catch (err) {
      if (err.code !== "ESRCH") {
        console.error(`[${ts()}] KILL_ERR pid=${pid} ${err.message}`);
      }
    }

    // Always unregister
    unregister(pid);

    if (killed) {
      metrics = Object.freeze({
        ...metrics,
        totalKilled: metrics.totalKilled + 1,
      });
      sessionMetrics = Object.freeze({
        ...sessionMetrics,
        killed: sessionMetrics.killed + 1,
      });
      saveMetricsToRedis();
    }

    return { killed, entry: entry || null };
  }

  // -------------------------------------------------------
  // Reaper
  // -------------------------------------------------------

  function reap() {
    const zombies = getZombies();
    if (zombies.length === 0) return { reaped: [], count: 0, errors: [] };

    const reaped = [];
    const errors = [];

    for (const zombie of zombies) {
      const ageS = Math.round(zombie.age / 1000);
      const idleS = Math.round(zombie.idle / 1000);

      console.log(
        `[${ts()}] REAP pid=${zombie.pid} reqId=${zombie.requestId} ` +
        `age=${ageS}s idle=${idleS}s model=${zombie.model} mode=${zombie.mode} ` +
        `src=${zombie.source}`
      );

      const result = kill(zombie.pid);
      if (result.killed || result.entry) {
        reaped.push(zombie);
      } else {
        errors.push({ pid: zombie.pid, error: "not found" });
      }
    }

    metrics = Object.freeze({
      ...metrics,
      totalReaped: metrics.totalReaped + reaped.length,
      reapErrors: metrics.reapErrors + errors.length,
    });
    sessionMetrics = Object.freeze({
      ...sessionMetrics,
      reaped: sessionMetrics.reaped + reaped.length,
    });
    saveMetricsToRedis();

    return Object.freeze({ reaped, count: reaped.length, errors });
  }

  /**
   * Set a callback for reap events.
   * @param {Function} fn - (zombie) => void, called for each reaped process
   */
  function onReap(fn) {
    onReapCallback = fn;
  }

  // Start periodic reaper
  const reaperInterval = setInterval(() => {
    const result = reap();
    if (result.count > 0) {
      console.log(`[${ts()}] REAPER swept ${result.count} zombies`);
      if (onReapCallback) {
        for (const zombie of result.reaped) {
          try { onReapCallback(zombie); } catch { /* ignore callback errors */ }
        }
      }
    }
  }, config.reaperIntervalMs);

  if (reaperInterval.unref) reaperInterval.unref();

  // -------------------------------------------------------
  // Stats
  // -------------------------------------------------------

  function getStats() {
    const all = getAll();
    const byMode = { sync: 0, stream: 0 };
    const byModel = {};
    let oldest = null;
    let liveTokens = { input: 0, output: 0, total: 0 };

    for (const entry of all) {
      byMode[entry.mode] = (byMode[entry.mode] || 0) + 1;
      byModel[entry.model] = (byModel[entry.model] || 0) + 1;
      if (!oldest || entry.spawnedAt < oldest.spawnedAt) {
        oldest = entry;
      }
      const li = entry.liveInputTokens || 0;
      const lo = entry.liveOutputTokens || 0;
      liveTokens = {
        input: liveTokens.input + li,
        output: liveTokens.output + lo,
        total: liveTokens.total + li + lo,
      };
    }

    return Object.freeze({
      total: all.length,
      byMode: Object.freeze({ ...byMode }),
      byModel: Object.freeze({ ...byModel }),
      oldest: oldest ? Object.freeze({ ...oldest }) : null,
      liveTokens: Object.freeze(liveTokens),
      metrics: Object.freeze({ ...metrics }),
      session: Object.freeze({ ...sessionMetrics }),
    });
  }

  // -------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------

  function destroy() {
    clearInterval(reaperInterval);
  }

  // -------------------------------------------------------
  // Init: load from Redis
  // -------------------------------------------------------

  const ready = (async () => {
    const loaded = await loadFromRedis();
    if (loaded) {
      console.log(
        `[${ts()}] REGISTRY Loaded from Redis: registered=${metrics.totalRegistered} reaped=${metrics.totalReaped} killed=${metrics.totalKilled}`
      );
    }
  })();

  return Object.freeze({
    register,
    unregister,
    touch,
    get,
    getAll,
    getZombies,
    kill,
    reap,
    onReap,
    getStats,
    destroy,
    ready,
    config,
  });
}
