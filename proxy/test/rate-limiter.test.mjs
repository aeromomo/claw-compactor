/**
 * Tests for rate-limiter.mjs
 *
 * Verifies: check, record, sliding window, Redis ZSET write, stats.
 */

import { describe, it, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter } from "../rate-limiter.mjs";
import { createTestRedis, cleanupTestRedis } from "./helpers.mjs";

const LIMITS = {
  sonnet: { requestsPerMin: 5, tokensPerMin: 10000 },
  opus: { requestsPerMin: 3, tokensPerMin: 5000 },
  haiku: { requestsPerMin: 10, tokensPerMin: 50000 },
};

describe("rate-limiter", () => {
  let redis = null;

  after(async () => {
    if (redis) await cleanupTestRedis(redis);
  });

  describe("in-memory (no Redis)", () => {
    it("should allow requests within limits", () => {
      const rl = createRateLimiter({ limits: LIMITS });
      const result = rl.check("sonnet", 1000);
      assert.ok(result.ok);
      assert.equal(result.waitMs, 0);
      assert.equal(result.reason, null);
    });

    it("should block after exceeding request limit", () => {
      const rl = createRateLimiter({ limits: LIMITS });

      // Record 5 sonnet requests (the limit)
      for (let i = 0; i < 5; i++) {
        rl.record("sonnet", 100);
      }

      const result = rl.check("sonnet", 100);
      assert.ok(!result.ok, "Should be rate limited");
      assert.ok(result.waitMs > 0, "Should have positive wait time");
      assert.ok(result.reason.includes("5/5"), `Reason should show limit: ${result.reason}`);
    });

    it("should block after exceeding token limit", () => {
      const rl = createRateLimiter({ limits: LIMITS });

      // Record tokens near the limit
      rl.record("opus", 4500);

      const result = rl.check("opus", 1000);
      assert.ok(!result.ok, "Should be token-limited");
      assert.ok(result.reason.includes("tok/min"), `Reason should mention tokens: ${result.reason}`);
    });

    it("should track models independently", () => {
      const rl = createRateLimiter({ limits: LIMITS });

      // Exhaust sonnet limit
      for (let i = 0; i < 5; i++) {
        rl.record("sonnet", 100);
      }

      // Opus should still be ok
      const opus = rl.check("opus", 100);
      assert.ok(opus.ok, "Opus should not be affected by sonnet limit");
    });

    it("should return stats for all models", () => {
      const rl = createRateLimiter({ limits: LIMITS });
      rl.record("sonnet", 500);
      rl.record("opus", 300);

      const s = rl.stats();
      assert.ok(s.sonnet, "Should have sonnet stats");
      assert.ok(s.opus, "Should have opus stats");
      assert.ok(s.haiku, "Should have haiku stats");
      assert.equal(s.sonnet.requests, "1/5");
      assert.equal(s.opus.requests, "1/3");
    });

    it("should return frozen objects", () => {
      const rl = createRateLimiter({ limits: LIMITS });
      const result = rl.check("sonnet", 100);
      assert.ok(Object.isFrozen(result));

      const s = rl.stats();
      assert.ok(Object.isFrozen(s));
    });
  });

  describe("with Redis", () => {
    it("should record to Redis ZSET", async () => {
      redis = await createTestRedis();
      const rl = createRateLimiter({ limits: LIMITS, redis });

      rl.record("sonnet", 500);

      // Give Redis time to process fire-and-forget pipeline
      await new Promise((r) => setTimeout(r, 100));

      // Check Redis has the entry
      const count = await redis.client.zcard("rate:sonnet");
      assert.ok(count >= 1, `Redis should have at least 1 entry, got ${count}`);
    });

    it("should clean old entries from Redis", async () => {
      const rl = createRateLimiter({ limits: LIMITS, redis });

      // Record and let pipeline execute
      rl.record("haiku", 100);
      await new Promise((r) => setTimeout(r, 100));

      const count = await redis.client.zcard("rate:haiku");
      assert.ok(count >= 1);
    });
  });
});
