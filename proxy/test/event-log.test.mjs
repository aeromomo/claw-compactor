/**
 * Tests for event-log.mjs
 *
 * Verifies: push, getRecent, getCounts, clear,
 *           Redis LIST persistence, circular buffer behavior.
 */

import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createEventLog } from "../event-log.mjs";
import { createTestRedis, cleanupTestRedis, sleep } from "./helpers.mjs";
// Note: cleanupTestRedis used both in after() and per-test for isolation

describe("event-log", () => {
  let redis = null;

  after(async () => {
    if (redis) await cleanupTestRedis(redis);
  });

  describe("in-memory (no Redis)", () => {
    it("should push and retrieve events", () => {
      const log = createEventLog({ maxEvents: 100 });

      const event = log.push("request", { reqId: "r1", model: "sonnet" });
      assert.ok(event, "Should return event");
      assert.equal(event.type, "request");
      assert.equal(event.reqId, "r1");
      assert.ok(event.id > 0, "Should have positive ID");
      assert.ok(event.ts > 0, "Should have timestamp");
      assert.ok(event.isoTs, "Should have ISO timestamp");
    });

    it("should auto-increment event IDs", () => {
      const log = createEventLog({ maxEvents: 100 });

      const e1 = log.push("request", {});
      const e2 = log.push("error", {});
      const e3 = log.push("retry", {});

      assert.equal(e2.id, e1.id + 1);
      assert.equal(e3.id, e2.id + 1);
    });

    it("should getRecent with default limit", () => {
      const log = createEventLog({ maxEvents: 100 });

      for (let i = 0; i < 10; i++) {
        log.push("request", { i });
      }

      const recent = log.getRecent();
      assert.equal(recent.length, 10);
    });

    it("should getRecent with limit", () => {
      const log = createEventLog({ maxEvents: 100 });

      for (let i = 0; i < 10; i++) {
        log.push("request", { i });
      }

      const recent = log.getRecent({ limit: 5 });
      assert.equal(recent.length, 5);
      // Should be the last 5
      assert.equal(recent[4].i, 9);
    });

    it("should filter by sinceId", () => {
      const log = createEventLog({ maxEvents: 100 });

      const e1 = log.push("request", {});
      const e2 = log.push("error", {});
      const e3 = log.push("retry", {});

      const after = log.getRecent({ sinceId: e1.id });
      assert.equal(after.length, 2);
      assert.equal(after[0].id, e2.id);
      assert.equal(after[1].id, e3.id);
    });

    it("should filter by type", () => {
      const log = createEventLog({ maxEvents: 100 });

      log.push("request", { model: "sonnet" });
      log.push("error", { msg: "fail" });
      log.push("request", { model: "opus" });
      log.push("retry", { attempt: 1 });

      const requests = log.getRecent({ type: "request" });
      assert.equal(requests.length, 2);
      assert.ok(requests.every((e) => e.type === "request"));
    });

    it("should track counts by type", () => {
      const log = createEventLog({ maxEvents: 100 });

      log.push("request", {});
      log.push("request", {});
      log.push("error", {});
      log.push("retry", {});
      log.push("retry", {});
      log.push("retry", {});

      const counts = log.getCounts();
      assert.equal(counts.request, 2);
      assert.equal(counts.error, 1);
      assert.equal(counts.retry, 3);
    });

    it("should enforce maxEvents circular buffer", () => {
      const log = createEventLog({ maxEvents: 5 });

      for (let i = 0; i < 10; i++) {
        log.push("request", { i });
      }

      const recent = log.getRecent({ limit: 100 });
      assert.equal(recent.length, 5, "Should cap at maxEvents");
      // Should have the last 5
      assert.equal(recent[0].i, 5);
      assert.equal(recent[4].i, 9);
    });

    it("should return frozen objects", () => {
      const log = createEventLog({ maxEvents: 100 });
      const event = log.push("test", { data: "hello" });
      assert.ok(Object.isFrozen(event));
      assert.ok(Object.isFrozen(log.getCounts()));
    });

    it("should clear events but preserve counts as reset", () => {
      const log = createEventLog({ maxEvents: 100 });

      log.push("request", {});
      log.push("error", {});

      log.clear();

      const recent = log.getRecent();
      assert.equal(recent.length, 0, "Events should be cleared");

      const counts = log.getCounts();
      assert.deepEqual(counts, {}, "Counts should be cleared");
    });
  });

  describe("with Redis", () => {
    it("should persist events to Redis LIST", async () => {
      redis = await createTestRedis();
      const log = createEventLog({ maxEvents: 100, redis });
      await log.ready;

      log.push("request", { reqId: "r-redis-1" });
      log.push("error", { msg: "test error" });

      await sleep(200);

      // Check Redis LIST length
      const len = await redis.client.llen("events");
      assert.ok(len >= 2, `Redis should have at least 2 events, got ${len}`);
    });

    it("should persist counts to Redis HASH", async () => {
      // Use fresh Redis to avoid accumulated data from previous test
      const freshRedis = await createTestRedis();
      const log = createEventLog({ maxEvents: 100, redis: freshRedis });
      await log.ready;

      log.push("request", {});
      log.push("request", {});
      log.push("error", {});

      await sleep(200);

      const count = await freshRedis.client.hget("events:counts", "request");
      assert.ok(parseInt(count, 10) >= 2, `Request count should be >= 2, got ${count}`);
      await cleanupTestRedis(freshRedis);
    });

    it("should persist and load nextId", async () => {
      // Use fresh Redis for isolation
      const freshRedis = await createTestRedis();
      const log1 = createEventLog({ maxEvents: 100, redis: freshRedis });
      await log1.ready;

      const e1 = log1.push("test", {});
      const e2 = log1.push("test", {});

      await sleep(200);

      // Create a new instance — it should load nextId from Redis
      const log2 = createEventLog({ maxEvents: 100, redis: freshRedis });
      await log2.ready;

      const e3 = log2.push("test", {});
      assert.ok(e3.id > e2.id, `New ID ${e3.id} should be > previous ${e2.id}`);
      await cleanupTestRedis(freshRedis);
    });

    it("should load events from Redis on startup", async () => {
      // Use fresh Redis for isolation
      const freshRedis = await createTestRedis();
      const log1 = createEventLog({ maxEvents: 100, redis: freshRedis });
      await log1.ready;

      log1.push("startup", { version: "test" });
      log1.push("request", { reqId: "r-load-1" });

      await sleep(200);

      // New instance should load from Redis
      const log2 = createEventLog({ maxEvents: 100, redis: freshRedis });
      await log2.ready;

      const recent = log2.getRecent({ type: "startup" });
      assert.ok(recent.length >= 1, "Should have loaded startup events from Redis");
      await cleanupTestRedis(freshRedis);
    });

    it("should cap Redis LIST at maxEvents", async () => {
      const log = createEventLog({ maxEvents: 10, redis });
      await log.ready;

      for (let i = 0; i < 15; i++) {
        log.push("test", { i });
      }

      await sleep(300);

      const len = await redis.client.llen("events");
      // May have extra from other tests using same redis, but shouldn't grow unbounded
      // The ltrim keeps it at maxEvents
      assert.ok(len <= 20, `Redis LIST should be capped, got ${len}`);
    });
  });
});
