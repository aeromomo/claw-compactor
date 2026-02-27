/**
 * Integration Tests — End-to-End Redis Module Interaction
 *
 * Verifies that all modules work together with a shared Redis connection,
 * and that graceful degradation works when Redis is unavailable.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createTokenTracker } from "../token-tracker.mjs";
import { createEventLog } from "../event-log.mjs";
import { createMetricsStore } from "../metrics-store.mjs";
import { createProcessRegistry } from "../process-registry.mjs";
import { createRateLimiter } from "../rate-limiter.mjs";
import { createTestRedis, cleanupTestRedis, createMockDisabledRedis, sleep } from "./helpers.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DATA_DIR = join(__dirname, "test-data-integration");

const RATE_LIMITS = {
  sonnet: { requestsPerMin: 50, tokensPerMin: 100000 },
  opus: { requestsPerMin: 25, tokensPerMin: 50000 },
};

describe("integration", () => {
  let redis = null;

  after(async () => {
    if (redis) await cleanupTestRedis(redis);
    if (existsSync(TEST_DATA_DIR)) {
      await rm(TEST_DATA_DIR, { recursive: true, force: true });
    }
  });

  describe("all modules with shared Redis", () => {
    it("should initialize all modules with same Redis connection", async () => {
      redis = await createTestRedis();

      const tokenTracker = createTokenTracker({ redis });
      const eventLog = createEventLog({ maxEvents: 100, redis });
      const metricsStore = createMetricsStore({ redis, dataDir: TEST_DATA_DIR, fileName: "int1.jsonl" });
      const registry = createProcessRegistry({ redis, reaperIntervalMs: 999999 });
      const rateLimiter = createRateLimiter({ limits: RATE_LIMITS, redis });

      // Wait for all to load from Redis
      await Promise.all([
        tokenTracker.ready,
        eventLog.ready,
        metricsStore.ready,
        registry.ready,
      ]);

      assert.ok(true, "All modules initialized successfully");

      registry.destroy();
      metricsStore.destroy();
    });

    it("should simulate a complete request lifecycle", async () => {
      const tokenTracker = createTokenTracker({ redis });
      const eventLog = createEventLog({ maxEvents: 100, redis });
      const metricsStore = createMetricsStore({ redis, dataDir: TEST_DATA_DIR, fileName: "int2.jsonl" });
      const registry = createProcessRegistry({ redis, reaperIntervalMs: 999999 });
      const rateLimiter = createRateLimiter({ limits: RATE_LIMITS, redis });

      await Promise.all([
        tokenTracker.ready,
        eventLog.ready,
        metricsStore.ready,
        registry.ready,
      ]);

      const reqId = "integ-req-1";
      const model = "sonnet";
      const source = "test-node";
      const fakePid = 800001;

      // 1. Rate limit check
      const rateCheck = rateLimiter.check(model, 500);
      assert.ok(rateCheck.ok, "Request should pass rate limit");

      // 2. Record rate limit usage
      rateLimiter.record(model, 500);

      // 3. Log request event
      const reqEvent = eventLog.push("request", {
        reqId,
        model,
        source,
        mode: "stream",
      });
      assert.equal(reqEvent.type, "request");

      // 4. Register process
      const entry = registry.register({
        pid: fakePid,
        requestId: reqId,
        model,
        mode: "stream",
        source,
        promptPreview: "Test integration prompt",
      });
      assert.equal(entry.pid, fakePid);

      // 5. Touch with live tokens (simulating streaming)
      registry.touch(fakePid, { liveInputTokens: 200, liveOutputTokens: 500 });

      // 6. Record final tokens
      tokenTracker.record(reqId, model, 200, 500);

      // 7. Log completion event
      eventLog.push("complete", {
        reqId,
        model,
        source,
        mode: "stream",
        inputTokens: 200,
        outputTokens: 500,
      });

      // 8. Unregister process
      registry.unregister(fakePid);

      // 9. Take metrics snapshot
      const snapshot = metricsStore.snapshot({
        tokens: tokenTracker.getTotals(),
        tokensByModel: tokenTracker.getByModel(),
        queue: { active: 0, totalQueued: 0, metrics: { totalProcessed: 1 } },
        processes: registry.getStats(),
        liveTokens: { input: 0, output: 0, total: 0 },
        events: eventLog.getCounts(),
      });
      assert.ok(snapshot.ts > 0);

      // Verify final state
      const totals = tokenTracker.getTotals();
      assert.ok(totals.input >= 200, `Input tokens should be >= 200, got ${totals.input}`);
      assert.ok(totals.output >= 500, `Output tokens should be >= 500, got ${totals.output}`);

      const counts = eventLog.getCounts();
      assert.ok(counts.request >= 1);
      assert.ok(counts.complete >= 1);

      const procStats = registry.getStats();
      assert.equal(procStats.total, 0, "No processes after unregister");
      assert.ok(procStats.metrics.totalRegistered >= 1);

      registry.destroy();
      metricsStore.destroy();
    });

    it("should persist and reload state across instances", async () => {
      // Phase 1: Write data
      const tt1 = createTokenTracker({ redis });
      const el1 = createEventLog({ maxEvents: 100, redis });

      await Promise.all([tt1.ready, el1.ready]);

      tt1.record("persist-req-1", "opus", 1000, 2000);
      el1.push("request", { reqId: "persist-req-1", model: "opus" });
      el1.push("complete", { reqId: "persist-req-1", model: "opus" });

      await sleep(300);

      // Phase 2: Create new instances (simulating server restart)
      const tt2 = createTokenTracker({ redis });
      const el2 = createEventLog({ maxEvents: 100, redis });

      await Promise.all([tt2.ready, el2.ready]);

      // Should have loaded data from Redis
      const totals = tt2.getByModel();
      assert.ok(totals.opus, "Should have opus data from Redis");
      assert.ok(totals.opus.input >= 1000, `Opus input should be >= 1000, got ${totals.opus.input}`);

      const events = el2.getRecent({ type: "complete" });
      assert.ok(events.length >= 1, "Should have complete events from Redis");
    });
  });

  describe("graceful degradation (no Redis)", () => {
    it("should work with disabled Redis", async () => {
      const disabled = createMockDisabledRedis();

      const tokenTracker = createTokenTracker({ redis: disabled });
      const eventLog = createEventLog({ maxEvents: 50, redis: disabled });
      const metricsStore = createMetricsStore({
        redis: disabled,
        dataDir: TEST_DATA_DIR,
        fileName: "fallback.jsonl",
      });
      const registry = createProcessRegistry({
        redis: disabled,
        reaperIntervalMs: 999999,
      });
      const rateLimiter = createRateLimiter({ limits: RATE_LIMITS, redis: disabled });

      await Promise.all([
        tokenTracker.ready,
        eventLog.ready,
        metricsStore.ready,
        registry.ready,
      ]);

      // Capture baseline (may have loaded from file fallback)
      const baseline = tokenTracker.getTotals().total;

      // All operations should work in-memory
      tokenTracker.record("fb-req-1", "sonnet", 100, 200);
      eventLog.push("request", { reqId: "fb-req-1" });

      const fakePid = 700001;
      registry.register({
        pid: fakePid,
        requestId: "fb-req-1",
        model: "sonnet",
        mode: "sync",
        source: "fallback-test",
      });

      rateLimiter.record("sonnet", 100);
      rateLimiter.check("sonnet", 100);

      metricsStore.snapshot({
        tokens: tokenTracker.getTotals(),
        tokensByModel: tokenTracker.getByModel(),
        queue: { active: 0, totalQueued: 0, metrics: { totalProcessed: 1 } },
        processes: registry.getStats(),
        liveTokens: { input: 0, output: 0, total: 0 },
        events: eventLog.getCounts(),
      });

      // Verify: tokens increased by 300 from baseline (may have pre-existing file data)
      assert.equal(tokenTracker.getTotals().total, baseline + 300);
      assert.equal(eventLog.getRecent().length, 1);
      assert.equal(registry.getAll().length, 1);
      assert.equal(metricsStore.getBufferSize(), 1);

      registry.unregister(fakePid);
      registry.destroy();
      metricsStore.destroy();
    });

    it("should handle null redis gracefully", async () => {
      const tokenTracker = createTokenTracker({ redis: null });
      const eventLog = createEventLog({ maxEvents: 50, redis: null });

      await Promise.all([tokenTracker.ready, eventLog.ready]);

      // Capture baseline (may have loaded from file fallback)
      const baseline = tokenTracker.getTotals().total;

      tokenTracker.record("null-1", "haiku", 50, 75);
      eventLog.push("test", { data: "null redis" });

      assert.equal(tokenTracker.getTotals().total, baseline + 125);
      assert.equal(eventLog.getRecent().length, 1);
    });
  });

  describe("concurrent operations", () => {
    it("should handle multiple rapid records without errors", async () => {
      const tt = createTokenTracker({ redis });
      await tt.ready;

      // Simulate burst of 50 concurrent requests
      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(
          Promise.resolve().then(() => {
            tt.record(`burst-${i}`, i % 2 === 0 ? "sonnet" : "opus", 100, 200);
          }),
        );
      }
      await Promise.all(promises);

      const totals = tt.getTotals();
      assert.ok(totals.requests >= 50, `Should have at least 50 requests, got ${totals.requests}`);
    });

    it("should handle rapid event pushes", async () => {
      const el = createEventLog({ maxEvents: 200, redis });
      await el.ready;

      for (let i = 0; i < 100; i++) {
        el.push("burst", { i });
      }

      const counts = el.getCounts();
      assert.ok(counts.burst >= 100, `Should have at least 100 burst events, got ${counts.burst}`);
    });
  });
});
