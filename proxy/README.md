# Claude Code Proxy

OpenAI-compatible API proxy that routes requests through Claude Code CLI workers. Supports both text-only and tool-enabled (autonomous agent) modes.

## Features

- **Dual mode**: CLI autonomous agents (`USE_CLI_AGENTS=true`) or direct Anthropic API
- **Multi-worker round-robin**: Load balance across multiple Claude Code CLI instances
- **Session affinity**: Same conversation sticks to same worker (30min TTL)
- **Fair queue**: Concurrency control with per-source queuing
- **Rate limiting**: Per-model request/token rate limits
- **Live dashboard**: Real-time monitoring with worker traffic, error stats, SSE stream
- **Process reaper**: Auto-kill stale/zombie CLI processes
- **Token tracking**: Per-model input/output token accounting
- **Retry logic**: Automatic retry on worker failure with fallback
- **Prompt truncation**: Handles oversized prompts gracefully

## Quick Start

```bash
# Install dependencies
npm install

# Set required environment variables
export WORKERS='[{"name":"1","bin":"/path/to/claude","token":"your-oauth-token"}]'
export CLAUDE_PROXY_PORT=8403

# Start
npm start
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_PROXY_PORT` | `8403` | HTTP listen port |
| `WORKERS` | (required) | JSON array of CLI worker configs |
| `PRIMARY_WORKER` | `1` | Default worker name |
| `USE_CLI_AGENTS` | `false` | Enable autonomous CLI agent mode |
| `PROXY_AUTH_TOKEN` | `local-proxy` | Bearer token for API auth (set to secure value in production) |
| `MAX_CONCURRENT` | `10` | Max concurrent CLI processes |
| `MAX_QUEUE_TOTAL` | `100` | Max total queued requests |
| `MAX_QUEUE_PER_SOURCE` | `20` | Max queued per source |
| `QUEUE_TIMEOUT_MS` | `120000` | Queue wait timeout |
| `STREAM_TIMEOUT_MS` | `1800000` | Stream response timeout |
| `SYNC_TIMEOUT_MS` | `600000` | Sync response timeout |
| `MAX_PROCESS_AGE_MS` | `1800000` | Max CLI process lifetime |
| `MAX_IDLE_MS` | `600000` | Max idle time before reap |
| `ANTHROPIC_API_KEY` | - | For direct API mode (fallback) |
| `CLAUDE_CODE_OAUTH_TOKEN` | - | OAuth token for API direct mode |

## Worker Config Format

```json
[
  {"name": "1", "bin": "/path/to/claude", "token": "oauth-token-1"},
  {"name": "2", "bin": "/path/to/claude", "token": "oauth-token-2"}
]
```

Each worker uses an independent Claude Code OAuth token, enabling independent rate limits.

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | OpenAI-compatible chat completions |
| `GET /health` | Health check |
| `GET /dashboard/proxy` | Live monitoring dashboard |
| `GET /metrics` | JSON metrics (queue, processes, tokens, worker stats) |
| `GET /metrics/history` | Time-series data for charts |
| `GET /events` | Event log (polling) |
| `GET /stream` | SSE real-time stream feed |
| `GET /zombies` | Zombie process inspector |
| `POST /kill` | Kill a specific CLI process |

## Architecture

```
Client (OpenAI format) → Proxy → Fair Queue → Worker Pool → Claude CLI
                                                            ↓
                                                   Autonomous agent
                                                   (SSH, browser, files)
                                                            ↓
                                                   Response → Client
```

## Dashboard

Access at `http://localhost:8403/dashboard/proxy`:

- Token usage overview (total + per model)
- Time-series charts (tokens/requests per interval)
- Live SSE stream viewer
- Queue & health metrics
- Worker traffic distribution
- Error category breakdown
- Active process table
- Event log

## Tests

```bash
npm test
```

## License

MIT
