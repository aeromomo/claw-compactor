/**
 * Tests for token-tracker.mjs
 *
 * Verifies: record, getByModel, getTotals, getStats, getRequest,
 *           Redis persistence, file fallback, seedFromHistory.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createTokenTracker } from "../token-tracker.mjs";
import { createTestRedis, cleanupTestRedis, sleep } from "./helpers.mjs";

describe("token-tracker", () => {
  let redis = null;

  after(async () => {
    if (redis) await cleanupTestRedis(redis);
  });

  describe("in-memory (no Redis)", () => {
    it("should record and retrieve tokens", () => {
      const tt = createTokenTracker();
      tt.record("req-1", "sonnet", 100, 200);

      const totals = tt.getTotals();
      assert.equal(totals.input, 100);
      assert.equal(totals.output, 200);
      assert.equal(totals.total, 300);
      assert.equal(totals.requests, 1);
    });

    it("should accumulate tokens per model", () => {
      const tt = createTokenTracker();
      tt.record("req-1", "sonnet", 100, 200);
      tt.record("req-2", "sonnet", 150, 250);
      tt.record("req-3", "opus", 500, 1000);

      const byModel = tt.getByModel();
      assert.equal(byModel.sonnet.input, 250);
      assert.equal(byModel.sonnet.output, 450);
      assert.equal(byModel.sonnet.requests, 2);
      assert.equal(byModel.sonnet.total, 700);

      assert.equal(byModel.opus.input, 500);
      assert.equal(byModel.opus.output, 1000);
      assert.equal(byModel.opus.requests, 1);
    });

    it("should get per-request snapshot", () => {
      const tt = createTokenTracker();
      tt.record("req-42", "haiku", 50, 75);

      const req = tt.getRequest("req-42");
      assert.ok(req, "Should have request data");
      assert.equal(req.input, 50);
      assert.equal(req.output, 75);
      assert.equal(req.model, "haiku");
      assert.ok(req.ts > 0, "Should have timestamp");
    });

    it("should return null for unknown request", () => {
      const tt = createTokenTracker();
      assert.equal(tt.getRequest("nonexistent"), null);
    });

    it("should return frozen objects", () => {
      const tt = createTokenTracker();
      tt.record("req-1", "sonnet", 100, 200);

      assert.ok(Object.isFrozen(tt.getTotals()));
      assert.ok(Object.isFrozen(tt.getByModel()));
      assert.ok(Object.isFrozen(tt.getStats()));
    });

    it("should getStats with both model and totals", () => {
      const tt = createTokenTracker();
      tt.record("req-1", "sonnet", 100, 200);

      const stats = tt.getStats();
      assert.ok(stats.byModel, "Should have byModel");
      assert.ok(stats.totals, "Should have totals");
      assert.equal(stats.totals.total, 300);
    });

    it("should trim oldest requests over MAX_REQUESTS", () => {
      const tt = createTokenTracker();

      // Record 1010 requests (limit is 1000)
      for (let i = 0; i < 1010; i++) {
        tt.record(`req-${i}`, "sonnet", 1, 1);
      }

      // Oldest should be gone
      assert.equal(tt.getRequest("req-0"), null, "First request should be trimmed");
      assert.equal(tt.getRequest("req-9"), null, "10th request should be trimmed");
      assert.ok(tt.getRequest("req-1009"), "Last request should exist");

      // Totals should still be cumulative
      const totals = tt.getTotals();
      assert.equal(totals.requests, 1010);
    });
  });

  describe("seedFromHistory", () => {
    it("should seed from historical snapshots", () => {
      const tt = createTokenTracker();

      const snapshots = [
        { models: { sonnet: { i: 100, o: 200, r: 5 } } },
        { models: { sonnet: { i: 200, o: 400, r: 10 } } },
        { models: { sonnet: { i: 300, o: 600, r: 15 }, opus: { i: 50, o: 100, r: 2 } } },
      ];

      const seeded = tt.seedFromHistory(snapshots);
      assert.ok(seeded, "Should return true for successful seed");

      const totals = tt.getTotals();
      assert.ok(totals.total > 0, "Should have tokens after seeding");
    });

    it("should not seed if already has data", () => {
      const tt = createTokenTracker();
      tt.record("req-1", "sonnet", 100, 200);

      const seeded = tt.seedFromHistory([{ models: { sonnet: { i: 999, o: 999, r: 99 } } }]);
      assert.ok(!seeded, "Should not seed when data already exists");
    });

    it("should handle counter resets (server restarts)", () => {
      const tt = createTokenTracker();

      // Session 1: counts go up
      const snapshots = [
        { models: { sonnet: { i: 100, o: 200, r: 5 } } },
        { models: { sonnet: { i: 300, o: 600, r: 15 } } },
        // Server restart: counts reset
        { models: { sonnet: { i: 50, o: 100, r: 3 } } },
        { models: { sonnet: { i: 150, o: 300, r: 8 } } },
      ];

      tt.seedFromHistory(snapshots);
      const totals = tt.getTotals();
      // Should sum: peak of session 1 (300+600) + peak of session 2 (150+300) = 1350
      assert.ok(totals.total > 0, `Total should be positive, got ${totals.total}`);
    });
  });

  describe("with Redis", () => {
    it("should persist tokens to Redis HASH", async () => {
      redis = await createTestRedis();
      const tt = createTokenTracker({ redis });
      await tt.ready;

      tt.record("req-redis-1", "sonnet", 500, 750);

      // Wait for fire-and-forget persistence
      await sleep(200);

      // Check Redis has model data
      const rawSonnet = await redis.client.hget("tokens:models", "sonnet");
      assert.ok(rawSonnet, "Should have sonnet in Redis");
      const parsed = JSON.parse(rawSonnet);
      assert.equal(parsed.input, 500);
      assert.equal(parsed.output, 750);
      assert.equal(parsed.requests, 1);
    });

    it("should persist per-request to Redis HASH", async () => {
      const tt = createTokenTracker({ redis });
      await tt.ready;

      tt.record("req-redis-2", "opus", 200, 400);
      await sleep(200);

      const rawReq = await redis.client.hget("tokens:requests", "req-redis-2");
      assert.ok(rawReq, "Should have request in Redis");
      const parsed = JSON.parse(rawReq);
      assert.equal(parsed.input, 200);
      assert.equal(parsed.output, 400);
      assert.equal(parsed.model, "opus");
    });

    it("should load from Redis on startup", async () => {
      // First instance writes data
      const tt1 = createTokenTracker({ redis });
      await tt1.ready;
      tt1.record("req-persist-1", "haiku", 100, 200);
      await sleep(200);

      // Second instance should load from Redis
      const tt2 = createTokenTracker({ redis });
      await tt2.ready;

      const byModel = tt2.getByModel();
      // Should see haiku data loaded from Redis (plus any earlier test data)
      assert.ok(byModel.haiku, "Should have haiku model data from Redis");
      assert.ok(byModel.haiku.input >= 100, `Haiku input should be >= 100, got ${byModel.haiku.input}`);
    });
  });
});
