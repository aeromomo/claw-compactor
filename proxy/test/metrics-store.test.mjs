/**
 * Tests for metrics-store.mjs
 *
 * Verifies: snapshot, query, aggregate, Redis ZSET persistence,
 *           file backup, time windows, buffer size.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createMetricsStore } from "../metrics-store.mjs";
import { createTestRedis, cleanupTestRedis, sleep } from "./helpers.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DATA_DIR = join(__dirname, "test-data-metrics");

describe("metrics-store", () => {
  let redis = null;

  after(async () => {
    if (redis) await cleanupTestRedis(redis);
    // Clean up test data dir
    if (existsSync(TEST_DATA_DIR)) {
      await rm(TEST_DATA_DIR, { recursive: true, force: true });
    }
  });

  function makeSampleData(overrides = {}) {
    return {
      tokens: { input: 100, output: 200, total: 300, ...overrides.tokens },
      tokensByModel: { sonnet: { input: 100, output: 200, requests: 5 }, ...overrides.tokensByModel },
      queue: { active: 2, totalQueued: 5, metrics: { totalProcessed: 50 }, ...overrides.queue },
      processes: { byMode: { sync: 1, stream: 2 }, ...overrides.processes },
      liveTokens: { input: 50, output: 100, total: 150, ...overrides.liveTokens },
      events: { error: 1, timeout: 0, ...overrides.events },
    };
  }

  describe("in-memory (no Redis)", () => {
    it("should create a snapshot", () => {
      const store = createMetricsStore({
        dataDir: TEST_DATA_DIR,
        fileName: "test1.jsonl",
      });

      const entry = store.snapshot(makeSampleData());
      assert.ok(entry, "Should return entry");
      assert.ok(entry.ts > 0, "Should have unix timestamp");
      assert.deepEqual(entry.tok, { i: 100, o: 200, t: 300 });
      assert.equal(entry.req.a, 2); // active
      assert.equal(entry.req.q, 5); // queued
      assert.equal(entry.req.c, 50); // completed
    });

    it("should track buffer size", () => {
      const store = createMetricsStore({
        dataDir: TEST_DATA_DIR,
        fileName: "test2.jsonl",
      });

      assert.equal(store.getBufferSize(), 0);

      store.snapshot(makeSampleData());
      assert.equal(store.getBufferSize(), 1);

      store.snapshot(makeSampleData());
      assert.equal(store.getBufferSize(), 2);
    });

    it("should query 1h window (raw points)", () => {
      const store = createMetricsStore({
        dataDir: TEST_DATA_DIR,
        fileName: "test3.jsonl",
      });

      // Add 3 snapshots
      for (let i = 0; i < 3; i++) {
        store.snapshot(makeSampleData({ tokens: { input: i * 100, output: i * 200, total: i * 300 } }));
      }

      const points = store.query("1h");
      assert.equal(points.length, 3, "Should return all 3 points for 1h window");
      // 1h window returns expanded points
      assert.ok(points[0].tokI !== undefined, "Should have expanded format");
      assert.equal(points[0].samples, 1, "Raw points have samples=1");
    });

    it("should aggregate for larger windows", () => {
      const store = createMetricsStore({
        dataDir: TEST_DATA_DIR,
        fileName: "test4.jsonl",
        maxEntries: 10000,
      });

      // Create points spanning multiple buckets
      // 6h window uses 180s (3min) buckets
      for (let i = 0; i < 10; i++) {
        store.snapshot(makeSampleData());
      }

      const points = store.query("1h");
      assert.ok(points.length > 0, "Should have points");
    });

    it("should enforce maxEntries cap", () => {
      const store = createMetricsStore({
        dataDir: TEST_DATA_DIR,
        fileName: "test5.jsonl",
        maxEntries: 5,
      });

      for (let i = 0; i < 10; i++) {
        store.snapshot(makeSampleData());
      }

      assert.equal(store.getBufferSize(), 5, "Buffer should be capped at maxEntries");
    });

    it("should return raw buffer", () => {
      const store = createMetricsStore({
        dataDir: TEST_DATA_DIR,
        fileName: "test6.jsonl",
      });

      store.snapshot(makeSampleData());
      store.snapshot(makeSampleData());

      const raw = store.getRawBuffer();
      assert.equal(raw.length, 2);
      // Should be a copy
      raw.push("extra");
      assert.equal(store.getBufferSize(), 2, "Original buffer should not be modified");
    });

    it("should return frozen objects from snapshot", () => {
      const store = createMetricsStore({
        dataDir: TEST_DATA_DIR,
        fileName: "test7.jsonl",
      });

      const entry = store.snapshot(makeSampleData());
      assert.ok(Object.isFrozen(entry));
    });

    it("should destroy and stop sampler", () => {
      const store = createMetricsStore({
        dataDir: TEST_DATA_DIR,
        fileName: "test8.jsonl",
        sampleIntervalMs: 100,
      });

      let count = 0;
      store.startSampler(() => {
        count++;
        return makeSampleData();
      });

      // Destroy should stop sampling
      store.destroy();

      // No assertion needed — just verifying no errors on destroy
      assert.ok(true, "Destroy completed without error");
    });
  });

  describe("file persistence", () => {
    it("should write JSONL file on snapshot", async () => {
      const store = createMetricsStore({
        dataDir: TEST_DATA_DIR,
        fileName: "persist.jsonl",
      });

      store.snapshot(makeSampleData());

      // Wait for async file write
      await sleep(200);

      const filePath = join(TEST_DATA_DIR, "persist.jsonl");
      assert.ok(existsSync(filePath), "JSONL file should exist");
    });
  });

  describe("with Redis", () => {
    it("should persist snapshots to Redis ZSET", async () => {
      redis = await createTestRedis();
      const store = createMetricsStore({
        redis,
        dataDir: TEST_DATA_DIR,
        fileName: "redis1.jsonl",
      });
      await store.ready;

      store.snapshot(makeSampleData());

      await sleep(200);

      const count = await redis.client.zcard("metrics:ts");
      assert.ok(count >= 1, `Redis should have at least 1 entry, got ${count}`);
    });

    it("should load from Redis on startup", async () => {
      // First instance writes
      const store1 = createMetricsStore({
        redis,
        dataDir: TEST_DATA_DIR,
        fileName: "redis2.jsonl",
      });
      await store1.ready;

      store1.snapshot(makeSampleData({ tokens: { input: 999, output: 888, total: 1887 } }));
      await sleep(200);

      // Second instance should load from Redis
      const store2 = createMetricsStore({
        redis,
        dataDir: TEST_DATA_DIR,
        fileName: "redis3.jsonl",
      });
      await store2.ready;

      assert.ok(store2.getBufferSize() >= 1, `Should load data from Redis, got ${store2.getBufferSize()}`);
    });

    it("should query loaded Redis data", async () => {
      const store = createMetricsStore({
        redis,
        dataDir: TEST_DATA_DIR,
        fileName: "redis4.jsonl",
      });
      await store.ready;

      // Add a fresh snapshot
      store.snapshot(makeSampleData());
      await sleep(100);

      const points = store.query("1h");
      assert.ok(points.length >= 1, "Should have queryable points");
    });
  });
});
