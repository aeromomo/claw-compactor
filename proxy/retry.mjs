/**
 * Retry Policy — Exponential Backoff + Jitter
 *
 * Generic retry logic for both sync and stream paths.
 * Classifies errors as retryable vs permanent.
 * Computes delays with exponential backoff and random jitter.
 *
 * All public methods return new objects (immutable pattern).
 */

const DEFAULTS = Object.freeze({
  maxRetries: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 30_000,
  jitterFactor: 0.3,
  retryablePatterns: Object.freeze([
    /overloaded/i,
    /rate.?limit/i,
    /timeout/i,
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /EPIPE/i,
    /529/,
    /503/,
    /too many/i,
  ]),
  retryableExitCodes: Object.freeze([1, 2]),
});

function ts() {
  return new Date().toISOString();
}

/**
 * @param {object} options
 * @param {number} [options.maxRetries]
 * @param {number} [options.baseDelayMs]
 * @param {number} [options.maxDelayMs]
 * @param {number} [options.jitterFactor]
 * @param {RegExp[]} [options.retryablePatterns]
 * @param {number[]} [options.retryableExitCodes]
 */
export function createRetryPolicy(options = {}) {
  const config = Object.freeze({
    ...DEFAULTS,
    ...options,
  });

  /**
   * Compute delay for the given attempt (0-indexed).
   * Formula: min(base * 2^attempt, max) * (1 + random * jitter)
   * @param {number} attempt
   * @returns {number} delay in ms
   */
  function computeDelay(attempt) {
    const base = Math.min(
      config.baseDelayMs * Math.pow(2, attempt),
      config.maxDelayMs,
    );
    const jitter = 1 + Math.random() * config.jitterFactor;
    return Math.round(base * jitter);
  }

  /**
   * Check if an error is retryable based on message patterns
   * and exit codes.
   * @param {Error} error
   * @returns {boolean}
   */
  function isRetryable(error) {
    if (!error) return false;

    const msg = error.message || "";
    for (const pattern of config.retryablePatterns) {
      if (pattern.test(msg)) return true;
    }

    if (error.exitCode != null && config.retryableExitCodes.includes(error.exitCode)) {
      return true;
    }

    return false;
  }

  /**
   * Generic async retry wrapper.
   *
   * @param {() => Promise<T>} fn — function to retry
   * @param {object} [opts]
   * @param {(attempt: number, error: Error, delayMs: number) => void} [opts.onRetry]
   * @param {number} [opts.maxRetries] — override per-call
   * @returns {Promise<T>}
   */
  async function withRetry(fn, opts = {}) {
    const maxAttempts = opts.maxRetries ?? config.maxRetries;
    const onRetry = opts.onRetry || null;
    let lastErr;

    for (let attempt = 0; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;

        const canRetry = attempt < maxAttempts && isRetryable(err);
        if (!canRetry) break;

        const delay = computeDelay(attempt);
        if (onRetry) onRetry(attempt, err, delay);

        await new Promise((r) => setTimeout(r, delay));
      }
    }

    throw lastErr;
  }

  /**
   * Race: wait for a child process to either produce first stdout
   * output or fail. Used to detect startup failures for stream retry.
   *
   * @param {import("node:child_process").ChildProcess} proc
   * @param {number} timeoutMs — startup timeout
   * @returns {Promise<{ started: boolean, error?: Error }>}
   */
  function raceFirstOutputOrError(proc, timeoutMs = 30_000) {
    return new Promise((resolve) => {
      let settled = false;

      function settle(result) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      }

      function onData() {
        settle({ started: true });
      }

      function onClose(code) {
        if (code !== 0) {
          const err = new Error(`CLI exit ${code} before producing output`);
          err.exitCode = code;
          settle({ started: false, error: err });
        } else {
          // Exited cleanly with no output — still counts as started (empty response)
          settle({ started: true });
        }
      }

      function onError(err) {
        settle({ started: false, error: err });
      }

      const timer = setTimeout(() => {
        const err = new Error(`Startup timeout: no output after ${timeoutMs}ms`);
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        settle({ started: false, error: err });
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timer);
        proc.stdout?.removeListener("data", onData);
        proc.removeListener("close", onClose);
        proc.removeListener("error", onError);
      }

      proc.stdout?.on("data", onData);
      proc.on("close", onClose);
      proc.on("error", onError);
    });
  }

  return Object.freeze({
    computeDelay,
    isRetryable,
    withRetry,
    raceFirstOutputOrError,
    config,
  });
}
