/**
 * Test Helpers — Shared Redis setup/teardown for all tests.
 *
 * Each call to createTestRedis() generates a unique prefix so
 * concurrent test files don't interfere with each other.
 */

import Redis from "ioredis";

let counter = 0;

/**
 * Create a Redis client with a unique test-specific key prefix.
 * Each invocation gets its own prefix to avoid cross-test interference.
 * @returns {{ client, isReady, quit, ping, prefix }}
 */
export async function createTestRedis() {
  const prefix = `ccp:test:${Date.now()}:${++counter}:`;

  const client = new Redis("redis://127.0.0.1:6379", {
    keyPrefix: prefix,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    enableOfflineQueue: false,
  });

  let ready = false;

  client.on("ready", () => { ready = true; });
  client.on("close", () => { ready = false; });

  await client.connect();

  return Object.freeze({
    client,
    isReady: () => ready,
    quit: () => client.quit(),
    ping: () => client.ping(),
    prefix,
  });
}

/**
 * Clean up all test keys from Redis for a specific client.
 * Uses SCAN to find and delete keys with that client's unique prefix.
 */
export async function cleanupTestRedis(redis) {
  if (!redis?.isReady()) return;

  const prefix = redis.prefix;

  try {
    // Use raw client (without prefix) to scan for prefixed keys
    const rawClient = new Redis("redis://127.0.0.1:6379", {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    await rawClient.connect();

    let cursor = "0";
    do {
      const [nextCursor, keys] = await rawClient.scan(
        cursor,
        "MATCH",
        `${prefix}*`,
        "COUNT",
        100,
      );
      cursor = nextCursor;
      if (keys.length > 0) {
        await rawClient.del(...keys);
      }
    } while (cursor !== "0");

    await rawClient.quit();
  } catch (err) {
    console.error(`[TestHelper] Cleanup error: ${err.message}`);
  }

  await redis.quit();
}

/**
 * Create a mock Redis that always reports not ready.
 * Used for testing graceful fallback behavior.
 */
export function createMockDisabledRedis() {
  return Object.freeze({
    client: null,
    isReady: () => false,
    quit: async () => {},
    ping: async () => { throw new Error("Redis disabled"); },
    prefix: "ccp:mock:",
  });
}

/**
 * Sleep helper.
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
