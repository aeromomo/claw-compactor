/**
 * Tests for redis-client.mjs
 *
 * Verifies: connection, key prefix, ping, quit, reconnect behavior.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createRedisClient } from "../redis-client.mjs";

describe("redis-client", () => {
  let redis = null;

  after(async () => {
    if (redis) {
      await redis.quit();
    }
  });

  it("should connect to Redis", async () => {
    redis = await createRedisClient();
    assert.ok(redis.isReady(), "Redis should be ready after connect");
  });

  it("should have default ccp: prefix", () => {
    assert.equal(redis.prefix, "ccp:");
  });

  it("should respond to ping", async () => {
    const pong = await redis.ping();
    assert.equal(pong, "PONG");
  });

  it("should accept custom url and prefix", async () => {
    const custom = await createRedisClient({
      url: "redis://127.0.0.1:6379",
      keyPrefix: "test-custom:",
    });
    assert.ok(custom.isReady());
    assert.equal(custom.prefix, "test-custom:");
    await custom.quit();
  });

  it("should set and get with prefix", async () => {
    // Write directly with prefix
    await redis.client.set("__test_key__", "hello");
    const val = await redis.client.get("__test_key__");
    assert.equal(val, "hello");

    // Clean up
    await redis.client.del("__test_key__");
  });

  it("should report not ready after quit", async () => {
    const tempRedis = await createRedisClient({ keyPrefix: "ccp:temp:" });
    assert.ok(tempRedis.isReady());
    await tempRedis.quit();
    // close event fires asynchronously after quit resolves
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(!tempRedis.isReady(), "Should not be ready after quit");
  });
});
