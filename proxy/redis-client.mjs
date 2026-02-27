/**
 * Redis Client — Shared Connection for All Modules
 *
 * Single ioredis connection with key prefix "ccp:" (claude-code-proxy).
 * Graceful degradation: if Redis is unreachable, modules fall back to in-memory.
 *
 * Configurable via REDIS_URL environment variable.
 */

import Redis from "ioredis";

const DEFAULTS = Object.freeze({
  url: process.env.REDIS_URL || "redis://127.0.0.1:6379",
  keyPrefix: "ccp:",
  maxReconnectAttempts: 20,
  connectTimeout: 5000,
});

/**
 * Create a shared Redis client.
 * @param {object} [options]
 * @param {string} [options.url] - Redis URL (default: redis://127.0.0.1:6379)
 * @param {string} [options.keyPrefix] - Key prefix (default: "ccp:")
 * @returns {Promise<{client, isReady, quit, ping, prefix}>}
 */
export async function createRedisClient(options = {}) {
  const config = Object.freeze({ ...DEFAULTS, ...options });

  const client = new Redis(config.url, {
    keyPrefix: config.keyPrefix,
    lazyConnect: true,
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      if (times > config.maxReconnectAttempts) {
        console.error(`[Redis] Max reconnect attempts (${config.maxReconnectAttempts}) exceeded`);
        return null; // stop retrying
      }
      return Math.min(times * 200, 5000);
    },
    connectTimeout: config.connectTimeout,
    enableOfflineQueue: true, // queue commands during reconnect
  });

  let ready = false;

  client.on("ready", () => {
    ready = true;
    console.log("[Redis] Connected");
  });

  client.on("error", (err) => {
    // Only log non-connection errors (connection errors are handled by retryStrategy)
    if (err.code !== "ECONNREFUSED" && err.code !== "ECONNRESET") {
      console.error(`[Redis] Error: ${err.message}`);
    }
  });

  client.on("close", () => {
    ready = false;
  });

  client.on("reconnecting", (ms) => {
    console.log(`[Redis] Reconnecting in ${ms}ms...`);
  });

  await client.connect();

  return Object.freeze({
    client,
    isReady: () => ready,
    quit: () => client.quit(),
    ping: () => client.ping(),
    prefix: config.keyPrefix,
  });
}
