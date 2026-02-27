/**
 * Metrics Store — Persistent Time-Series Data
 *
 * Samples metrics every N seconds, stores in Redis ZSET + JSONL file backup,
 * and provides aggregated queries for dashboard charts.
 *
 * Redis key (with ccp: prefix):
 *   metrics:ts — ZSET  score=unix_timestamp  member=JSON(snapshot)
 *
 * All public methods return new objects (immutable pattern).
 */

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = Object.freeze({
  dataDir: join(__dirname, "data"),
  fileName: "metrics.jsonl",
  sampleIntervalMs: 30_000,
  maxAgeDays: 7,
  maxEntries: 20_160,
});

const WINDOWS = Object.freeze({
  "1h": { maxAge: 3_600_000, bucketMs: 0 },
  "6h": { maxAge: 21_600_000, bucketMs: 180_000 },
  "1d": { maxAge: 86_400_000, bucketMs: 300_000 },
  "7d": { maxAge: 604_800_000, bucketMs: 3_600_000 },
});

const REDIS_KEY_METRICS = "metrics:ts";

/**
 * @param {object} options
 * @param {Function} [options.getMetrics] - () => current metrics snapshot object
 * @param {object} [options.redis] - Redis client from redis-client.mjs
 */
export function createMetricsStore(options = {}) {
  const { redis, ...rest } = options;
  const config = Object.freeze({ ...DEFAULTS, ...rest });
  const filePath = join(config.dataDir, config.fileName);

  let buffer = [];
  let samplerInterval = null;

  // --------------------------------------------------
  // File persistence (backup)
  // --------------------------------------------------

  async function ensureDataDir() {
    if (!existsSync(config.dataDir)) {
      await mkdir(config.dataDir, { recursive: true });
    }
  }

  async function loadFromFile() {
    try {
      await ensureDataDir();
      if (!existsSync(filePath)) return false;

      const raw = await readFile(filePath, "utf-8");
      const lines = raw.split("\n").filter((l) => l.trim());
      const cutoff = Date.now() - config.maxAgeDays * 86_400_000;

      const entries = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.ts * 1000 >= cutoff) {
            entries.push(Object.freeze(entry));
          }
        } catch {
          // skip malformed lines
        }
      }

      buffer = entries;

      if (buffer.length > config.maxEntries) {
        buffer = buffer.slice(buffer.length - config.maxEntries);
      }

      // Rewrite cleaned file
      if (entries.length < lines.length) {
        const cleaned = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
        await writeFile(filePath, cleaned, "utf-8");
      }

      return buffer.length > 0;
    } catch (err) {
      console.error(`[MetricsStore] File load error: ${err.message}`);
      return false;
    }
  }

  async function appendToFile(entry) {
    try {
      await ensureDataDir();
      await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      console.error(`[MetricsStore] File append error: ${err.message}`);
    }
  }

  // --------------------------------------------------
  // Redis persistence (primary)
  // --------------------------------------------------

  async function loadFromRedis() {
    if (!redis?.isReady()) return false;

    try {
      const cutoffSec = Math.floor(
        (Date.now() - config.maxAgeDays * 86_400_000) / 1000
      );

      // Get all entries within retention window
      const raw = await redis.client.zrangebyscore(
        REDIS_KEY_METRICS,
        cutoffSec,
        "+inf"
      );

      if (!raw || raw.length === 0) return false;

      const entries = [];
      for (const json of raw) {
        try {
          entries.push(Object.freeze(JSON.parse(json)));
        } catch {
          // skip malformed
        }
      }

      if (entries.length === 0) return false;

      // Trim to max
      buffer =
        entries.length > config.maxEntries
          ? entries.slice(entries.length - config.maxEntries)
          : entries;

      return true;
    } catch (err) {
      console.error(`[MetricsStore] Redis load error: ${err.message}`);
      return false;
    }
  }

  /**
   * Save a snapshot to Redis ZSET (fire-and-forget).
   */
  function saveToRedis(entry) {
    if (!redis?.isReady()) return;

    const pipeline = redis.client.pipeline();
    // Add with timestamp as score for range queries
    pipeline.zadd(REDIS_KEY_METRICS, entry.ts, JSON.stringify(entry));
    // Trim entries older than retention period
    const cutoffSec = Math.floor(
      (Date.now() - config.maxAgeDays * 86_400_000) / 1000
    );
    pipeline.zremrangebyscore(REDIS_KEY_METRICS, "-inf", cutoffSec);

    pipeline.exec().catch((err) => {
      console.error(`[MetricsStore] Redis save error: ${err.message}`);
    });
  }

  /**
   * Bulk-migrate file data to Redis (one-time migration).
   */
  async function migrateToRedis() {
    if (!redis?.isReady() || buffer.length === 0) return;

    try {
      // Batch ZADD in chunks of 100
      const CHUNK = 100;
      for (let i = 0; i < buffer.length; i += CHUNK) {
        const chunk = buffer.slice(i, i + CHUNK);
        const pipeline = redis.client.pipeline();
        for (const entry of chunk) {
          pipeline.zadd(REDIS_KEY_METRICS, entry.ts, JSON.stringify(entry));
        }
        await pipeline.exec();
      }

      console.log(
        `[MetricsStore] Migrated ${buffer.length} snapshots to Redis`
      );
    } catch (err) {
      console.error(`[MetricsStore] Redis migration error: ${err.message}`);
    }
  }

  // --------------------------------------------------
  // Snapshot
  // --------------------------------------------------

  function snapshot(data) {
    const entry = Object.freeze({
      ts: Math.floor(Date.now() / 1000),
      tok: {
        i: data.tokens?.input || 0,
        o: data.tokens?.output || 0,
        t: data.tokens?.total || 0,
      },
      req: {
        a: data.queue?.active || 0,
        q: data.queue?.totalQueued || 0,
        c: data.queue?.metrics?.totalProcessed || 0,
        e: data.events?.error || 0,
        to: data.events?.timeout || 0,
      },
      proc: {
        s: data.processes?.byMode?.sync || 0,
        st: data.processes?.byMode?.stream || 0,
      },
      models: buildModelSnapshot(data.tokensByModel || {}),
      live: {
        i: data.liveTokens?.input || 0,
        o: data.liveTokens?.output || 0,
        t: data.liveTokens?.total || 0,
      },
    });

    buffer =
      buffer.length >= config.maxEntries
        ? [...buffer.slice(1), entry]
        : [...buffer, entry];

    // Dual-write: Redis + file
    saveToRedis(entry);
    appendToFile(entry);

    return entry;
  }

  function buildModelSnapshot(byModel) {
    const out = {};
    for (const [model, data] of Object.entries(byModel)) {
      out[model] = {
        i: data.input || 0,
        o: data.output || 0,
        r: data.requests || 0,
      };
    }
    return Object.freeze(out);
  }

  // --------------------------------------------------
  // Query
  // --------------------------------------------------

  function query(window = "1h") {
    const win = WINDOWS[window] || WINDOWS["1h"];
    const cutoffTs = Math.floor((Date.now() - win.maxAge) / 1000);

    const filtered = buffer.filter((e) => e.ts >= cutoffTs);
    if (filtered.length === 0) return [];

    if (win.bucketMs === 0) {
      return filtered.map(expandPoint);
    }

    return aggregate(filtered, Math.floor(win.bucketMs / 1000));
  }

  function aggregate(points, bucketSec) {
    if (points.length === 0) return [];

    const buckets = new Map();
    for (const p of points) {
      const bucketKey = Math.floor(p.ts / bucketSec) * bucketSec;
      const existing = buckets.get(bucketKey);
      if (!existing) {
        buckets.set(bucketKey, { points: [p], ts: bucketKey });
      } else {
        existing.points.push(p);
      }
    }

    const result = [];
    for (const [, bucket] of [...buckets.entries()].sort(
      (a, b) => a[0] - b[0]
    )) {
      const pts = bucket.points;
      const last = pts[pts.length - 1];
      const avgActive = Math.round(
        pts.reduce((s, p) => s + p.req.a, 0) / pts.length
      );
      const avgQueued = Math.round(
        pts.reduce((s, p) => s + p.req.q, 0) / pts.length
      );
      const avgProc = Math.round(
        pts.reduce((s, p) => s + p.proc.s + p.proc.st, 0) / pts.length
      );
      const maxErrors = pts.reduce(
        (s, p) => Math.max(s, p.req.e || 0),
        0
      );

      result.push(
        Object.freeze({
          ts: bucket.ts,
          tokI: last.tok.i,
          tokO: last.tok.o,
          tokT: last.tok.t,
          reqActive: avgActive,
          reqQueued: avgQueued,
          reqCompleted: last.req.c,
          reqErrors: maxErrors,
          reqTimeouts: last.req.to || 0,
          processes: avgProc,
          models: last.models || {},
          liveI: last.live?.i || 0,
          liveO: last.live?.o || 0,
          liveT: last.live?.t || 0,
          samples: pts.length,
        })
      );
    }

    return result;
  }

  function expandPoint(p) {
    return Object.freeze({
      ts: p.ts,
      tokI: p.tok.i,
      tokO: p.tok.o,
      tokT: p.tok.t,
      reqActive: p.req.a,
      reqQueued: p.req.q,
      reqCompleted: p.req.c,
      reqErrors: p.req.e || 0,
      reqTimeouts: p.req.to || 0,
      processes: p.proc.s + p.proc.st,
      models: p.models || {},
      liveI: p.live?.i || 0,
      liveO: p.live?.o || 0,
      liveT: p.live?.t || 0,
      samples: 1,
    });
  }

  // --------------------------------------------------
  // Sampler
  // --------------------------------------------------

  function startSampler(getMetrics) {
    if (samplerInterval) return;

    samplerInterval = setInterval(() => {
      try {
        const data = getMetrics();
        snapshot(data);
      } catch (err) {
        console.error(`[MetricsStore] Sample error: ${err.message}`);
      }
    }, config.sampleIntervalMs);

    if (samplerInterval.unref) samplerInterval.unref();
  }

  // --------------------------------------------------
  // Lifecycle
  // --------------------------------------------------

  function destroy() {
    if (samplerInterval) {
      clearInterval(samplerInterval);
      samplerInterval = null;
    }
  }

  function getBufferSize() {
    return buffer.length;
  }

  function getRawBuffer() {
    return [...buffer];
  }

  // --------------------------------------------------
  // Init: load from Redis first, fall back to file
  // --------------------------------------------------

  const ready = (async () => {
    const fromRedis = await loadFromRedis();
    if (fromRedis) {
      console.log(
        `[MetricsStore] Loaded ${buffer.length} snapshots from Redis`
      );
      return;
    }

    const fromFile = await loadFromFile();
    if (fromFile) {
      console.log(
        `[MetricsStore] Loaded ${buffer.length} snapshots from file`
      );
      // One-time migration to Redis
      await migrateToRedis();
      return;
    }

    console.log("[MetricsStore] Starting fresh (no historical data)");
  })();

  return Object.freeze({
    snapshot,
    query,
    startSampler,
    destroy,
    getBufferSize,
    getRawBuffer,
    ready,
    config,
  });
}
