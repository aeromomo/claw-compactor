/**
 * Fair Queue with Round-Robin Scheduling
 *
 * Ensures fair access when multiple OpenClaw instances share
 * one Claude Code proxy. Round-robin between sources,
 * priority support within each source's queue.
 *
 * All public methods return new objects (immutable pattern).
 * Internal state is encapsulated in closure.
 */

const PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };

export function createFairQueue(options = {}) {
  const {
    maxConcurrent = 10,
    maxPerSource = 20,
    maxTotal = 100,
    queueTimeoutMs = 60000,
    maxLeaseMs = 600_000,
  } = options;

  let activeCount = 0;
  let totalQueued = 0;
  const sourceQueues = new Map();
  let sourceOrder = [];
  let rrIndex = 0;

  // Lease tracking for slot leak detection
  let nextLeaseId = 0;
  let activeLeases = new Map(); // leaseId -> { sourceId, acquiredAt }

  // Metrics (cumulative)
  let metrics = {
    totalProcessed: 0,
    totalTimedOut: 0,
    totalRejected: 0,
    totalLeaked: 0,
    perSource: {},
  };

  // Periodic sweep for timed-out entries + leaked slots
  const sweepInterval = setInterval(() => {
    const now = Date.now();

    // Phase 1: Clean timed-out queue entries
    for (const [sourceId, entries] of sourceQueues) {
      const expired = entries.filter((e) => now - e.enqueuedAt > queueTimeoutMs);
      for (const entry of expired) {
        clearTimeout(entry.timer);
        entry.reject(new Error(`Queue timeout: waited ${queueTimeoutMs}ms`));
        totalQueued--;
        metrics = { ...metrics, totalTimedOut: metrics.totalTimedOut + 1 };
      }
      const remaining = entries.filter((e) => now - e.enqueuedAt <= queueTimeoutMs);
      if (remaining.length === 0) {
        sourceQueues.delete(sourceId);
        sourceOrder = sourceOrder.filter((id) => id !== sourceId);
      } else {
        sourceQueues.set(sourceId, remaining);
      }
    }

    // Phase 2: Detect and force-release leaked slots
    let leakedCount = 0;
    for (const [leaseId, lease] of activeLeases) {
      const held = now - lease.acquiredAt;
      if (held > maxLeaseMs) {
        console.warn(
          `[${new Date().toISOString()}] SLOT_LEAK leaseId=${leaseId} ` +
          `src=${lease.sourceId} held=${Math.round(held / 1000)}s, force-releasing`
        );
        activeLeases = new Map(activeLeases);
        activeLeases.delete(leaseId);
        activeCount--;
        leakedCount++;
      }
    }
    if (leakedCount > 0) {
      metrics = { ...metrics, totalLeaked: metrics.totalLeaked + leakedCount };
      tryDispatch();
    }
  }, 5000);

  function tryDispatch() {
    while (activeCount < maxConcurrent && totalQueued > 0) {
      const entry = dequeueNext();
      if (!entry) break;
      clearTimeout(entry.timer);
      activeCount++;
      totalQueued--;
      metrics = { ...metrics, totalProcessed: metrics.totalProcessed + 1 };

      // Track per-source
      const srcStats = metrics.perSource[entry.sourceId] || { processed: 0 };
      metrics = {
        ...metrics,
        perSource: {
          ...metrics.perSource,
          [entry.sourceId]: { ...srcStats, processed: srcStats.processed + 1 },
        },
      };

      const leaseId = nextLeaseId++;
      let released = false;
      activeLeases = new Map(activeLeases);
      activeLeases.set(leaseId, { sourceId: entry.sourceId, acquiredAt: Date.now() });

      entry.resolve(() => {
        if (released) return; // idempotent — double-release is a no-op
        released = true;
        // Guard: if SLOT_LEAK already force-released this lease, skip decrement
        if (activeLeases.has(leaseId)) {
          activeLeases = new Map(activeLeases);
          activeLeases.delete(leaseId);
          activeCount--;
        }
        tryDispatch();
      });
    }
  }

  function dequeueNext() {
    const activeSources = sourceOrder.filter((id) => {
      const q = sourceQueues.get(id);
      return q && q.length > 0;
    });

    if (activeSources.length === 0) return null;

    rrIndex = rrIndex % activeSources.length;
    const sourceId = activeSources[rrIndex];
    rrIndex = (rrIndex + 1) % Math.max(activeSources.length, 1);

    const queue = sourceQueues.get(sourceId);
    const entry = queue[0];
    const rest = queue.slice(1);

    if (rest.length === 0) {
      sourceQueues.delete(sourceId);
      sourceOrder = sourceOrder.filter((id) => id !== sourceId);
    } else {
      sourceQueues.set(sourceId, rest);
    }

    return { ...entry, sourceId };
  }

  /**
   * Acquire a processing slot. Returns a Promise that resolves
   * with a release() function when a slot is available.
   *
   * @param {string} sourceId - Identifier for the requesting source
   * @param {string} priority - "high" | "normal" | "low"
   * @returns {Promise<Function>} release function to call when done
   */
  function acquire(sourceId, priority = "normal") {
    // Fast path: slot available and nothing queued
    if (activeCount < maxConcurrent && totalQueued === 0) {
      activeCount++;
      metrics = { ...metrics, totalProcessed: metrics.totalProcessed + 1 };
      const srcStats = metrics.perSource[sourceId] || { processed: 0 };
      metrics = {
        ...metrics,
        perSource: {
          ...metrics.perSource,
          [sourceId]: { ...srcStats, processed: srcStats.processed + 1 },
        },
      };

      const leaseId = nextLeaseId++;
      let released = false;
      activeLeases = new Map(activeLeases);
      activeLeases.set(leaseId, { sourceId, acquiredAt: Date.now() });

      return Promise.resolve(() => {
        if (released) return; // idempotent — double-release is a no-op
        released = true;
        // Guard: if SLOT_LEAK already force-released this lease, skip decrement
        if (activeLeases.has(leaseId)) {
          activeLeases = new Map(activeLeases);
          activeLeases.delete(leaseId);
          activeCount--;
        }
        tryDispatch();
      });
    }

    // Check total queue limit
    if (totalQueued >= maxTotal) {
      metrics = { ...metrics, totalRejected: metrics.totalRejected + 1 };
      return Promise.reject(
        new Error(`Queue full: ${totalQueued}/${maxTotal} total`)
      );
    }

    // Check per-source limit
    const sourceQueue = sourceQueues.get(sourceId) || [];
    if (sourceQueue.length >= maxPerSource) {
      metrics = { ...metrics, totalRejected: metrics.totalRejected + 1 };
      return Promise.reject(
        new Error(`Source queue full: ${sourceQueue.length}/${maxPerSource} for ${sourceId}`)
      );
    }

    return new Promise((resolve, reject) => {
      const entry = {
        resolve,
        reject,
        priority,
        sourceId,
        enqueuedAt: Date.now(),
        timer: null,
      };

      entry.timer = setTimeout(() => {
        const q = sourceQueues.get(sourceId) || [];
        const filtered = q.filter((e) => e !== entry);
        if (filtered.length === 0) {
          sourceQueues.delete(sourceId);
          sourceOrder = sourceOrder.filter((id) => id !== sourceId);
        } else {
          sourceQueues.set(sourceId, filtered);
        }
        totalQueued--;
        metrics = { ...metrics, totalTimedOut: metrics.totalTimedOut + 1 };
        reject(new Error(`Queue timeout: waited ${queueTimeoutMs}ms`));
      }, queueTimeoutMs);

      // Insert sorted by priority within this source's queue
      const newQueue = [...sourceQueue, entry].sort(
        (a, b) => (PRIORITY_ORDER[a.priority] ?? 1) - (PRIORITY_ORDER[b.priority] ?? 1)
      );

      sourceQueues.set(sourceId, newQueue);

      if (!sourceOrder.includes(sourceId)) {
        sourceOrder = [...sourceOrder, sourceId];
      }

      totalQueued++;
      tryDispatch();
    });
  }

  function getStats() {
    const perSource = {};
    for (const [sourceId, entries] of sourceQueues) {
      perSource[sourceId] = entries.length;
    }

    const now = Date.now();
    const leaseList = Array.from(activeLeases.entries()).map(([id, lease]) => ({
      leaseId: id,
      sourceId: lease.sourceId,
      heldMs: now - lease.acquiredAt,
    }));

    return {
      active: activeCount,
      maxConcurrent,
      totalQueued,
      maxTotal,
      maxPerSource,
      queueTimeoutMs,
      maxLeaseMs,
      queuedPerSource: perSource,
      sourceCount: sourceQueues.size,
      activeLeases: leaseList,
      metrics: { ...metrics },
    };
  }

  function destroy() {
    clearInterval(sweepInterval);
    for (const entries of sourceQueues.values()) {
      for (const entry of entries) {
        clearTimeout(entry.timer);
        entry.reject(new Error("Queue destroyed"));
      }
    }
    sourceQueues.clear();
    sourceOrder = [];
    totalQueued = 0;
  }

  return { acquire, getStats, destroy };
}
