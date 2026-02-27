/**
 * Token Tracker — Persistent Per-Model Token Accounting
 *
 * Tracks input/output tokens per model and per request.
 * Primary storage: Redis HASH. Fallback: data/tokens.json.
 *
 * Redis keys (with ccp: prefix applied by redis-client):
 *   tokens:models   — HASH { model: JSON({input,output,requests}) }
 *   tokens:requests — HASH { reqId: JSON({input,output,model,ts}) }
 *
 * All public methods return new objects (immutable pattern).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "data");
const STATE_FILE = join(DATA_DIR, "tokens.json");

const REDIS_KEY_MODELS = "tokens:models";
const REDIS_KEY_REQUESTS = "tokens:requests";

/**
 * @param {object} [options]
 * @param {object} [options.redis] - Redis client from redis-client.mjs
 */
export function createTokenTracker({ redis } = {}) {
  // In-memory state (always maintained as source of truth for this process)
  let models = {};
  let requests = new Map();
  let saveTimer = null;

  const MAX_REQUESTS = 1000;

  // --------------------------------------------------
  // File persistence (backup)
  // --------------------------------------------------

  async function ensureDataDir() {
    if (!existsSync(DATA_DIR)) {
      await mkdir(DATA_DIR, { recursive: true });
    }
  }

  async function loadFromFile() {
    try {
      await ensureDataDir();
      if (!existsSync(STATE_FILE)) return false;

      const raw = await readFile(STATE_FILE, "utf-8");
      const data = JSON.parse(raw);

      if (data && typeof data.models === "object") {
        const loaded = {};
        for (const [model, counters] of Object.entries(data.models)) {
          loaded[model] = Object.freeze({
            input: counters.input || 0,
            output: counters.output || 0,
            requests: counters.requests || 0,
          });
        }
        models = loaded;
        return true;
      }
    } catch (err) {
      console.error(`[TokenTracker] File load error: ${err.message}`);
    }
    return false;
  }

  function scheduleFileSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await ensureDataDir();
        const data = JSON.stringify(
          { models, savedAt: new Date().toISOString() },
          null,
          2
        );
        await writeFile(STATE_FILE, data, "utf-8");
      } catch (err) {
        console.error(`[TokenTracker] File save error: ${err.message}`);
      }
    }, 1000);
    if (saveTimer.unref) saveTimer.unref();
  }

  // --------------------------------------------------
  // Redis persistence (primary)
  // --------------------------------------------------

  async function loadFromRedis() {
    if (!redis?.isReady()) return false;

    try {
      const raw = await redis.client.hgetall(REDIS_KEY_MODELS);
      if (!raw || Object.keys(raw).length === 0) return false;

      const loaded = {};
      for (const [model, json] of Object.entries(raw)) {
        try {
          const counters = JSON.parse(json);
          loaded[model] = Object.freeze({
            input: counters.input || 0,
            output: counters.output || 0,
            requests: counters.requests || 0,
          });
        } catch {
          // skip malformed entries
        }
      }

      if (Object.keys(loaded).length === 0) return false;

      models = loaded;
      return true;
    } catch (err) {
      console.error(`[TokenTracker] Redis load error: ${err.message}`);
      return false;
    }
  }

  /**
   * Save per-model totals to Redis (fire-and-forget).
   * Uses HSET to update specific model counters atomically.
   */
  function saveModelToRedis(model, counters) {
    if (!redis?.isReady()) return;

    redis.client
      .hset(REDIS_KEY_MODELS, model, JSON.stringify(counters))
      .catch((err) => {
        console.error(`[TokenTracker] Redis model save error: ${err.message}`);
      });
  }

  /**
   * Save a per-request snapshot to Redis (fire-and-forget).
   * Uses HSET + HLEN + trimming to cap at MAX_REQUESTS.
   */
  function saveRequestToRedis(reqId, snapshot) {
    if (!redis?.isReady()) return;

    const pipeline = redis.client.pipeline();
    pipeline.hset(REDIS_KEY_REQUESTS, reqId, JSON.stringify(snapshot));
    // Trim: check size and remove oldest if needed
    // We do a lightweight trim — exact cap enforced on read
    pipeline.hlen(REDIS_KEY_REQUESTS);
    pipeline
      .exec()
      .then((results) => {
        const len = results?.[1]?.[1];
        if (len && len > MAX_REQUESTS * 1.5) {
          // Batch trim when significantly over limit
          trimRedisRequests().catch(() => {});
        }
      })
      .catch((err) => {
        console.error(
          `[TokenTracker] Redis request save error: ${err.message}`
        );
      });
  }

  async function trimRedisRequests() {
    if (!redis?.isReady()) return;

    try {
      const all = await redis.client.hgetall(REDIS_KEY_REQUESTS);
      const entries = Object.entries(all);
      if (entries.length <= MAX_REQUESTS) return;

      // Parse timestamps, sort, delete oldest
      const parsed = entries
        .map(([key, val]) => {
          try {
            return { key, ts: JSON.parse(val).ts || 0 };
          } catch {
            return { key, ts: 0 };
          }
        })
        .sort((a, b) => a.ts - b.ts);

      const toDelete = parsed.slice(0, parsed.length - MAX_REQUESTS);
      if (toDelete.length > 0) {
        await redis.client.hdel(
          REDIS_KEY_REQUESTS,
          ...toDelete.map((e) => e.key)
        );
      }
    } catch (err) {
      console.error(`[TokenTracker] Redis trim error: ${err.message}`);
    }
  }

  /**
   * Bulk-save all models to Redis (used for seeding/init).
   */
  async function bulkSaveModelsToRedis() {
    if (!redis?.isReady()) return;

    try {
      const pipeline = redis.client.pipeline();
      for (const [model, counters] of Object.entries(models)) {
        pipeline.hset(REDIS_KEY_MODELS, model, JSON.stringify(counters));
      }
      await pipeline.exec();
    } catch (err) {
      console.error(
        `[TokenTracker] Redis bulk save error: ${err.message}`
      );
    }
  }

  // --------------------------------------------------
  // Core
  // --------------------------------------------------

  /**
   * Record tokens for a completed request.
   * @param {string} reqId
   * @param {string} model
   * @param {number} inputTokens
   * @param {number} outputTokens
   */
  function record(reqId, model, inputTokens, outputTokens) {
    // Update per-model cumulative (immutable)
    const prev = models[model] || { input: 0, output: 0, requests: 0 };
    const updated = Object.freeze({
      input: prev.input + inputTokens,
      output: prev.output + outputTokens,
      requests: prev.requests + 1,
    });
    models = { ...models, [model]: updated };

    // Store per-request snapshot
    const snapshot = Object.freeze({
      input: inputTokens,
      output: outputTokens,
      model,
      ts: Date.now(),
    });
    requests = new Map(requests);
    requests.set(reqId, snapshot);

    // Trim oldest if over limit
    if (requests.size > MAX_REQUESTS) {
      const keys = Array.from(requests.keys());
      const trimCount = requests.size - MAX_REQUESTS;
      requests = new Map(requests);
      for (let i = 0; i < trimCount; i++) {
        requests.delete(keys[i]);
      }
    }

    // Persist to Redis (fire-and-forget)
    saveModelToRedis(model, updated);
    saveRequestToRedis(reqId, snapshot);

    // Persist to file (debounced backup)
    scheduleFileSave();
  }

  /**
   * Get tokens recorded for a specific request.
   * @param {string} reqId
   * @returns {{ input: number, output: number, model: string } | null}
   */
  function getRequest(reqId) {
    return requests.get(reqId) || null;
  }

  /**
   * Get per-model summary.
   * @returns {{ [model]: { input, output, requests, total } }}
   */
  function getByModel() {
    const out = {};
    for (const [model, counters] of Object.entries(models)) {
      out[model] = {
        ...counters,
        total: counters.input + counters.output,
      };
    }
    return Object.freeze(out);
  }

  /**
   * Get grand totals across all models.
   * @returns {{ input: number, output: number, total: number, requests: number }}
   */
  function getTotals() {
    let input = 0;
    let output = 0;
    let reqs = 0;
    for (const counters of Object.values(models)) {
      input += counters.input;
      output += counters.output;
      reqs += counters.requests;
    }
    return Object.freeze({ input, output, total: input + output, requests: reqs });
  }

  /**
   * Get token usage within specific time windows.
   * Iterates per-request snapshots and sums tokens by window.
   *
   * @returns {{ last1h, last4h, last8h, thisWeek: { input, output, total, requests } }}
   */
  function getUsageByWindow() {
    const now = Date.now();
    const cutoffs = {
      last1h: now - 3600_000,
      last4h: now - 4 * 3600_000,
      last8h: now - 8 * 3600_000,
    };
    // This week = Monday 00:00 local time
    const d = new Date();
    const dayOfWeek = d.getDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysSinceMonday, 0, 0, 0);
    cutoffs.thisWeek = monday.getTime();

    const buckets = {};
    for (const key of Object.keys(cutoffs)) {
      buckets[key] = { input: 0, output: 0, total: 0, requests: 0 };
    }

    for (const [, snap] of requests) {
      const ts = snap.ts || 0;
      for (const [window, cutoff] of Object.entries(cutoffs)) {
        if (ts >= cutoff) {
          const b = buckets[window];
          buckets[window] = {
            input: b.input + (snap.input || 0),
            output: b.output + (snap.output || 0),
            total: b.total + (snap.input || 0) + (snap.output || 0),
            requests: b.requests + 1,
          };
        }
      }
    }

    return Object.freeze(buckets);
  }

  /**
   * Full stats for API/dashboard.
   */
  function getStats() {
    return Object.freeze({
      byModel: getByModel(),
      totals: getTotals(),
      usage: getUsageByWindow(),
    });
  }

  /**
   * Seed all-time totals from historical metrics snapshots.
   * Walks through snapshots chronologically, detects counter resets
   * (server restarts), and sums the peak from each session.
   *
   * @param {Array<{models: object}>} snapshots - Chronological list of raw snapshot points
   */
  function seedFromHistory(snapshots) {
    const totals = getTotals();
    if (totals.total > 0) return false; // already have data

    if (!Array.isArray(snapshots) || snapshots.length === 0) return false;

    const cumulative = {};
    const prevPeak = {};

    for (const snap of snapshots) {
      const snapModels = snap.models || {};
      for (const [model, data] of Object.entries(snapModels)) {
        const i = data.i || 0;
        const o = data.o || 0;
        const r = data.r || 0;
        const prev = prevPeak[model];

        if (prev) {
          if (i < prev.i || o < prev.o || r < prev.r) {
            const c = cumulative[model] || { input: 0, output: 0, requests: 0 };
            cumulative[model] = {
              input: c.input + prev.i,
              output: c.output + prev.o,
              requests: c.requests + prev.r,
            };
          }
        }

        prevPeak[model] = {
          i: prev ? Math.max(prev.i, i) : i,
          o: prev ? Math.max(prev.o, o) : o,
          r: prev ? Math.max(prev.r, r) : r,
        };

        if (prev && (i < prev.i || o < prev.o || r < prev.r)) {
          prevPeak[model] = { i, o, r };
        }
      }
    }

    for (const [model, peak] of Object.entries(prevPeak)) {
      const c = cumulative[model] || { input: 0, output: 0, requests: 0 };
      cumulative[model] = {
        input: c.input + peak.i,
        output: c.output + peak.o,
        requests: c.requests + peak.r,
      };
    }

    if (Object.keys(cumulative).length === 0) return false;

    const loaded = {};
    for (const [model, c] of Object.entries(cumulative)) {
      loaded[model] = Object.freeze({
        input: c.input,
        output: c.output,
        requests: c.requests,
      });
    }

    models = loaded;

    // Persist seeded data
    scheduleFileSave();
    bulkSaveModelsToRedis();

    const seeded = getTotals();
    console.log(
      `[TokenTracker] Seeded from history: ${seeded.total} tokens, ${seeded.requests} requests across ${Object.keys(models).length} models`
    );
    return true;
  }

  // --------------------------------------------------
  // Init: load from Redis first, fall back to file
  // --------------------------------------------------

  const ready = (async () => {
    const fromRedis = await loadFromRedis();
    if (fromRedis) {
      const totals = getTotals();
      console.log(
        `[TokenTracker] Loaded from Redis: ${totals.total} tokens, ${totals.requests} requests across ${Object.keys(models).length} models`
      );
      // Sync file backup
      scheduleFileSave();
      return;
    }

    const fromFile = await loadFromFile();
    if (fromFile) {
      const totals = getTotals();
      console.log(
        `[TokenTracker] Loaded from file: ${totals.total} tokens, ${totals.requests} requests across ${Object.keys(models).length} models`
      );
      // Migrate file data to Redis
      await bulkSaveModelsToRedis();
      return;
    }

    console.log("[TokenTracker] No historical data found, starting fresh");
  })();

  return Object.freeze({
    record,
    getRequest,
    getByModel,
    getTotals,
    getStats,
    seedFromHistory,
    ready,
  });
}
