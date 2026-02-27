/**
 * Claude Code Proxy v0.5.0
 *
 * Central proxy for multiple OpenClaw instances.
 * Wraps claude CLI into OpenAI-compatible API with:
 *   - Fair queuing (round-robin between sources)
 *   - Rate limiting (95% of Max plan limits)
 *   - Priority by model (opus=high, sonnet=normal, haiku=low)
 *   - Authentication via Bearer token
 *   - Per-source metrics & monitoring
 *   - Process registry with zombie detection & reaper
 *   - Retry with exponential backoff + jitter
 *   - Stream heartbeat & execution timeout
 *   - Graceful shutdown
 *
 * All OpenClaw instances point their claude-code provider to this proxy.
 * Requests are queued fairly and processed through local claude CLI,
 * using the Max subscription (flat monthly fee, no per-token cost).
 */

import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createFairQueue } from "./fair-queue.mjs";
import { createProcessRegistry } from "./process-registry.mjs";
import { createRetryPolicy } from "./retry.mjs";
import { createEventLog } from "./event-log.mjs";
import { createTokenTracker } from "./token-tracker.mjs";
import { createMetricsStore } from "./metrics-store.mjs";
import { createRateLimiter } from "./rate-limiter.mjs";
import { createRedisClient } from "./redis-client.mjs";
import { createSessionAffinity } from "./session-affinity.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================
// Configuration
// ============================================================

const PORT = parseInt(process.env.CLAUDE_PROXY_PORT || "8403", 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const AUTH_TOKEN = process.env.PROXY_AUTH_TOKEN || "local-proxy";

// ============================================================
// CLI Router Objects: smart routing with failover
// WORKERS env var: JSON array of {name, bin, token} objects
// Routing strategy:
//   - Default: all traffic to PRIMARY_WORKER (env, default "2")
//   - On rate limit: switch entirely to the other CLI router
//   - Every HEALTH_CHECK_MS: probe if cooled-down router is back
//   - When recovered: resume load-balancing (round-robin)
// ============================================================

const PRIMARY_WORKER = process.env.PRIMARY_WORKER || "2";
const HEALTH_CHECK_MS = parseInt(process.env.HEALTH_CHECK_MS || "600000", 10); // 10 min
// CLI agent mode: workers are full autonomous agents (all tools enabled, --dangerously-skip-permissions)
// When true, ALL requests route through CLI workers; API direct path is bypassed.
const USE_CLI_AGENTS = process.env.USE_CLI_AGENTS === "true";

// Default worker pool: Mac native + Ubuntu VM (OrbStack)
const DEFAULT_WORKERS = [
  { name: "1", bin: "/opt/homebrew/bin/claude" },
  { name: "2", bin: "/opt/homebrew/bin/claude-ubuntu" },
];

let _workerPool = [];
try {
  if (process.env.WORKERS) {
    _workerPool = JSON.parse(process.env.WORKERS);
  }
} catch (err) {
  console.warn(`[CLIRouter] Failed to parse WORKERS env: ${err.message} — using defaults`);
}
if (_workerPool.length === 0) {
  _workerPool = DEFAULT_WORKERS;
}
// Assign default names if missing
_workerPool.forEach((w, i) => { if (!w.name) w.name = String(i + 1); });

// Worker health state
const _workerHealth = new Map(); // name -> { limited: boolean, limitedAt: number }
for (const w of _workerPool) {
  _workerHealth.set(w.name, { limited: false, limitedAt: 0 });
}

// Round-robin index for load-balancing mode
let _rrIndex = 0;

console.log(`[CLIRouter] Pool: ${_workerPool.map((w) => `${w.name}=${w.bin}`).join(" | ")}`);
console.log(`[CLIRouter] Primary: ${PRIMARY_WORKER} | Health check: ${HEALTH_CHECK_MS / 1000}s`);

// ============================================================
// Fallback API: last-resort model when all CLI routers fail
// Forwards as an OpenAI-compatible /v1/chat/completions request
// ============================================================

const FALLBACK_API = (() => {
  if (process.env.FALLBACK_API_URL) {
    return {
      baseUrl: process.env.FALLBACK_API_URL,
      apiKey: process.env.FALLBACK_API_KEY || "none",
      model: process.env.FALLBACK_MODEL || "default",
      name: process.env.FALLBACK_NAME || "fallback",
    };
  }
  // Default: MiniMax local endpoint
  return {
    baseUrl: "http://172.28.216.81:8080/v1",
    apiKey: "none",
    model: "MiniMax-M2.5-Q8_0-00001-of-00006.gguf",
    name: "minimax-local",
  };
})();
console.log(`[Fallback] ${FALLBACK_API.name} → ${FALLBACK_API.baseUrl} model=${FALLBACK_API.model}`);

// ============================================================
// Anthropic Direct API — for tool-enabled requests (bypass CLI)
// When request includes `tools`, call Anthropic API directly so the
// gateway receives tool_calls in OpenAI format and executes them.
// CLI path remains for text-only requests (flat fee via Max sub).
// ============================================================

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_API_VERSION = "2023-06-01";

const ANTHROPIC_MODEL_IDS = {
  sonnet: process.env.ANTHROPIC_SONNET_MODEL || "claude-sonnet-4-6",
  opus: process.env.ANTHROPIC_OPUS_MODEL || "claude-opus-4-6",
  haiku: process.env.ANTHROPIC_HAIKU_MODEL || "claude-haiku-4-5-20251001",
};

// Token pool for API direct round-robin.
// Each token represents an independent OAuth credential with its own rate limits.
// OAuth requires `anthropic-beta: oauth-2025-04-20` header to work with the raw API.
const TOKEN_POOL = (() => {
  const tokens = [];
  // Worker tokens from WORKERS env (reuse existing config)
  for (const w of _workerPool) {
    if (w.token) tokens.push({ name: w.name, token: w.token, type: "oauth_flat" });
  }
  // Fallback to process-level CLAUDE_CODE_OAUTH_TOKEN
  if (tokens.length === 0) {
    const oat = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oat) tokens.push({ name: "default", token: oat, type: "oauth_flat" });
  }
  // Last resort: API key (per-token billing)
  if (tokens.length === 0) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (key) tokens.push({ name: "apikey", token: key, type: "api_key_billed" });
  }
  return tokens;
})();
let _tokenRrIndex = 0;
function getNextToken() {
  const idx = _tokenRrIndex++ % TOKEN_POOL.length;
  return TOKEN_POOL[idx];
}
// Backward compat: ANTHROPIC_AUTH still used for logging/health checks
const ANTHROPIC_AUTH = TOKEN_POOL.length > 0 ? TOKEN_POOL[0] : null;
if (TOKEN_POOL.length > 0) {
  console.log(`[ApiDirect] Token pool: ${TOKEN_POOL.length} token(s) — [${TOKEN_POOL.map(t => `${t.name}:${t.type}`).join(", ")}] — ALL requests via API direct`);
} else {
  console.log(`[ApiDirect] No tokens configured — falling back to CLI workers`);
}

// ============================================================
// Worker traffic & error tracking — exposed via /metrics for dashboard
// ============================================================
const workerStats = {
  // Per-worker traffic: { "1": { requests: 0, errors: 0 }, "3": { ... } }
  traffic: Object.fromEntries(_workerPool.map(w => [w.name, { requests: 0, errors: 0, lastReqAt: null }])),
  // Error categories: { cli_crash: N, cli_killed: N, context_overflow: N, ... }
  errors: {
    cli_crash: 0,       // code=1 — CLI error (nested session, auth, prompt too long, etc.)
    cli_killed: 0,      // code=143 — SIGTERM (reaper killed, heartbeat timeout)
    context_overflow: 0, // fallback API "Context size exceeded"
    api_error: 0,       // Anthropic API errors (401, 429, 500)
    stream_retry: 0,    // quick-fail retries on alternate worker
    timeout: 0,         // heartbeat or exec timeout
    queue_timeout: 0,   // queue timeout (waited too long)
    other: 0,
  },
  // Recent error log (ring buffer, last 100)
  recentErrors: [],
};
function recordWorkerRequest(workerName) {
  const w = workerStats.traffic[workerName];
  if (w) { w.requests++; w.lastReqAt = Date.now(); }
}
function recordWorkerError(workerName, category, detail) {
  const w = workerStats.traffic[workerName];
  if (w) w.errors++;
  if (workerStats.errors[category] !== undefined) workerStats.errors[category]++;
  else workerStats.errors.other++;
  workerStats.recentErrors.push({ ts: Date.now(), worker: workerName, category, detail: (detail || "").slice(0, 200) });
  if (workerStats.recentErrors.length > 100) workerStats.recentErrors.shift();
}

// _loadBalanceMode starts true: round-robin across all healthy workers
// Falls back to single-worker mode when one worker is rate-limited
let _loadBalanceMode = true;

// Active connection tracking — for least-connections routing
const _activeConns = new Map(_workerPool.map(w => [w.name, 0]));
function workerAcquire(name) { _activeConns.set(name, (_activeConns.get(name) || 0) + 1); }
function workerRelease(name) { const v = _activeConns.get(name) || 0; _activeConns.set(name, Math.max(0, v - 1)); }
function leastLoadedWorker(pool) {
  let best = pool[0];
  let bestConns = _activeConns.get(best.name) ?? Infinity;
  let bestTotal = workerStats.traffic[best.name]?.requests ?? 0;
  for (let i = 1; i < pool.length; i++) {
    const c = _activeConns.get(pool[i].name) ?? 0;
    const t = workerStats.traffic[pool[i].name]?.requests ?? 0;
    // Primary: least active connections; Secondary: least total requests (evens out over time)
    if (c < bestConns || (c === bestConns && t < bestTotal)) {
      best = pool[i]; bestConns = c; bestTotal = t;
    }
  }
  return best;
}

/**
 * Get the next worker, respecting session affinity when available.
 *
 * @param {string} [sessionKey] - Session key for affinity lookup
 * @returns {object} worker from _workerPool
 */
function getNextWorker(sessionKey) {
  const isHealthy = (name) => !_workerHealth.get(name)?.limited;
  const healthy = _workerPool.filter((w) => isHealthy(w.name));

  if (healthy.length === 0) {
    // All workers limited — pick the one that was limited longest ago
    const sorted = [..._workerPool].sort(
      (a, b) => _workerHealth.get(a.name).limitedAt - _workerHealth.get(b.name).limitedAt,
    );
    console.log(`[CLIRouter] ALL LIMITED — trying oldest-limited: ${sorted[0].name}`);
    return sorted[0];
  }

  if (healthy.length === 1) {
    return healthy[0];
  }

  // Degraded mode: only use primary
  if (!_loadBalanceMode) {
    const primary = healthy.find((w) => w.name === PRIMARY_WORKER);
    return primary || healthy[0];
  }

  // --- Least-connections is primary strategy ---
  // Session affinity is only a tiebreaker when workers have equal load.
  const least = leastLoadedWorker(healthy);
  const leastConns = _activeConns.get(least.name) || 0;

  if (sessionKey) {
    const aff = sessionAffinity.lookup(sessionKey, isHealthy);
    if (aff?.hit) {
      const affinityWorker = _workerPool.find((w) => w.name === aff.workerName);
      if (affinityWorker) {
        const affConns = _activeConns.get(affinityWorker.name) || 0;
        // Use affinity only if it's strictly less loaded (not just equal)
        if (affConns < leastConns) return affinityWorker;
      }
    }
  }

  return least;
}

function markWorkerLimited(workerName) {
  const h = _workerHealth.get(workerName);
  if (h && !h.limited) {
    h.limited = true;
    h.limitedAt = Date.now();
    _loadBalanceMode = false; // back to single-worker mode
    const other = _workerPool.find((w) => w.name !== workerName);
    console.log(`[CLIRouter] ${workerName} RATE LIMITED — switching all traffic to ${other?.name || "?"}`);
    eventLog.push("worker_limited", { worker: workerName, switchedTo: other?.name });
  }
}

function markWorkerRecovered(workerName) {
  const h = _workerHealth.get(workerName);
  if (h && h.limited) {
    h.limited = false;
    h.limitedAt = 0;
    _loadBalanceMode = true; // both workers healthy → share the load
    console.log(`[CLIRouter] ${workerName} RECOVERED — entering load-balance mode (round-robin)`);
    eventLog.push("worker_recovered", { worker: workerName, loadBalance: true });
  }
}

function isRateLimitError(exitCode, stderr) {
  if (!stderr) return false;
  const lower = stderr.toLowerCase();
  return (
    lower.includes("rate limit") ||
    lower.includes("429") ||
    lower.includes("too many requests") ||
    lower.includes("overloaded") ||
    lower.includes("you've hit your limit")
  );
}

// Health check timer: every HEALTH_CHECK_MS, try to recover limited workers
setInterval(() => {
  for (const w of _workerPool) {
    const h = _workerHealth.get(w.name);
    if (h.limited && Date.now() - h.limitedAt >= HEALTH_CHECK_MS) {
      console.log(`[CLIRouter] Health check: ${w.name} cooldown expired (${Math.round((Date.now() - h.limitedAt) / 1000)}s) — marking recovered`);
      markWorkerRecovered(w.name);
    }
  }
}, Math.min(HEALTH_CHECK_MS, 60000)); // Check at least every 60s

// Whitelist of env vars safe to pass to CLI workers.
// Everything else is blocked to prevent parent-process leakage
// (e.g. CLAUDECODE causing "nested session" crash).
const WORKER_ENV_WHITELIST = new Set([
  // System essentials
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  // Node.js
  "NODE_PATH", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS",
  // SSH (agent forwarding, keys)
  "SSH_AUTH_SOCK", "SSH_AGENT_PID",
  // Proxy/network
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  // Anthropic (will be overridden per-worker below)
  "ANTHROPIC_API_KEY",
]);

function workerEnv(worker) {
  // Start from a clean env — only whitelisted vars from parent process
  const env = {};
  for (const key of WORKER_ENV_WHITELIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  // Ensure /opt/homebrew/bin is in PATH for the CLI's #!/usr/bin/env node shebang
  const path = env.PATH || "/usr/bin:/bin";
  env.PATH = path.includes("/opt/homebrew/bin") ? path : `/opt/homebrew/bin:${path}`;
  // Per-worker OAuth token (overrides any inherited value)
  if (worker.token) {
    env.CLAUDE_CODE_OAUTH_TOKEN = worker.token;
  }
  // Headless / non-interactive mode
  env.CI = "true";                          // suppress macOS permission popups
  env.TERM_PROGRAM = "dumb";               // skip terminal-specific osascript detection
  env.TERM = "dumb";                       // reinforce non-interactive terminal
  env.NO_COLOR = "1";                      // no ANSI escape codes
  env.ELECTRON_NO_ATTACH_CONSOLE = "1";    // suppress Electron console
  return env;
}
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "10", 10);
const MAX_QUEUE_TOTAL = parseInt(process.env.MAX_QUEUE_TOTAL || "200", 10);
const MAX_QUEUE_PER_SOURCE = parseInt(process.env.MAX_QUEUE_PER_SOURCE || "50", 10);
const QUEUE_TIMEOUT_MS = parseInt(process.env.QUEUE_TIMEOUT_MS || "300000", 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || "3", 10);
const RETRY_BASE_MS = parseInt(process.env.RETRY_BASE_MS || "2000", 10);
const STREAM_TIMEOUT_MS = parseInt(process.env.STREAM_TIMEOUT_MS || "1800000", 10);  // 30 min (was 10 min)
const SYNC_TIMEOUT_MS = parseInt(process.env.SYNC_TIMEOUT_MS || "600000", 10);       // 10 min (was 5 min)

// Per-model heartbeat timeouts — autonomous agents may go silent during tool execution
const HEARTBEAT_BY_MODEL = Object.freeze({
  opus: 1800000,   // 30 min — long tool chains (SSH compile, multi-step ops)
  sonnet: 1200000, // 20 min
  haiku: 600000,   // 10 min
});
const DEFAULT_HEARTBEAT_MS = 1200000; // 20 min fallback
const MAX_PROCESS_AGE_MS = parseInt(process.env.MAX_PROCESS_AGE_MS || "1800000", 10);  // 30 min (was 10 min)
const MAX_IDLE_MS = parseInt(process.env.MAX_IDLE_MS || "600000", 10);                 // 10 min (was 2 min)
const REAPER_INTERVAL_MS = parseInt(process.env.REAPER_INTERVAL_MS || "15000", 10);

// ============================================================
// Rate Limits — 95% of Claude Max plan limits (shared globally)
// ============================================================

const RATE_LIMITS = {
  sonnet: { requestsPerMin: 57, tokensPerMin: 190000 },
  opus: { requestsPerMin: 28, tokensPerMin: 57000 },
  haiku: { requestsPerMin: 95, tokensPerMin: 380000 },
};

// Model priority mapping
const MODEL_PRIORITY = { opus: "high", sonnet: "normal", haiku: "low" };

// Model name -> CLI flag
const MODEL_MAP = {
  "claude-code": "sonnet",
  sonnet: "sonnet",
  "sonnet-4.6": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  opus: "opus",
  "opus-4.6": "opus",
  "claude-opus-4-6": "opus",
  haiku: "haiku",
  "haiku-4.5": "haiku",
  "claude-haiku-4-5": "haiku",
};

function resolveModel(model) {
  const stripped = (model || "sonnet").replace("claude-code/", "");
  return MODEL_MAP[stripped] || "sonnet";
}

// ============================================================
// Redis + Module Instances
// ============================================================

// Redis — connect first, then pass to all modules
let redis = null;
try {
  redis = await createRedisClient();
  console.log("[Redis] Connected and ready");
} catch (err) {
  console.warn(`[Redis] Connection failed: ${err.message} — running in memory-only mode`);
  redis = null;
}

const queue = createFairQueue({
  maxConcurrent: MAX_CONCURRENT,
  maxPerSource: MAX_QUEUE_PER_SOURCE,
  maxTotal: MAX_QUEUE_TOTAL,
  queueTimeoutMs: QUEUE_TIMEOUT_MS,
  maxLeaseMs: STREAM_TIMEOUT_MS + 60_000, // stream timeout + 1 min grace
});

const rateLimiter = createRateLimiter({ limits: RATE_LIMITS, redis });

const registry = createProcessRegistry({
  maxProcessAgeMs: MAX_PROCESS_AGE_MS,
  maxIdleMs: MAX_IDLE_MS,
  reaperIntervalMs: REAPER_INTERVAL_MS,
  redis,
});

const retryPolicy = createRetryPolicy({
  maxRetries: MAX_RETRIES,
  baseDelayMs: RETRY_BASE_MS,
});

const eventLog = createEventLog({ maxEvents: 500, redis });
const tokenTracker = createTokenTracker({ redis });

// Metrics store: persistent time-series data for dashboard charts
const metricsStore = createMetricsStore({ redis });

// Session affinity: sticky routing for conversation sessions
const sessionAffinity = createSessionAffinity({ ttlMs: 5 * 60 * 1000 }); // 5 min — short TTL for better distribution

// Wire reaper events into event log + SSE
registry.onReap((zombie) => {
  const ageS = Math.round(zombie.age / 1000);
  const idleS = Math.round(zombie.idle / 1000);
  eventLog.push("reap", {
    pid: zombie.pid,
    reqId: zombie.requestId,
    model: zombie.model,
    mode: zombie.mode,
    source: zombie.source,
    ageSec: ageS,
    idleSec: idleS,
  });
  sseBroadcast("reap", {
    pid: zombie.pid,
    reqId: zombie.requestId,
    model: zombie.model,
    ageSec: ageS,
    idleSec: idleS,
  });
});

// ============================================================
// SSE Broadcast — real-time stream to dashboard subscribers
// ============================================================

let sseClients = new Set();

function sseBroadcast(event, data) {
  if (sseClients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(payload);
    } catch {
      sseClients = new Set([...sseClients].filter((c) => c !== client));
    }
  }
}

/**
 * Gather current metrics snapshot for the metrics store sampler.
 */
function gatherMetricsSnapshot() {
  const qs = queue.getStats();
  const rs = registry.getStats();
  const counts = eventLog.getCounts();
  return {
    tokens: tokenTracker.getTotals(),
    tokensByModel: tokenTracker.getByModel(),
    queue: { active: qs.active, totalQueued: qs.totalQueued, metrics: qs.metrics },
    processes: rs,
    liveTokens: rs.liveTokens,
    events: counts,
    sessionAffinity: sessionAffinity.getStats(),
  };
}

// ============================================================
// Auth & Source identification
// ============================================================

function authenticate(req) {
  const authHeader = req.headers["authorization"] || "";
  const apiKey = req.headers["x-api-key"] || "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  // Accept any of: Bearer token, x-api-key, or query param
  return bearer === AUTH_TOKEN || apiKey === AUTH_TOKEN || AUTH_TOKEN === "local-proxy";
}

function identifySource(req) {
  // Priority: explicit header > api key > remote IP
  return (
    req.headers["x-openclaw-source"] ||
    req.headers["x-source"] ||
    req.headers["x-api-key"] ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// ============================================================
// Claude CLI execution
// ============================================================

// Max prompt characters (~50K chars ≈ ~12K tokens, leaves room for CLI agent's own tool calls).
// Opus has 200K token context; we reserve most of it for the agent's multi-turn tool execution.
const MAX_PROMPT_CHARS = parseInt(process.env.MAX_PROMPT_CHARS || "50000", 10);

function extractPrompt(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { prompt: "", systemPrompt: null };
  }

  let systemPrompt = null;
  const systemMsg = messages.find((m) => m.role === "system" || m.role === "developer");
  if (systemMsg) {
    systemPrompt = typeof systemMsg.content === "string"
      ? systemMsg.content
      : JSON.stringify(systemMsg.content);
  }

  // Collect all non-system messages
  const allParts = [];
  for (const msg of messages) {
    if (msg.role === "system" || msg.role === "developer") continue;
    const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    if (msg.role === "user") allParts.push(text);
    else if (msg.role === "assistant") allParts.push(`[Previous assistant]: ${text}`);
  }

  // Truncate from the front (keep recent messages) to fit within MAX_PROMPT_CHARS.
  // Always keep the LAST message (the actual user request).
  let totalLen = 0;
  const kept = [];
  for (let i = allParts.length - 1; i >= 0; i--) {
    const part = allParts[i];
    if (totalLen + part.length > MAX_PROMPT_CHARS && kept.length > 0) {
      // Budget exceeded — prepend a truncation notice and stop
      kept.unshift("[... earlier conversation history truncated ...]");
      break;
    }
    totalLen += part.length;
    kept.unshift(part);
  }

  return { prompt: kept.join("\n\n"), systemPrompt };
}

function buildCliArgs(prompt, model, systemPrompt, stream) {
  // Pass prompt via stdin (not CLI arg) to avoid OrbStack/OS arg length limits.
  // The `-p` flag without a positional prompt tells Claude CLI to read from stdin.
  // --dangerously-skip-permissions: full autonomous agent, all tools enabled
  // System prompt is prepended to stdin (not --system-prompt CLI arg) to avoid arg length limits.
  const args = ["-p", "--model", model, "--dangerously-skip-permissions"];
  if (stream) {
    args.push("--output-format", "stream-json", "--verbose", "--include-partial-messages");
  } else {
    args.push("--output-format", "text");
  }
  return args;
}

// Build the full stdin payload: system prompt (if any) + user prompt
function buildStdinPayload(prompt, systemPrompt) {
  if (systemPrompt) {
    return `[System Instructions]\n${systemPrompt}\n\n[User Request]\n${prompt}`;
  }
  return prompt;
}

function runCliOnce(prompt, model, systemPrompt, requestId = "", source = "", workerOverride = null, sessionKey = "") {
  return new Promise((resolve, reject) => {
    const args = buildCliArgs(prompt, model, systemPrompt, false);
    const worker = workerOverride || getNextWorker(sessionKey);
    if (sessionKey) sessionAffinity.assign(sessionKey, worker.name);
    console.log(`[${ts()}] CLIROUTER obj=${worker.name} bin=${worker.bin} reqId=${requestId} model=${model}`);
    recordWorkerRequest(worker.name);
    workerAcquire(worker.name);
    const proc = spawn(worker.bin, args, {
      env: workerEnv(worker),
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Write full payload (system prompt + user prompt) to stdin
    if (proc.stdin) {
      proc.stdin.write(buildStdinPayload(prompt, systemPrompt));
      proc.stdin.end();
    }

    // Track in process registry
    if (proc.pid) {
      registry.register({
        pid: proc.pid,
        requestId,
        model,
        mode: "sync",
        source,
        worker: `${worker.name}:${worker.bin}`,
        promptPreview: typeof prompt === "string" ? prompt.slice(0, 80) : "[structured]",
      });
    }

    // Execution timeout — kill if running too long
    const execTimer = setTimeout(() => {
      eventLog.push("timeout", { kind: "sync", pid: proc.pid, reqId: requestId, model });
      recordWorkerError(worker.name, "timeout", `sync_timeout pid=${proc.pid}`);
      console.log(`[${ts()}] SYNC_TIMEOUT pid=${proc.pid} reqId=${requestId} model=${model}`);
      try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      const err = new Error(`Execution timeout after ${SYNC_TIMEOUT_MS}ms`);
      err.exitCode = -1;
      err.workerName = worker.name;
      reject(err);
    }, SYNC_TIMEOUT_MS);

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
      if (proc.pid) registry.touch(proc.pid);
    });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("close", (code) => {
      clearTimeout(execTimer);
      workerRelease(worker.name);
      if (proc.pid) registry.unregister(proc.pid);
      // Detect rate limit from stderr
      if (isRateLimitError(code, stderr)) {
        markWorkerLimited(worker.name);
      }
      if (code !== 0) {
        const err = new Error(`CLI exit ${code}: ${stderr}`);
        err.exitCode = code;
        err.workerName = worker.name;
        err.isRateLimit = isRateLimitError(code, stderr);
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
    proc.on("error", (err) => {
      clearTimeout(execTimer);
      workerRelease(worker.name);
      if (proc.pid) registry.unregister(proc.pid);
      err.workerName = worker.name;
      reject(err);
    });
  });
}

/**
 * Run CLI with retry + exponential backoff + jitter.
 * Uses retry policy for consistent retry behavior.
 */
async function runCli(prompt, model, systemPrompt, requestId = "", source = "", sessionKey = "") {
  return retryPolicy.withRetry(
    () => runCliOnce(prompt, model, systemPrompt, requestId, source, null, sessionKey),
    {
      onRetry: (attempt, error, delayMs) => {
        eventLog.push("retry", { reqId: requestId, attempt: attempt + 1, model, delay: delayMs, error: error.message });
        console.log(
          `[${ts()}] RETRY attempt=${attempt + 1}/${MAX_RETRIES} ` +
          `model=${model} delay=${delayMs}ms err=${error.message}`
        );
      },
    },
  );
}

function spawnCliStream(prompt, model, systemPrompt, worker) {
  const args = buildCliArgs(prompt, model, systemPrompt, true);
  const proc = spawn(worker.bin, args, {
    env: workerEnv(worker),
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Write full payload (system prompt + user prompt) to stdin
  if (proc.stdin) {
    proc.stdin.write(buildStdinPayload(prompt, systemPrompt));
    proc.stdin.end();
  }
  proc._workerName = worker.name;
  proc._spawnedAt = Date.now();
  return proc;
}

function trackStreamProc(proc, requestId, model, source, worker) {
  if (proc.pid) {
    registry.register({
      pid: proc.pid,
      requestId,
      model,
      mode: "stream",
      source,
      worker: `${worker.name}:${worker.bin}`,
      promptPreview: "[stream]",
      liveInputTokens: 0,
      liveOutputTokens: 0,
    });
    proc.on("close", () => registry.unregister(proc.pid));
    proc.on("error", () => registry.unregister(proc.pid));
  }
}

// Pick a specific worker by name, or fallback to round-robin
function getWorkerByName(name) {
  return _workerPool.find((w) => w.name === name) || null;
}

function getAlternateWorker(excludeName) {
  const healthy = _workerPool.filter(
    (w) => w.name !== excludeName && !_workerHealth.get(w.name)?.limited
  );
  return healthy.length > 0 ? healthy[0] : null;
}

// ============================================================
// Fallback API: stream from an OpenAI-compatible HTTP endpoint
// Used as last resort when all CLI routers fail
// ============================================================

function streamFromFallbackApi(messages, model, reqId, source, res) {
  const fb = FALLBACK_API;
  const url = new URL(`${fb.baseUrl}/chat/completions`);
  const isHttps = url.protocol === "https:";
  const doRequest = isHttps ? httpsRequest : httpRequest;

  const body = JSON.stringify({
    model: fb.model,
    messages,
    stream: true,
  });

  console.log(`[${ts()}] FALLBACK reqId=${reqId} api=${fb.name} model=${fb.model} src=${source}`);
  eventLog.push("fallback", { reqId, model, source, fallbackApi: fb.name, fallbackModel: fb.model });

  // Safe write helper — prevent writing to already-closed response
  const safeWrite = (data) => { if (!res.writableEnded) res.write(data); };
  const safeEnd = () => { if (!res.writableEnded) res.end(); };

  const apiReq = doRequest(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${fb.apiKey}`,
        "content-length": Buffer.byteLength(body),
      },
    },
    (apiRes) => {
      if (apiRes.statusCode !== 200) {
        let errBody = "";
        apiRes.on("data", (d) => { errBody += d.toString(); });
        apiRes.on("end", () => {
          console.log(`[${ts()}] FALLBACK_ERROR reqId=${reqId} status=${apiRes.statusCode} body=${errBody.slice(0, 200)}`);
          recordWorkerError("fallback", errBody.includes("Context size") ? "context_overflow" : "api_error", `HTTP ${apiRes.statusCode} ${errBody.slice(0, 100)}`);
          safeWrite(sseChunk(reqId, `[Fallback ${fb.name} error: HTTP ${apiRes.statusCode}]`));
          safeWrite(sseChunk(reqId, null, "stop"));
          safeWrite("data: [DONE]\n\n");
          safeEnd();
        });
        return;
      }

      // Pipe the SSE stream from the fallback API directly to the client
      let buf = "";
      let outputChars = 0;
      apiRes.on("data", (chunk) => {
        buf += chunk.toString();
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") {
            if (trimmed === "data: [DONE]") {
              safeWrite("data: [DONE]\n\n");
            }
            continue;
          }
          if (trimmed.startsWith("data: ")) {
            try {
              const ev = JSON.parse(trimmed.slice(6));
              const delta = ev.choices?.[0]?.delta?.content;
              const finish = ev.choices?.[0]?.finish_reason;
              if (delta) {
                safeWrite(sseChunk(reqId, delta));
                outputChars += delta.length;
                sseBroadcast("chunk", { reqId, model: fb.model, source, text: delta, tokens: outputChars });
              }
              if (finish) {
                safeWrite(sseChunk(reqId, null, finish));
              }
            } catch { /* skip malformed */ }
          }
        }
      });
      apiRes.on("end", () => {
        tokenTracker.record(reqId, fb.model, 0, Math.ceil(outputChars / 4));
        eventLog.push("complete", { reqId, mode: "fallback", model: fb.model, source, exitCode: 0, outputChars });
        sseBroadcast("complete", { reqId, model: fb.model, source, exitCode: 0 });
        if (outputChars === 0) {
          safeWrite(sseChunk(reqId, `[Fallback ${fb.name}: empty response]`));
        }
        safeWrite(sseChunk(reqId, null, "stop"));
        safeWrite("data: [DONE]\n\n");
        safeEnd();
      });
    },
  );

  apiReq.on("error", (err) => {
    console.log(`[${ts()}] FALLBACK_NET_ERROR reqId=${reqId} err=${err.message}`);
    safeWrite(sseChunk(reqId, `[Fallback ${fb.name} unreachable: ${err.message}]`));
    safeWrite(sseChunk(reqId, null, "stop"));
    safeWrite("data: [DONE]\n\n");
    safeEnd();
  });

  apiReq.write(body);
  apiReq.end();
}

// ============================================================
// OpenAI response formatting
// ============================================================

function sseChunk(id, content, finishReason = null) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "claude-code",
    choices: [{ index: 0, delta: content ? { content } : {}, finish_reason: finishReason }],
  })}\n\n`;
}

function completionResponse(id, content, model) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

// ============================================================
// Anthropic Direct API: format conversion + tool_calls support
// ============================================================

/**
 * Convert OpenAI tool definitions to Anthropic format.
 */
function convertToolsToAnthropic(openaiTools) {
  if (!openaiTools || !Array.isArray(openaiTools)) return [];
  return openaiTools
    .filter(t => t.type === "function" && t.function)
    .map(t => ({
      name: t.function.name,
      description: t.function.description || "",
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
}

/**
 * Convert OpenAI messages to Anthropic Messages API format.
 * Returns { system, messages } — system extracted as separate param.
 */
function convertMessagesToAnthropic(openaiMessages) {
  let system;
  const rawMsgs = [];

  for (const msg of openaiMessages) {
    if (msg.role === "system" || msg.role === "developer") {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      system = system ? `${system}\n\n${text}` : text;
      continue;
    }

    if (msg.role === "user") {
      const content = typeof msg.content === "string"
        ? [{ type: "text", text: msg.content }]
        : Array.isArray(msg.content) ? msg.content : [{ type: "text", text: String(msg.content) }];
      rawMsgs.push({ role: "user", content });
      continue;
    }

    if (msg.role === "assistant") {
      const content = [];
      if (msg.content) {
        const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        if (text) content.push({ type: "text", text });
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try {
            input = typeof tc.function?.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : (tc.function?.arguments || {});
          } catch { /* use empty object */ }
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function?.name || "unknown",
            input,
          });
        }
      }
      if (content.length > 0) rawMsgs.push({ role: "assistant", content });
      continue;
    }

    if (msg.role === "tool") {
      rawMsgs.push({
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: msg.tool_call_id,
          content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
        }],
      });
      continue;
    }
  }

  // Merge consecutive same-role messages (Anthropic requires alternating roles)
  const messages = [];
  for (const msg of rawMsgs) {
    const prev = messages[messages.length - 1];
    if (prev && prev.role === msg.role) {
      const prevContent = Array.isArray(prev.content)
        ? prev.content : [{ type: "text", text: String(prev.content) }];
      const newContent = Array.isArray(msg.content)
        ? msg.content : [{ type: "text", text: String(msg.content) }];
      prev.content = [...prevContent, ...newContent];
    } else {
      messages.push({
        ...msg,
        content: Array.isArray(msg.content) ? [...msg.content] : msg.content,
      });
    }
  }

  return { system, messages };
}

/** SSE chunk: initial tool_call with id + name. */
function sseToolCallStartChunk(id, index, callId, name) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "claude-code",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index, id: callId, type: "function", function: { name, arguments: "" } }],
      },
      finish_reason: null,
    }],
  })}\n\n`;
}

/** SSE chunk: streaming tool_call argument delta. */
function sseToolCallDeltaChunk(id, index, argsDelta) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "claude-code",
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{ index, function: { arguments: argsDelta } }],
      },
      finish_reason: null,
    }],
  })}\n\n`;
}

/** SSE chunk: finish_reason only (no content). */
function sseFinishChunk(id, finishReason) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "claude-code",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  })}\n\n`;
}

/** Non-streaming response with optional tool_calls. */
function completionResponseWithTools(id, content, toolCalls, model, usage) {
  const message = { role: "assistant", content: content || null };
  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls.map(tc => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: tc.arguments },
    }));
  }
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls && toolCalls.length > 0 ? "tool_calls" : "stop",
    }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Stream response from Anthropic Messages API, converting to OpenAI SSE.
 * Handles text content + tool_use blocks.
 */
function streamFromAnthropicDirect(body, model, reqId, source, res, release, tokenEntry) {
  const anthropicModel = ANTHROPIC_MODEL_IDS[model] || ANTHROPIC_MODEL_IDS.sonnet;
  const anthropicTools = body.tools ? convertToolsToAnthropic(body.tools) : [];
  const { system, messages } = convertMessagesToAnthropic(body.messages);

  const requestBody = {
    model: anthropicModel,
    max_tokens: body.max_tokens || 16384,
    stream: true,
    messages,
  };
  if (system) requestBody.system = system;
  if (anthropicTools.length > 0) requestBody.tools = anthropicTools;
  if (body.tool_choice) {
    if (body.tool_choice === "auto") requestBody.tool_choice = { type: "auto" };
    else if (body.tool_choice === "none") requestBody.tool_choice = { type: "none" };
    else if (body.tool_choice === "required") requestBody.tool_choice = { type: "any" };
    else if (body.tool_choice?.type === "function") {
      requestBody.tool_choice = { type: "tool", name: body.tool_choice.function.name };
    }
  }

  const bodyStr = JSON.stringify(requestBody);
  const authHeaderName = tokenEntry.type === "oauth_flat" ? "authorization" : "x-api-key";
  const authHeaderValue = tokenEntry.type === "oauth_flat" ? `Bearer ${tokenEntry.token}` : tokenEntry.token;
  console.log(
    `[${ts()}] ANTHROPIC_STREAM reqId=${reqId} model=${anthropicModel} ` +
    `tools=${anthropicTools.length} msgs=${messages.length} auth=${tokenEntry.type} token=${tokenEntry.name} src=${source}`
  );
  eventLog.push("anthropic_direct", {
    reqId, model: anthropicModel, tools: anthropicTools.length, source, auth: tokenEntry.type, token: tokenEntry.name,
  });

  const safeWrite = (data) => { if (!res.writableEnded) res.write(data); };
  const safeEnd = () => { if (!res.writableEnded) res.end(); };
  let released = false;
  const doRelease = () => { if (!released) { released = true; release(); } };

  const url = new URL(`${ANTHROPIC_API_BASE}/v1/messages`);
  const headers = {
    "content-type": "application/json",
    "anthropic-version": ANTHROPIC_API_VERSION,
    ...(tokenEntry.type === "oauth_flat" ? { "anthropic-beta": "oauth-2025-04-20" } : {}),
    "content-length": String(Buffer.byteLength(bodyStr)),
  };
  headers[authHeaderName] = authHeaderValue;

  const apiReq = httpsRequest(url, { method: "POST", headers }, (apiRes) => {
    if (apiRes.statusCode !== 200) {
      let errBody = "";
      apiRes.on("data", (d) => { errBody += d.toString(); });
      apiRes.on("end", () => {
        console.log(`[${ts()}] ANTHROPIC_ERROR reqId=${reqId} status=${apiRes.statusCode} body=${errBody.slice(0, 500)}`);
        eventLog.push("error", { reqId, mode: "anthropic_direct", model, source, status: apiRes.statusCode });
        safeWrite(sseChunk(reqId, `[Anthropic API error: HTTP ${apiRes.statusCode}]`));
        safeWrite(sseFinishChunk(reqId, "stop"));
        safeWrite("data: [DONE]\n\n");
        safeEnd();
        doRelease();
      });
      return;
    }

    let buf = "";
    let toolCallIndex = -1;
    const toolCalls = [];
    let inputTokens = 0;
    let outputTokens = 0;

    apiRes.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;

        let ev;
        try { ev = JSON.parse(trimmed.slice(6)); } catch { continue; }

        if (ev.type === "message_start") {
          inputTokens = ev.message?.usage?.input_tokens || 0;
        } else if (ev.type === "content_block_start") {
          const block = ev.content_block;
          if (block?.type === "tool_use") {
            toolCallIndex++;
            toolCalls.push({ index: toolCallIndex, id: block.id, name: block.name, arguments: "" });
            safeWrite(sseToolCallStartChunk(reqId, toolCallIndex, block.id, block.name));
          }
          // text blocks and thinking blocks: no special start action needed
        } else if (ev.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta" && ev.delta.text) {
            safeWrite(sseChunk(reqId, ev.delta.text));
          } else if (ev.delta?.type === "input_json_delta" && ev.delta.partial_json !== undefined) {
            const tc = toolCalls[toolCalls.length - 1];
            if (tc) {
              tc.arguments += ev.delta.partial_json;
              safeWrite(sseToolCallDeltaChunk(reqId, tc.index, ev.delta.partial_json));
            }
          }
          // thinking_delta: skip silently
        } else if (ev.type === "message_delta") {
          outputTokens = ev.usage?.output_tokens || outputTokens;
          const stop = ev.delta?.stop_reason;
          if (stop) {
            const finish = stop === "tool_use" ? "tool_calls"
              : stop === "end_turn" ? "stop"
              : stop === "max_tokens" ? "length"
              : "stop";
            safeWrite(sseFinishChunk(reqId, finish));
          }
        }
        // message_stop, content_block_stop, ping: no action needed
      }
    });

    apiRes.on("end", () => {
      tokenTracker.record(reqId, model, inputTokens, outputTokens);
      eventLog.push("complete", {
        reqId, mode: "anthropic_direct", model, source,
        inputTokens, outputTokens, toolCalls: toolCalls.length,
      });
      sseBroadcast("complete", { reqId, model, source, inputTokens, outputTokens });
      safeWrite("data: [DONE]\n\n");
      safeEnd();
      doRelease();
    });

    apiRes.on("error", (err) => {
      console.log(`[${ts()}] ANTHROPIC_STREAM_ERR reqId=${reqId} err=${err.message}`);
      safeWrite(sseChunk(reqId, `[Anthropic stream error: ${err.message}]`));
      safeWrite("data: [DONE]\n\n");
      safeEnd();
      doRelease();
    });
  });

  // Client disconnect: abort Anthropic API request
  res.on("close", () => {
    if (!apiReq.destroyed) {
      console.log(`[${ts()}] CLIENT_DISCONNECT reqId=${reqId} — aborting Anthropic API request`);
      apiReq.destroy();
    }
    doRelease();
  });

  apiReq.on("error", (err) => {
    console.log(`[${ts()}] ANTHROPIC_NET_ERR reqId=${reqId} err=${err.message}`);
    eventLog.push("error", { reqId, mode: "anthropic_direct", model, source, error: err.message });
    safeWrite(sseChunk(reqId, `[Anthropic API unreachable: ${err.message}]`));
    safeWrite(sseFinishChunk(reqId, "stop"));
    safeWrite("data: [DONE]\n\n");
    safeEnd();
    doRelease();
  });

  apiReq.write(bodyStr);
  apiReq.end();
}

/**
 * Call Anthropic Messages API synchronously (non-streaming).
 * Returns { content, toolCalls, usage, stopReason }.
 */
function callAnthropicDirect(body, model, reqId, source, tokenEntry) {
  return new Promise((resolve, reject) => {
    const anthropicModel = ANTHROPIC_MODEL_IDS[model] || ANTHROPIC_MODEL_IDS.sonnet;
    const anthropicTools = body.tools ? convertToolsToAnthropic(body.tools) : [];
    const { system, messages } = convertMessagesToAnthropic(body.messages);

    const requestBody = {
      model: anthropicModel,
      max_tokens: body.max_tokens || 16384,
      messages,
    };
    if (system) requestBody.system = system;
    if (anthropicTools.length > 0) requestBody.tools = anthropicTools;

    const bodyStr = JSON.stringify(requestBody);
    const authHeaderName = tokenEntry.type === "oauth_flat" ? "authorization" : "x-api-key";
    const authHeaderValue = tokenEntry.type === "oauth_flat" ? `Bearer ${tokenEntry.token}` : tokenEntry.token;
    console.log(
      `[${ts()}] ANTHROPIC_SYNC reqId=${reqId} model=${anthropicModel} ` +
      `tools=${anthropicTools.length} auth=${tokenEntry.type} token=${tokenEntry.name} src=${source}`
    );

    const url = new URL(`${ANTHROPIC_API_BASE}/v1/messages`);
    const headers = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_API_VERSION,
      ...(tokenEntry.type === "oauth_flat" ? { "anthropic-beta": "oauth-2025-04-20" } : {}),
      "content-length": String(Buffer.byteLength(bodyStr)),
    };
    headers[authHeaderName] = authHeaderValue;

    const timer = setTimeout(() => {
      apiReq.destroy();
      reject(new Error(`Anthropic API timeout after ${SYNC_TIMEOUT_MS}ms`));
    }, SYNC_TIMEOUT_MS);

    const apiReq = httpsRequest(url, { method: "POST", headers }, (apiRes) => {
      let resBody = "";
      apiRes.on("data", (d) => { resBody += d.toString(); });
      apiRes.on("end", () => {
        clearTimeout(timer);
        if (apiRes.statusCode !== 200) {
          return reject(new Error(`Anthropic API HTTP ${apiRes.statusCode}: ${resBody.slice(0, 500)}`));
        }
        try {
          const result = JSON.parse(resBody);
          let textContent = "";
          const toolCalls = [];
          for (const block of (result.content || [])) {
            if (block.type === "text") textContent += block.text;
            else if (block.type === "tool_use") {
              toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input) });
            }
          }
          resolve({
            content: textContent || null,
            toolCalls,
            usage: {
              prompt_tokens: result.usage?.input_tokens || 0,
              completion_tokens: result.usage?.output_tokens || 0,
              total_tokens: (result.usage?.input_tokens || 0) + (result.usage?.output_tokens || 0),
            },
            stopReason: result.stop_reason,
          });
        } catch (err) {
          reject(new Error(`Failed to parse Anthropic response: ${err.message}`));
        }
      });
    });

    apiReq.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    apiReq.write(bodyStr);
    apiReq.end();
  });
}

/**
 * Handle ALL requests via direct Anthropic API with token round-robin.
 * Supports both tool-enabled and text-only requests.
 */
async function handleApiDirect(body, model, stream, source, req, res) {
  const priority = MODEL_PRIORITY[model] || "normal";
  const estTokens = Math.min(Math.ceil(JSON.stringify(body.messages).length / 4), 5000);
  const reqId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  let release;
  try {
    release = await queue.acquire(source, priority);
  } catch (err) {
    return sendJson(res, 503, {
      error: { message: `Queue full: ${err.message}`, type: "queue_full", retry_after_ms: 10000 },
    }, { "retry-after": "10" });
  }

  let rateWaitTotal = 0;
  while (true) {
    const rateCheck = rateLimiter.check(model, estTokens);
    if (rateCheck.ok) break;
    if (rateWaitTotal >= 300000) {
      release();
      return sendJson(res, 503, {
        error: { message: "Rate limit wait exceeded", type: "rate_limit_timeout" },
      });
    }
    const sleepMs = Math.min(rateCheck.waitMs, 5000);
    await new Promise(r => setTimeout(r, sleepMs));
    rateWaitTotal += sleepMs;
  }

  rateLimiter.record(model, estTokens);
  eventLog.push("request", {
    reqId, mode: stream ? "stream_tools" : "sync_tools", model, source, priority,
    toolCount: body.tools?.length || 0,
  });
  sseBroadcast("request", {
    reqId, mode: stream ? "stream_tools" : "sync_tools", model, source, priority,
  });
  const tokenEntry = getNextToken();
  console.log(
    `[${ts()}] ${stream ? "STREAM" : "SYNC"}_API src=${source} model=${model} ` +
    `tools=${body.tools?.length || 0} token=${tokenEntry.name} reqId=${reqId}`
  );

  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    if (res.socket) res.socket.setNoDelay(true);

    streamFromAnthropicDirect(body, model, reqId, source, res, release, tokenEntry);
  } else {
    try {
      const result = await callAnthropicDirect(body, model, reqId, source, tokenEntry);
      release();
      tokenTracker.record(reqId, model, result.usage.prompt_tokens, result.usage.completion_tokens);
      eventLog.push("complete", {
        reqId, mode: "anthropic_direct_sync", model, source, ...result.usage,
      });
      sendJson(res, 200, completionResponseWithTools(
        reqId, result.content, result.toolCalls, model, result.usage,
      ));
    } catch (err) {
      release();
      console.error(`[${ts()}] TOOL_REQ_ERROR reqId=${reqId} src=${source} ${err.message}`);
      eventLog.push("error", { reqId, mode: "anthropic_direct", model, source, error: err.message });
      sendJson(res, 500, { error: { message: err.message, type: "anthropic_api_error" } });
    }
  }
}

// ============================================================
// Request handler: /v1/chat/completions
// ============================================================

async function handleCompletions(req, res) {
  const source = identifySource(req);
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    return sendJson(res, 400, { error: { message: "Invalid JSON body" } });
  }

  const { messages, model: rawModel = "claude-code", stream = false } = body;
  if (!messages || !Array.isArray(messages)) {
    return sendJson(res, 400, { error: { message: "messages array required" } });
  }

  // API direct path: only when CLI agent mode is off and tokens are available
  if (!USE_CLI_AGENTS && TOKEN_POOL.length > 0) {
    return handleApiDirect(body, resolveModel(rawModel), stream, source, req, res);
  }

  const { prompt, systemPrompt } = extractPrompt(messages);
  if (!prompt) {
    return sendJson(res, 400, { error: { message: "No user message found" } });
  }

  // Session affinity: derive a key so the same conversation sticks to the same worker
  const sessionKey = sessionAffinity.deriveKey({
    source,
    sessionId: req.headers["x-session-id"] || "",
    systemPrompt: systemPrompt || "",
  });

  const model = resolveModel(rawModel);
  const priority = MODEL_PRIORITY[model] || "normal";
  // Estimated tokens for rate-limiter: use a small fixed cap.
  // chars/4 wildly over-estimates (code/JSON has low token density).
  // The real rate limit is Anthropic's 429 response; our limiter is
  // just a courtesy throttle.  Cap at 5000 so ~11 opus requests/min
  // can coexist (57000/5000).  If Anthropic 429s, the retry loop handles it.
  const estTokens = Math.min(Math.ceil(prompt.length / 4), 5000);
  const reqId = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;

  // Acquire slot via fair queue (waits for turn, never rejects)
  let release;
  try {
    release = await queue.acquire(source, priority);
  } catch (err) {
    // Only rejects if queue is truly full (100+ pending)
    console.log(`[${ts()}] QUEUE_FULL src=${source} model=${model} ${err.message}`);
    return sendJson(res, 503, {
      error: { message: `Queue full, try again shortly: ${err.message}`, type: "queue_full", retry_after_ms: 10000 },
    }, { "retry-after": "10" });
  }

  // Wait for rate limit window (sleep instead of rejecting)
  let rateWaitTotal = 0;
  const MAX_RATE_WAIT_MS = 300000;
  while (true) {
    const rateCheck = rateLimiter.check(model, estTokens);
    if (rateCheck.ok) break;
    if (rateWaitTotal >= MAX_RATE_WAIT_MS) {
      release();
      console.log(`[${ts()}] RATE_TIMEOUT src=${source} model=${model} waited ${rateWaitTotal}ms`);
      return sendJson(res, 503, {
        error: { message: `Rate limit wait exceeded ${MAX_RATE_WAIT_MS}ms`, type: "rate_limit_timeout" },
      });
    }
    const sleepMs = Math.min(rateCheck.waitMs, 5000);
    console.log(`[${ts()}] RATE_WAIT src=${source} model=${model} sleeping ${sleepMs}ms (${rateCheck.reason})`);
    await new Promise((r) => setTimeout(r, sleepMs));
    rateWaitTotal += sleepMs;
  }

  rateLimiter.record(model, estTokens);
  eventLog.push("request", { reqId, mode: stream ? "stream" : "sync", model, source, priority });
  sseBroadcast("request", { reqId, mode: stream ? "stream" : "sync", model, source, priority, promptPreview: prompt.slice(0, 80) });
  console.log(`[${ts()}] ${stream ? "STREAM" : "SYNC"} src=${source} model=${model} prio=${priority} session=${sessionKey.slice(0, 30)} prompt=${prompt.slice(0, 60)}...`);

  if (stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",       // hint to reverse proxies: don't buffer
    });
    res.flushHeaders();                 // force headers out immediately
    if (res.socket) {
      res.socket.setNoDelay(true);      // disable Nagle — send chunks immediately
    }

    // Stream with auto-retry: if a worker fails quickly (<5s, no content),
    // automatically retry on a different worker before giving up.
    // If ALL CLI routers fail, fall back to the API endpoint (e.g. MiniMax).
    const QUICK_FAIL_MS = 5000;
    const MAX_RETRIES = _workerPool.length;  // try each router once
    const inputEstimate = Math.ceil(prompt.length / 4);
    const originalMessages = messages;  // preserve for fallback API
    let retryCount = 0;
    const triedRouters = new Set();
    let activeProc = null;  // track current CLI process for client-disconnect cleanup

    // If client disconnects, kill the CLI process to free resources
    res.on("close", () => {
      if (activeProc && !activeProc.killed) {
        console.log(`[${ts()}] CLIENT_DISCONNECT reqId=${reqId} — killing CLI pid=${activeProc.pid}`);
        try { activeProc.kill("SIGTERM"); } catch { /* ignore */ }
      }
    });

    function pipeStream(workerOverride, isRetry) {
      const worker = workerOverride || getNextWorker(sessionKey);
      // Bind this session to the chosen worker
      sessionAffinity.assign(sessionKey, worker.name);
      triedRouters.add(worker.name);
      console.log(`[${ts()}] CLIROUTER obj=${worker.name} bin=${worker.bin} reqId=${reqId} model=${model} src=${source}${isRetry ? ` RETRY#${retryCount}` : ""}`);
      recordWorkerRequest(worker.name);
      workerAcquire(worker.name);
      const proc = spawnCliStream(prompt, model, systemPrompt, worker);
      activeProc = proc;  // update for client-disconnect handler
      trackStreamProc(proc, reqId, model, source, worker);

      let buffer = "";
      let stderrBuf = "";
      let sentContent = false;
      let reqTokens = { input: 0, output: 0 };
      let outputChars = 0;

      proc.stderr.on("data", (d) => { stderrBuf += d.toString(); });

      const heartbeatMs = HEARTBEAT_BY_MODEL[model] || DEFAULT_HEARTBEAT_MS;
      let heartbeatTimer = setTimeout(() => {
        eventLog.push("timeout", { kind: "heartbeat", pid: proc.pid, reqId, model, source, heartbeatMs });
        console.log(`[${ts()}] HEARTBEAT_TIMEOUT pid=${proc.pid} reqId=${reqId} model=${model} src=${source} limit=${heartbeatMs}ms`);
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      }, heartbeatMs);

      function resetHeartbeat() {
        clearTimeout(heartbeatTimer);
        heartbeatTimer = setTimeout(() => {
          eventLog.push("timeout", { kind: "heartbeat", pid: proc.pid, reqId, model, source, heartbeatMs });
          console.log(`[${ts()}] HEARTBEAT_TIMEOUT pid=${proc.pid} reqId=${reqId} model=${model} src=${source} limit=${heartbeatMs}ms`);
          try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        }, heartbeatMs);
      }

      const execTimer = setTimeout(() => {
        eventLog.push("timeout", { kind: "stream_exec", pid: proc.pid, reqId, model });
        console.log(`[${ts()}] STREAM_TIMEOUT pid=${proc.pid} reqId=${reqId} model=${model} age=${STREAM_TIMEOUT_MS}ms`);
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
      }, STREAM_TIMEOUT_MS);

      // SSE keepalive: send comment lines to prevent upstream (Gateway) HTTP timeout.
      // SSE spec allows `:comment\n\n` — client parsers ignore it but the TCP stays alive.
      const SSE_KEEPALIVE_MS = 30_000; // every 30s
      const keepaliveInterval = setInterval(() => {
        if (!res.writableEnded) {
          try { res.write(":keepalive\n\n"); } catch { /* ignore write errors */ }
        }
      }, SSE_KEEPALIVE_MS);

      proc.stdout.on("data", (data) => {
        resetHeartbeat();
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line);
            const canWrite = !res.writableEnded;
            // stream_event: incremental deltas from --include-partial-messages
            if (ev.type === "stream_event" && ev.event?.type === "content_block_delta") {
              const text = ev.event.delta?.text;
              if (text) {
                if (canWrite) res.write(sseChunk(reqId, text));
                outputChars += text.length;
                sentContent = true;
                sseBroadcast("chunk", { reqId, model, source, text, tokens: outputChars });
              }
            } else if (ev.type === "stream_event" && ev.event?.type === "message_delta") {
              const usage = ev.event.usage;
              if (usage) {
                // Total input = non-cached + cache-created + cache-read
                const totalInput = (usage.input_tokens || 0)
                  + (usage.cache_creation_input_tokens || 0)
                  + (usage.cache_read_input_tokens || 0);
                reqTokens = { input: totalInput, output: usage.output_tokens || 0 };
              }
            } else if (ev.type === "assistant" && ev.message?.content) {
              if (!sentContent) {
                for (const b of ev.message.content) {
                  if (b.type === "text" && b.text) {
                    if (canWrite) res.write(sseChunk(reqId, b.text));
                    outputChars += b.text.length;
                    sentContent = true;
                    sseBroadcast("chunk", { reqId, model, source, text: b.text, tokens: outputChars });
                  }
                }
              }
            } else if (ev.type === "content_block_delta" && ev.delta?.text) {
              if (canWrite) res.write(sseChunk(reqId, ev.delta.text));
              outputChars += ev.delta.text.length;
              sentContent = true;
              sseBroadcast("chunk", { reqId, model, source, text: ev.delta.text, tokens: outputChars });
            } else if (ev.type === "result" && ev.result && !sentContent) {
              if (canWrite) res.write(sseChunk(reqId, ev.result));
              sentContent = true;
            }
            // Capture token usage (include cached tokens in total input)
            const usage = ev.usage || ev.message?.usage;
            if (usage) {
              const totalInput = (usage.input_tokens || usage.prompt_tokens || 0)
                + (usage.cache_creation_input_tokens || 0)
                + (usage.cache_read_input_tokens || 0);
              reqTokens = {
                input: totalInput,
                output: usage.output_tokens || usage.completion_tokens || 0,
              };
            }
          } catch { /* non-JSON line, skip */ }
        }
        if (proc.pid) {
          const liveInput = reqTokens.input > 0 ? reqTokens.input : inputEstimate;
          const liveOutput = reqTokens.output > 0 ? reqTokens.output : Math.ceil(outputChars / 4);
          registry.touch(proc.pid, { liveInputTokens: liveInput, liveOutputTokens: liveOutput });
        }
      });

      proc.on("close", (code) => {
        clearTimeout(heartbeatTimer);
        clearTimeout(execTimer);
        clearInterval(keepaliveInterval);
        workerRelease(worker.name);

        // Quick-fail auto-retry: if worker failed fast with no content, try another
        const elapsed = Date.now() - proc._spawnedAt;
        if (code !== 0 && !sentContent && elapsed < QUICK_FAIL_MS && retryCount < MAX_RETRIES) {
          // Find an untried router, or any alternate
          const untried = _workerPool.find(
            (w) => !triedRouters.has(w.name) && !_workerHealth.get(w.name)?.limited
          );
          const alt = untried || getAlternateWorker(worker.name);
          if (alt) {
            retryCount++;
            console.log(`[${ts()}] STREAM_RETRY reqId=${reqId} failedRouter=${worker.name} code=${code} elapsed=${elapsed}ms -> retrying on ${alt.name} (attempt ${retryCount}/${MAX_RETRIES})`);
            recordWorkerError(worker.name, "stream_retry", `code=${code} elapsed=${elapsed}ms`);
            eventLog.push("retry", { reqId, model, source, failedWorker: worker.name, retryWorker: alt.name, code, elapsed, retryCount });
            pipeStream(alt, true);
            return;  // don't finalize response — retry will handle it
          }
        }

        release();
        if (code !== 0) {
          const diag = stderrBuf.trim() || buffer.trim().slice(0, 200) || "(no output)";
          console.log(`[${ts()}] CLI_EXIT reqId=${reqId} code=${code} sent=${sentContent} router=${worker.name} stderr=${diag.slice(0, 300)}`);
          const errCat = code === 143 ? "cli_killed" : "cli_crash";
          recordWorkerError(worker.name, errCat, `code=${code} ${diag.slice(0, 100)}`);
        }
        if (proc._workerName && (isRateLimitError(code, stderrBuf) || (!sentContent && isRateLimitError(code, buffer)))) {
          markWorkerLimited(proc._workerName);
        }
        // Flush remaining buffer
        const canWrite = !res.writableEnded;
        if (buffer.trim()) {
          try {
            const ev = JSON.parse(buffer);
            if (ev.type === "assistant" && ev.message?.content) {
              for (const b of ev.message.content) {
                if (b.type === "text" && b.text && canWrite) res.write(sseChunk(reqId, b.text));
              }
            } else if (ev.type === "result" && ev.result && !sentContent && canWrite) {
              res.write(sseChunk(reqId, ev.result));
            }
            const usage = ev.usage || ev.message?.usage;
            if (usage) {
              const totalInput = (usage.input_tokens || usage.prompt_tokens || 0)
                + (usage.cache_creation_input_tokens || 0)
                + (usage.cache_read_input_tokens || 0);
              reqTokens = { input: totalInput, output: usage.output_tokens || usage.completion_tokens || 0 };
            }
          } catch { /* ignore */ }
        }
        const finalInput = reqTokens.input > 0 ? reqTokens.input : inputEstimate;
        const finalOutput = reqTokens.output > 0 ? reqTokens.output : Math.ceil(outputChars / 4);
        tokenTracker.record(reqId, model, finalInput, finalOutput);
        eventLog.push("complete", {
          reqId, mode: "stream", model, source, exitCode: code,
          inputTokens: finalInput, outputTokens: finalOutput,
        });
        sseBroadcast("complete", { reqId, model, source, exitCode: code, inputTokens: finalInput, outputTokens: finalOutput });
        if (code !== 0 && !sentContent) {
          // All CLI routers failed — fall back to API endpoint
          console.log(`[${ts()}] ALL_CLI_FAILED reqId=${reqId} retryCount=${retryCount} -> falling back to ${FALLBACK_API.name}`);
          streamFromFallbackApi(originalMessages, model, reqId, source, res);
          return;  // fallback handles res.end()
        }
        if (canWrite) {
          res.write(sseChunk(reqId, null, "stop"));
          res.write("data: [DONE]\n\n");
          res.end();
        }
      });

      proc.on("error", (err) => {
        clearTimeout(heartbeatTimer);
        clearTimeout(execTimer);
        clearInterval(keepaliveInterval);
        workerRelease(worker.name);
        // Quick-fail auto-retry on spawn error too
        if (!sentContent && retryCount < MAX_RETRIES) {
          const untried = _workerPool.find(
            (w) => !triedRouters.has(w.name) && !_workerHealth.get(w.name)?.limited
          );
          const alt = untried || getAlternateWorker(worker.name);
          if (alt) {
            retryCount++;
            console.log(`[${ts()}] STREAM_RETRY reqId=${reqId} failedRouter=${worker.name} error=${err.message} -> retrying on ${alt.name} (attempt ${retryCount}/${MAX_RETRIES})`);
            pipeStream(alt, true);
            return;
          }
        }
        release();
        // All CLI routers errored — fall back to API endpoint
        console.log(`[${ts()}] ALL_CLI_FAILED reqId=${reqId} error=${err.message} -> falling back to ${FALLBACK_API.name}`);
        streamFromFallbackApi(originalMessages, model, reqId, source, res);
      });
    }

    // Start the stream pipeline (first attempt, no retry flag)
    pipeStream(null, false);
  } else {
    try {
      const result = await runCli(prompt, model, systemPrompt, reqId, source, sessionKey);
      release();
      // Estimate tokens for sync: prompt chars/4 for input, result chars/4 for output
      const syncInputTokens = Math.ceil(prompt.length / 4);
      const syncOutputTokens = Math.ceil(result.length / 4);
      tokenTracker.record(reqId, model, syncInputTokens, syncOutputTokens);
      eventLog.push("complete", {
        reqId, mode: "sync", model, source,
        inputTokens: syncInputTokens, outputTokens: syncOutputTokens,
      });
      sendJson(res, 200, completionResponse(reqId, result, model));
    } catch (err) {
      release();
      eventLog.push("error", { reqId, mode: "sync", model, source, error: err.message });
      console.error(`[${ts()}] ERROR src=${source} ${err.message}`);
      sendJson(res, 500, { error: { message: err.message, type: "internal_error" } });
    }
  }
}

// ============================================================
// Other endpoints
// ============================================================

function handleModels(req, res) {
  const models = Object.keys(MODEL_MAP).map((id) => ({
    id: `claude-code/${id}`,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "claude-code-proxy",
  }));
  sendJson(res, 200, { object: "list", data: models });
}

function handleHealth(req, res) {
  const qs = queue.getStats();
  const rs = registry.getStats();
  const workers = _workerPool.map((w) => {
    const h = _workerHealth.get(w.name);
    return {
      name: w.name,
      bin: w.bin,
      limited: h.limited,
      limitedAt: h.limitedAt || null,
      limitedAgoSec: h.limited ? Math.round((Date.now() - h.limitedAt) / 1000) : null,
    };
  });
  sendJson(res, 200, {
    status: "ok",
    version: "0.5.1",
    claude_bin: CLAUDE_BIN,
    port: PORT,
    redis: redis ? { connected: redis.isReady() } : { connected: false },
    cliRouters: workers,
    primaryRouter: PRIMARY_WORKER,
    queue: { active: qs.active, queued: qs.totalQueued, max: qs.maxConcurrent, sources: qs.sourceCount },
    processes: { tracked: rs.total, byMode: rs.byMode, liveTokens: rs.liveTokens },
    tokens: tokenTracker.getTotals(),
    sessionAffinity: sessionAffinity.getStats(),
    workerStats,
  });
}

function handleMetrics(req, res) {
  const qs = queue.getStats();
  const rs = registry.getStats();
  const workers = _workerPool.map((w) => {
    const h = _workerHealth.get(w.name);
    return { name: w.name, limited: h.limited, limitedAt: h.limitedAt || null };
  });
  sendJson(res, 200, {
    rateLimits: RATE_LIMITS,
    rateUsage: rateLimiter.stats(),
    tokens: tokenTracker.getStats(),
    cliRouters: workers,
    loadBalanceMode: _loadBalanceMode,
    primaryRouter: PRIMARY_WORKER,
    queue: qs,
    processes: rs,
    config: {
      useCliAgents: USE_CLI_AGENTS,
      workerCount: _workerPool.length,
      loadBalanceAlgorithm: "least-connections",
      maxConcurrent: MAX_CONCURRENT,
      maxQueueTotal: MAX_QUEUE_TOTAL,
      maxQueuePerSource: MAX_QUEUE_PER_SOURCE,
      queueTimeoutMs: QUEUE_TIMEOUT_MS,
      heartbeatByModel: HEARTBEAT_BY_MODEL,
      defaultHeartbeatMs: DEFAULT_HEARTBEAT_MS,
      streamTimeoutMs: STREAM_TIMEOUT_MS,
      syncTimeoutMs: SYNC_TIMEOUT_MS,
      maxProcessAgeMs: MAX_PROCESS_AGE_MS,
      maxIdleMs: MAX_IDLE_MS,
      reaperIntervalMs: REAPER_INTERVAL_MS,
      sessionAffinityTtlMs: 5 * 60 * 1000,
      sseKeepaliveMs: 30_000,
      maxRetries: MAX_RETRIES,
      retryBaseMs: RETRY_BASE_MS,
    },
    sessionAffinity: sessionAffinity.getStats(),
    workerStats,
    activeConnections: Object.fromEntries(_activeConns),
  });
}

function handleZombies(req, res) {
  const zombies = registry.getZombies();
  const qs = queue.getStats();
  sendJson(res, 200, {
    processes: registry.getAll(),
    zombies,
    stats: registry.getStats(),
    activeLeases: qs.activeLeases,
  });
}

async function handleKillZombie(req, res) {
  const body = await readBody(req);
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return sendJson(res, 400, { error: { message: "Invalid JSON body" } });
  }

  const { pid } = parsed;
  if (!pid) return sendJson(res, 400, { error: { message: "pid required" } });

  const result = registry.kill(Number(pid));
  eventLog.push("kill", { pid: Number(pid), manual: true });
  sendJson(res, 200, { result });
}

function handleEvents(req, res, url) {
  const sinceId = parseInt(url.searchParams.get("since_id") || "0", 10);
  const limit = parseInt(url.searchParams.get("limit") || "50", 10);
  const type = url.searchParams.get("type") || null;
  const events = eventLog.getRecent({ sinceId, limit, type });
  sendJson(res, 200, { events, counts: eventLog.getCounts() });
}

function handleMetricsHistory(req, res, url) {
  const window = url.searchParams.get("window") || "1h";
  const validWindows = ["1h", "6h", "1d", "7d"];
  if (!validWindows.includes(window)) {
    return sendJson(res, 400, { error: { message: `Invalid window. Use: ${validWindows.join(", ")}` } });
  }
  const points = metricsStore.query(window);
  sendJson(res, 200, { window, points, count: points.length, bufferSize: metricsStore.getBufferSize() });
}

async function handlePortal(req, res) {
  try {
    const html = await readFile(join(__dirname, "portal.html"), "utf-8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    sendJson(res, 500, { error: { message: "Portal file not found: " + err.message } });
  }
}

async function handleProxyDashboard(req, res) {
  try {
    const html = await readFile(join(__dirname, "dashboard.html"), "utf-8");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  } catch (err) {
    sendJson(res, 500, { error: { message: "Dashboard file not found: " + err.message } });
  }
}

// ============================================================
// Utilities
// ============================================================

function ts() {
  return new Date().toISOString();
}

function sendJson(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function handleSSEStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    "connection": "keep-alive",
  });
  res.write("event: connected\ndata: {}\n\n");

  sseClients = new Set([...sseClients, res]);
  console.log(`[${ts()}] SSE_CLIENT connected (${sseClients.size} total)`);

  req.on("close", () => {
    sseClients = new Set([...sseClients].filter((c) => c !== res));
    console.log(`[${ts()}] SSE_CLIENT disconnected (${sseClients.size} total)`);
  });
}

// ============================================================
// HTTP Server
// ============================================================

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://0.0.0.0:${PORT}`);

  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, authorization, x-api-key, x-openclaw-source, x-source, x-session-id");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Auth check (skip for health, dashboard, events)
  const noAuthPaths = ["/health", "/dashboard", "/dashboard/", "/dashboard/proxy", "/dashboard/proxy/", "/events", "/metrics/history", "/stream"];
  if (!noAuthPaths.includes(url.pathname) && !authenticate(req)) {
    return sendJson(res, 401, { error: { message: "Unauthorized" } });
  }

  try {
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      await handleCompletions(req, res);
    } else if (url.pathname === "/v1/models" && req.method === "GET") {
      handleModels(req, res);
    } else if (url.pathname === "/health" && req.method === "GET") {
      handleHealth(req, res);
    } else if (url.pathname === "/metrics" && req.method === "GET") {
      handleMetrics(req, res);
    } else if (url.pathname === "/rate-limits" && req.method === "GET") {
      handleMetrics(req, res); // backward compat
    } else if (url.pathname === "/zombies" && req.method === "GET") {
      handleZombies(req, res);
    } else if (url.pathname === "/zombies" && req.method === "POST") {
      await handleKillZombie(req, res);
    } else if (url.pathname === "/events" && req.method === "GET") {
      handleEvents(req, res, url);
    } else if (url.pathname === "/metrics/history" && req.method === "GET") {
      handleMetricsHistory(req, res, url);
    } else if (url.pathname === "/stream" && req.method === "GET") {
      handleSSEStream(req, res);
    } else if (url.pathname === "/dashboard/proxy" || url.pathname === "/dashboard/proxy/") {
      await handleProxyDashboard(req, res);
    } else if (url.pathname === "/dashboard" || url.pathname === "/dashboard/") {
      await handlePortal(req, res);
    } else {
      sendJson(res, 404, { error: { message: "Not found" } });
    }
  } catch (err) {
    console.error(`[${ts()}] UNHANDLED ${err.message}`);
    sendJson(res, 500, { error: { message: "Internal server error" } });
  }
});

// ============================================================
// Graceful shutdown
// ============================================================

function shutdown(signal) {
  console.log(`[${ts()}] SHUTDOWN signal=${signal}`);

  // Kill all tracked processes
  const allProcs = registry.getAll();
  for (const entry of allProcs) {
    console.log(`[${ts()}] SHUTDOWN_KILL pid=${entry.pid} reqId=${entry.requestId} model=${entry.model}`);
    registry.kill(entry.pid);
  }

  registry.destroy();
  queue.destroy();
  metricsStore.destroy();
  sessionAffinity.shutdown();

  // Close Redis connection
  if (redis) {
    redis.quit().catch(() => {});
  }

  server.close(() => {
    console.log(`[${ts()}] SHUTDOWN complete`);
    process.exit(0);
  });

  // Force exit after 5s if graceful close hangs
  setTimeout(() => {
    console.error(`[${ts()}] SHUTDOWN forced after 5s timeout`);
    process.exit(1);
  }, 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ============================================================
// Start server
// ============================================================

server.listen(PORT, "0.0.0.0", async () => {
  // Wait for all persistent stores to load from Redis / files
  await Promise.all([
    metricsStore.ready,
    tokenTracker.ready,
    eventLog.ready,
    registry.ready,
  ]);

  eventLog.push("startup", { version: "0.5.0", port: PORT, redis: !!redis });

  // Seed token tracker from all raw metrics snapshots (sums across server restarts)
  const rawSnapshots = metricsStore.getRawBuffer();
  tokenTracker.seedFromHistory(rawSnapshots);

  metricsStore.startSampler(gatherMetricsSnapshot);

  console.log(`Claude Code Proxy v0.5.1`);
  console.log(`Listening on http://0.0.0.0:${PORT}`);
  console.log(`CLI Routers: ${_workerPool.map((w) => `obj${w.name}=${w.bin}`).join(" | ")} | Primary: obj${PRIMARY_WORKER}`);
  console.log(`Auth token: ${AUTH_TOKEN === "local-proxy" ? "(open - no auth)" : "(enabled)"}`);
  console.log(`Concurrent: ${MAX_CONCURRENT} | Queue: ${MAX_QUEUE_TOTAL} total, ${MAX_QUEUE_PER_SOURCE}/source`);
  console.log(`Queue timeout: ${QUEUE_TIMEOUT_MS}ms`);
  console.log(`Models: ${Object.keys(MODEL_MAP).join(", ")}`);
  console.log(`Rate limits: sonnet ${RATE_LIMITS.sonnet.requestsPerMin}/min, opus ${RATE_LIMITS.opus.requestsPerMin}/min, haiku ${RATE_LIMITS.haiku.requestsPerMin}/min`);
  console.log(`Reaper: age=${MAX_PROCESS_AGE_MS}ms idle=${MAX_IDLE_MS}ms interval=${REAPER_INTERVAL_MS}ms`);
  console.log(`Timeouts: sync=${SYNC_TIMEOUT_MS}ms stream=${STREAM_TIMEOUT_MS}ms`);
  console.log(`Heartbeat: opus=${HEARTBEAT_BY_MODEL.opus}ms sonnet=${HEARTBEAT_BY_MODEL.sonnet}ms haiku=${HEARTBEAT_BY_MODEL.haiku}ms`);
  console.log(`Metrics store: ${metricsStore.getBufferSize()} historical snapshots loaded`);
});
