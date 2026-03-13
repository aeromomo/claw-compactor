<!--
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  "name": "Claw Compactor",
  "description": "Open-source LLM token compression tool that reduces AI agent costs by up to 97% using 5-layer deterministic context compression",
  "applicationCategory": "DeveloperApplication",
  "operatingSystem": "Cross-platform",
  "softwareVersion": "1.0.0",
  "license": "https://opensource.org/licenses/MIT",
  "url": "https://github.com/aeromomo/claw-compactor",
  "downloadUrl": "https://github.com/aeromomo/claw-compactor",
  "author": {
    "@type": "Organization",
    "name": "OpenClaw",
    "url": "https://openclaw.ai"
  },
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD"
  },
  "keywords": "token compression, LLM, AI agent, prompt compression, context window optimization, cost reduction"
}
</script>
-->

# Claw Compactor — LLM Token Compression & Context Reduction Tool

![Claw Compactor Banner](assets/banner.png)

[![Build](https://img.shields.io/badge/build-passing-brightgreen)](https://github.com/aeromomo/claw-compactor)
[![Tests](https://img.shields.io/badge/tests-848%20passed-brightgreen)](https://github.com/aeromomo/claw-compactor)
[![Python](https://img.shields.io/badge/python-3.9%2B-blue)](https://python.org)
[![License](https://img.shields.io/badge/license-MIT-purple)](LICENSE)
[![OpenClaw](https://img.shields.io/badge/OpenClaw-skill-orange)](https://openclaw.ai)
[![Release](https://img.shields.io/github/v/release/aeromomo/claw-compactor?color=blue)](https://github.com/aeromomo/claw-compactor/releases)
[![Stars](https://img.shields.io/github/stars/aeromomo/claw-compactor?style=social)](https://github.com/aeromomo/claw-compactor)
[![PyPI](https://img.shields.io/pypi/v/claw-compactor?color=blue)](https://pypi.org/project/claw-compactor/)
[![Downloads](https://img.shields.io/github/downloads/aeromomo/claw-compactor/total)](https://github.com/aeromomo/claw-compactor/releases)

> **The open-source LLM token compression tool that cuts AI agent costs by up to 97%.**

---

## What is Claw Compactor?

**Claw Compactor** is an open-source **LLM token compression** engine that reduces AI agent costs by up to 97%. It compresses workspace memory, session transcripts, and prompt context using 5 deterministic compression layers — completely free, with **no LLM inference required**.

If you're building AI agents with large context windows (100K+ tokens), Claw Compactor can save you thousands of dollars per month by compressing what gets loaded into the model context before it reaches the LLM.

Built for [OpenClaw](https://openclaw.ai) agents. Works with **any LLM workflow** — ChatGPT, Claude, GPT-4, Gemini, Llama, or any OpenAI-compatible API — that needs **token saving** and **prompt compression**.

### Who Should Use Claw Compactor?

- **AI agent developers** building autonomous agents (OpenClaw, AutoGPT, CrewAI, LangChain, Semantic Kernel)
- **LLM application builders** managing large context windows with ChatGPT, Claude, or GPT-4
- **Teams running multi-agent systems** where token costs multiply across sub-agents
- **Anyone paying for LLM API calls** who wants to reduce their bill without losing context quality
- **Open-source AI projects** looking for free, deterministic prompt compression

---

## Why Token Compression Matters

Every token you send to an LLM costs money. As context windows grow, so does spending:

| Scenario | Typical Context Size | Monthly Cost (Opus) |
|----------|---------------------|---------------------|
| AI coding agent | 100K tokens/session | $500–$2,000 |
| Multi-agent orchestration | 200K+ tokens | $2,000–$10,000 |
| Autonomous agent (24/7) | 1M+ tokens/day | $10,000+ |

**Claw Compactor** performs **LLM token compression** at the workspace level — reducing what gets loaded into context before it reaches the model. Less tokens in = less cost out.

---

## Key Features

- 🔥 **Up to 97% token reduction** on session transcripts
- 📉 **50–70% token compression** on first run across any workspace
- 🧮 **5 compression layers** working in sequence for maximum token saving
- 💰 **Zero LLM cost** — all compression is rule-based and deterministic
- 🔄 **Lossless roundtrip** for dictionary, RLE, and rule-based token compression
- 📊 **Tiered summaries** (L0/L1/L2) for progressive context loading and token reduction
- 🌏 **CJK-aware** — full Chinese/Japanese/Korean token compression support
- ⚡ **One command** (`full`) runs the entire token compression pipeline
- 🪝 **Auto-compress hook** (v7.0) — compress on every file change, zero config

---

## How It Works: 5-Layer Token Compression Pipeline

Claw Compactor applies 5 sequential compression layers to achieve maximum **token reduction**:

| Layer | Technique | What It Does | Token Savings |
|-------|-----------|-------------|---------------|
| 1 | **Rule engine** | Dedup lines, strip markdown filler, merge sections | 4–8% |
| 2 | **Dictionary encoding** | Auto-learned codebook, `$XX` token substitution | 4–5% |
| 3 | **Observation compression** | Session JSONL → structured summaries | **~97%** |
| 4 | **RLE patterns** | Path shorthand (`$WS`), IP prefix, enum compaction | 1–2% |
| 5 | **Compressed Context Protocol** | ultra/medium/light abbreviation | 20–60% |

Layers 1, 2, and 4 are **fully lossless** — perfect roundtrip decompression. Layers 3 and 5 are lossy but **preserve all facts, decisions, and context** — only verbose formatting is removed.

---

## Quick Start

```bash
# Clone the token compression tool
git clone https://github.com/aeromomo/claw-compactor.git
cd claw-compactor

# Benchmark: see how many tokens you'd save (non-destructive)
python3 scripts/mem_compress.py /path/to/workspace benchmark

# Compress: run full token compression pipeline
python3 scripts/mem_compress.py /path/to/workspace full

# Auto-compress: compress on every file change (v7.0+)
python3 scripts/mem_compress.py /path/to/workspace auto
```

**Requirements:** Python 3.9+. Optional: `pip install tiktoken` for exact token counts (falls back to CJK-aware heuristic).

---

## Token Compression Commands

All commands: `python3 scripts/mem_compress.py <workspace> <command> [options]`

| Command | Description | Token Savings |
|---------|-------------|---------------|
| `full` | Complete token compression pipeline (all layers) | **50%+ combined** |
| `benchmark` | Dry-run token reduction report | — |
| `compress` | Rule-based token compression | 4–8% |
| `dict` | Dictionary encoding with auto-codebook | 4–5% |
| `observe` | Session transcript → observation compression | **~97%** |
| `tiers` | Generate L0/L1/L2 token-reduced summaries | 88–95% |
| `dedup` | Cross-file duplicate token detection | varies |
| `estimate` | Token count report | — |
| `audit` | Workspace health check | — |
| `optimize` | Tokenizer-level format optimization | 1–3% |
| `auto` | Watch and auto-compress on file changes | continuous |

### Options
- `--json` — Machine-readable JSON output
- `--dry-run` — Preview token savings without writing
- `--since YYYY-MM-DD` — Filter sessions by date
- `--auto-merge` — Auto-merge duplicates (dedup)
- `--report` — Print token savings summary
- `--quiet` — Suppress output (for hook/automation use)
- `--changed-file <path>` — Compress a single changed file (hook mode)

---

## Real-World Token Savings

| Use Case | Token Reduction | Notes |
|----------|----------------|-------|
| Session transcripts (`observe`) | **~97%** | Megabytes of JSONL → concise observation MD |
| Verbose/new workspace | **50–70%** | First run on unoptimized workspace |
| Regular maintenance | **10–20%** | Weekly token compression on active workspace |
| Already-optimized | **3–12%** | Diminishing returns — workspace is clean |

### Benchmark Example

```
$ python3 scripts/mem_compress.py ~/workspace benchmark

Claw Compactor — Token Compression Benchmark
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before:  167,821 tokens
After:   157,376 tokens
Saved:    10,445 tokens (6.2%)

Breakdown:
  Rule compression:     2,100 tokens saved
  Dictionary encoding:  1,800 tokens saved
  RLE patterns:           445 tokens saved
  Format optimization:  6,100 tokens saved
```

---

## Token Compression + Prompt Caching = Maximum Savings

Combine Claw Compactor's **token compression** with LLM **prompt caching** for compound savings:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "anthropic/claude-opus-4-6": {
          "params": {
            "cacheRetention": "long"
          }
        }
      }
    }
  }
}
```

- **Token compression** reduces the number of tokens sent
- **Prompt caching** reduces the cost per cached token by 90%
- **Combined:** 50% token reduction + 90% cache discount = **95% effective cost reduction**

---

## Auto-Compress Hook (v7.0+)

Claw Compactor can automatically compress files every time your AI agent writes or edits them:

```bash
# Enable auto-compression (zero config)
python3 scripts/mem_compress.py /path/to/workspace auto --changed-file memory/2026-03-09.md
```

The PostToolUse hook integrates with OpenClaw to trigger **automatic token compression** after every file change. Smart skip logic ignores `.git/`, `node_modules/`, binary files, and files under 200 tokens.

Performance: **<2 seconds** per file, typically **10–20% token reduction** per compression pass.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     mem_compress.py                          │
│               (unified token compression entry point)       │
└──────┬──────┬──────┬──────┬──────┬──────┬──────┬──────┬────┘
       │      │      │      │      │      │      │      │
       ▼      ▼      ▼      ▼      ▼      ▼      ▼      ▼
  estimate compress dict  dedup observe tiers  audit optimize
       └──────┴──────┴──┬───┴──────┴──────┴──────┴──────┘
                        ▼
              ┌────────────────┐
              │     lib/       │
              │ tokens.py      │ ← tiktoken or CJK-aware heuristic
              │ markdown.py    │ ← section parsing
              │ dedup.py       │ ← shingle hashing
              │ dictionary.py  │ ← codebook compression
              │ rle.py         │ ← path/IP/enum encoding
              │ optimizer.py   │ ← format optimization
              │ config.py      │ ← JSON config
              │ exceptions.py  │ ← error types
              └────────────────┘
```

---

## Claw Compactor vs LLMLingua vs Other Token Compression Tools

How does Claw Compactor compare to other **LLM token compression** and **prompt compression** tools?

| Feature | Claw Compactor | LLMLingua-2 | SelectiveContext | Prompt Compression (generic) |
|---------|---------------|-------------|-----------------|------------------------------|
| **LLM required** | ❌ No (zero cost) | ✅ Yes (inference cost) | ✅ Yes | ✅ Usually |
| **Max token reduction** | **Up to 97%** | 20–50% | 15–40% | 10–30% |
| **Latency** | <50ms | 200ms+ | 100ms+ | varies |
| **Lossless layers** | 3 of 5 ✅ | 0 | 0 | 0 |
| **Workspace-level compression** | ✅ Full workspace | ❌ Per-prompt only | ❌ Per-prompt only | ❌ Per-prompt only |
| **CJK support** | ✅ Full | ⚠️ Partial | ❌ No | ⚠️ Partial |
| **ROUGE-L @ rate=0.3** | **0.653** | 0.346 | — | — |
| **ROUGE-L @ rate=0.5** | **0.723** | 0.570 | — | — |
| **Cost to run** | $0 | LLM inference cost | LLM inference cost | varies |
| **Integration** | OpenClaw native, standalone | Python library | Python library | varies |
| **License** | MIT | MIT | MIT | varies |

**Benchmark result:** Claw Compactor outperforms LLMLingua-2 by **+88.2% on ROUGE-L** at 0.3 compression rate and **+26.8%** at 0.5 compression rate. [Full benchmark results →](benchmark/RESULTS.md)

---

## Use Cases

### 🤖 AI Agent Token Optimization
Reduce the context window footprint of autonomous AI agents. Less tokens = faster responses + lower cost.

### 💬 Chat History Compression
Compress long conversation histories before loading into LLM context. Preserve decisions and facts, remove filler.

### 📝 Memory File Token Reduction
Shrink `MEMORY.md`, daily notes, and workspace files. Keep them under token budget without losing information.

### 🔄 Session Transcript Compression
Convert raw JSONL session logs (often 100K+ tokens) into structured 3K-token observations. **97% token saving**.

### 🏗️ Multi-Agent Context Sharing
When sub-agents inherit parent context, every token counts. Compress before passing to reduce cost across the agent tree.

---

## Configuration

Optional `claw-compactor-config.json` in workspace root:

```json
{
  "chars_per_token": 4,
  "level0_max_tokens": 200,
  "level1_max_tokens": 500,
  "dedup_similarity_threshold": 0.6,
  "dedup_shingle_size": 3
}
```

All fields optional — sensible defaults are used when absent.

---

## Artifacts

| File | Purpose |
|------|---------|
| `memory/.codebook.json` | Dictionary codebook (must travel with memory files) |
| `memory/.observed-sessions.json` | Tracks processed transcripts |
| `memory/observations/` | Compressed session summaries |
| `memory/MEMORY-L0.md` | Level 0 summary (~200 tokens) — **see note below** |
| `memory/MEMORY-L1.md` | Level 1 summary (~1000 tokens) — **see note below** |
| `memory/.compactor-state.json` | Auto-compress tracking state |

### ⚠️ L0/L1 Warning: Hand-curate, don't auto-generate

The `tiers` command generates L0/L1/L2 files by scoring section headers with keyword matching. This works well for structured memory files (e.g. `MEMORY.md`) but produces **low-signal output when run against `memory/observations/`** — it fills the token budget with short, generic `[config] exec operation` sections instead of meaningful summaries.

**Recommendation:** Write `MEMORY-L0.md` and `MEMORY-L1.md` manually. Use `tiers` for analysis (`--json` flag) to understand your token distribution, but treat the generated files as drafts that need review before use as boot context.

Running `tiers` again will silently overwrite hand-curated files. If you've written your own L0/L1, either exclude them from the `tiers` output directory or don't run `tiers --output-dir` against your memory directory.

---

## Heartbeat Automation

Run token compression weekly or on heartbeat:

```markdown
## Memory Maintenance (weekly)
- python3 skills/claw-compactor/scripts/mem_compress.py <workspace> benchmark
- If savings > 5%: run full token compression pipeline
- If pending transcripts: run observe
```

Cron example:
```bash
0 3 * * 0 cd /path/to/skills/claw-compactor && python3 scripts/mem_compress.py /path/to/workspace full
```

---

## FAQ

**Q: Will token compression lose my data?**
A: Rule engine, dictionary, RLE, and tokenizer optimization are fully lossless. Observation compression and CCP are lossy but preserve all facts and decisions.

**Q: How does dictionary decompression work?**
A: `decompress_text(text, codebook)` expands all `$XX` codes back. The codebook JSON must be present.

**Q: Can I run individual token compression steps?**
A: Yes. Every command is independent: `compress`, `dict`, `observe`, `tiers`, `dedup`, `optimize`.

**Q: What if tiktoken isn't installed?**
A: Falls back to a CJK-aware heuristic (chars÷4). Token counts are ~90% accurate.

**Q: Does token compression handle Chinese/Japanese/Unicode?**
A: Yes. Full CJK support including character-aware token estimation and Chinese punctuation normalization.

**Q: How does this compare to LLMLingua?**
A: Claw Compactor achieves higher ROUGE-L scores at the same compression rate, requires zero LLM inference cost, and works at the workspace level rather than individual prompts.

**Q: Can I use this without OpenClaw?**
A: Yes. Claw Compactor is a standalone Python tool. OpenClaw integration (hooks, auto-compress) is optional.

---

## Troubleshooting

- **`FileNotFoundError` on workspace:** Ensure path points to workspace root (contains `memory/` or `MEMORY.md`)
- **Dictionary decompression fails:** Check `memory/.codebook.json` exists and is valid JSON
- **Zero savings on `benchmark`:** Workspace is already optimized — token compression has diminishing returns
- **`observe` finds no transcripts:** Check sessions directory for `.jsonl` files
- **Token count seems wrong:** Install tiktoken: `pip3 install tiktoken`

---

## Installation

```bash
# Clone from GitHub
git clone https://github.com/aeromomo/claw-compactor.git
cd claw-compactor

# Optional: install for exact token counting
pip install tiktoken

# Or install as a Python package (with all extras)
pip install -e ".[accurate]"

# Development install (includes pytest)
pip install -e ".[dev,accurate]"
```

**Requirements:** Python 3.9+. No other dependencies required — tiktoken is optional for exact token counts (falls back to CJK-aware heuristic).

---

## Related Projects & Ecosystem

- **[OpenClaw](https://openclaw.ai)** — The AI agent platform that Claw Compactor was built for
- **[ClawhubAI](https://clawhub.com)** — Discover more AI agent skills and tools
- **[OpenClaw Discord](https://discord.com/invite/clawd)** — Community support and discussion
- **[OpenClaw Docs](https://docs.openclaw.ai)** — Full documentation

---

## Tags

`token-compression` `llm-tools` `prompt-compression` `context-compression` `ai-agent` `cost-reduction` `context-window-optimization` `workspace-compression` `memory-compression` `openclaw` `python` `developer-tools` `ai-infrastructure` `llm-cost-reduction` `token-optimization`

---

## Credits

- Inspired by [claude-mem](https://github.com/thedotmack/claude-mem) by thedotmack
- Built by Bot777 for [OpenClaw](https://openclaw.ai)

## License

[MIT](LICENSE) — Free for commercial and personal use.
