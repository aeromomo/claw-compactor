/**
 * Event Log — Persistent Circular Buffer for Monitoring
 *
 * Captures proxy events (requests, retries, reaps, timeouts, kills)
 * in a fixed-size circular buffer. Persists to Redis LIST.
 *
 * Redis keys (with ccp: prefix):
 *   events        — LIST of JSON event objects (capped at maxEvents via LTRIM)
 *   events:nextId — STRING atomic counter via INCR
 *   events:counts — HASH { type: count } via HINCRBY
 *
 * All public methods return new objects (immutable pattern).
 */

const DEFAULTS = Object.freeze({
  maxEvents: 500,
});

const REDIS_KEY_EVENTS = "events";
const REDIS_KEY_NEXT_ID = "events:nextId";
const REDIS_KEY_COUNTS = "events:counts";

/**
 * @param {object} [options]
 * @param {number} [options.maxEvents]
 * @param {object} [options.redis] - Redis client from redis-client.mjs
 */
export function createEventLog(options = {}) {
  const { redis, ...rest } = options;
  const config = Object.freeze({ ...DEFAULTS, ...rest });

  // In-memory state (always maintained)
  let events = [];
  let nextId = 1;
  let counts = {};

  // --------------------------------------------------
  // Redis persistence
  // --------------------------------------------------

  async function loadFromRedis() {
    if (!redis?.isReady()) return false;

    try {
      // Load next ID
      const rawId = await redis.client.get(REDIS_KEY_NEXT_ID);
      if (rawId) {
        nextId = parseInt(rawId, 10) + 1;
      }

      // Load event counts
      const rawCounts = await redis.client.hgetall(REDIS_KEY_COUNTS);
      if (rawCounts && Object.keys(rawCounts).length > 0) {
        const loaded = {};
        for (const [type, count] of Object.entries(rawCounts)) {
          loaded[type] = parseInt(count, 10) || 0;
        }
        counts = loaded;
      }

      // Load recent events (most recent first in Redis, reverse for our array)
      const rawEvents = await redis.client.lrange(
        REDIS_KEY_EVENTS,
        0,
        config.maxEvents - 1
      );
      if (rawEvents && rawEvents.length > 0) {
        const loaded = [];
        for (const raw of rawEvents) {
          try {
            loaded.push(Object.freeze(JSON.parse(raw)));
          } catch {
            // skip malformed
          }
        }
        // Redis LIST: LPUSH means newest first, we want oldest first
        events = loaded.reverse();
      }

      return events.length > 0 || Object.keys(counts).length > 0;
    } catch (err) {
      console.error(`[EventLog] Redis load error: ${err.message}`);
      return false;
    }
  }

  /**
   * Persist a single event to Redis (fire-and-forget).
   */
  function pushToRedis(event) {
    if (!redis?.isReady()) return;

    const pipeline = redis.client.pipeline();
    // Push to front of list (newest first)
    pipeline.lpush(REDIS_KEY_EVENTS, JSON.stringify(event));
    // Trim to max size
    pipeline.ltrim(REDIS_KEY_EVENTS, 0, config.maxEvents - 1);
    // Increment type counter
    pipeline.hincrby(REDIS_KEY_COUNTS, event.type, 1);
    // Update next ID tracker
    pipeline.set(REDIS_KEY_NEXT_ID, String(event.id));

    pipeline.exec().catch((err) => {
      console.error(`[EventLog] Redis push error: ${err.message}`);
    });
  }

  // --------------------------------------------------
  // Core
  // --------------------------------------------------

  /**
   * Push a new event into the log.
   * @param {string} type - Event type (request, retry, reap, timeout, kill, error, etc.)
   * @param {object} data - Event-specific data
   * @returns {object} The created event (frozen)
   */
  function push(type, data = {}) {
    const event = Object.freeze({
      id: nextId++,
      type,
      ts: Date.now(),
      isoTs: new Date().toISOString(),
      ...data,
    });

    // Immutable append with size cap
    events =
      events.length >= config.maxEvents
        ? [...events.slice(events.length - config.maxEvents + 1), event]
        : [...events, event];

    // Update counts
    counts = { ...counts, [type]: (counts[type] || 0) + 1 };

    // Persist to Redis
    pushToRedis(event);

    return event;
  }

  /**
   * Get recent events, optionally filtered.
   * @param {object} [opts]
   * @param {number} [opts.limit] - Max events to return (default: 50)
   * @param {number} [opts.sinceId] - Only return events after this ID
   * @param {string} [opts.type] - Filter by event type
   * @returns {object[]} Array of events (newest last)
   */
  function getRecent(opts = {}) {
    const { limit = 50, sinceId = 0, type = null } = opts;

    let filtered = events;
    if (sinceId > 0) {
      filtered = filtered.filter((e) => e.id > sinceId);
    }
    if (type) {
      filtered = filtered.filter((e) => e.type === type);
    }

    return filtered.slice(-limit);
  }

  /**
   * Get summary counts by event type.
   * @returns {object} { [type]: count }
   */
  function getCounts() {
    return Object.freeze({ ...counts });
  }

  /**
   * Clear all events (in-memory + Redis).
   */
  function clear() {
    events = [];
    counts = {};

    if (redis?.isReady()) {
      const pipeline = redis.client.pipeline();
      pipeline.del(REDIS_KEY_EVENTS);
      pipeline.del(REDIS_KEY_COUNTS);
      // Don't reset nextId — IDs should be monotonic
      pipeline.exec().catch((err) => {
        console.error(`[EventLog] Redis clear error: ${err.message}`);
      });
    }
  }

  // --------------------------------------------------
  // Init: load from Redis
  // --------------------------------------------------

  const ready = (async () => {
    const loaded = await loadFromRedis();
    if (loaded) {
      console.log(
        `[EventLog] Loaded from Redis: ${events.length} events, ${Object.keys(counts).length} types`
      );
    } else {
      console.log("[EventLog] Starting fresh (no Redis data)");
    }
  })();

  return Object.freeze({
    push,
    getRecent,
    getCounts,
    clear,
    ready,
    config,
  });
}
