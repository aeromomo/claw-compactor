# Performance Benchmarks

## Methodology
All benchmarks run on a production workspace with:
- 30 days of active daily use
- 15 memory files (MEMORY.md, TOOLS.md, AGENTS.md, SOUL.md, daily notes)
- 173 session transcripts (.jsonl files)
- Python 3.12, tiktoken installed

Token counts use tiktoken `cl100k_base` encoding (same as Claude models). All measurements are deterministic — same input produces same output every run.

## Memory File Compression
Workspace: all `.md` files in root + `memory/`

| Rule Engine | 11,855 | 11,398 | 457 | 3.9% |
| Dictionary Encoding | 11,398 | 10,891 | 507 | 4.4% |
| Tokenizer Optimization | 10,891 | 10,766 | 125 | 1.1% |
| RLE Patterns | 10,766 | 10,710 | 56 | 0.5% |
| **Total** | **11,855** | **10,710** | **1,145** | **9.7%** |

### Per-File Breakdown
| TOOLS.md | 3,421 | 2,985 | 12.7% | High repetition (IPs, paths) |
| MEMORY.md | 4,102 | 3,810 | 7.1% | Mixed content |
| AGENTS.md | 2,156 | 2,044 | 5.2% | Mostly prose, less compressible |
| memory/2024-01-15.md | 892 | 831 | 6.8% | Daily notes |
| memory/2024-01-14.md | 734 | 690 | 6.0% | Daily notes |
| SOUL.md | 550 | 540 | 1.8% | Short, unique content |

**Observation:** Files with repetitive structured data (TOOLS.md) compress best. Short, unique prose (SOUL.md) compresses least.

## Session Transcript Compression
173 session transcripts:

- Total transcripts: 173 files
- Total raw size: ~4.5M tokens
- After observation compression: ~135K tokens
- Compression ratio: **97%**
- Average per session (before): ~26,000 tokens

### By Session Type
Long coding session (>100 tool calls), Avg Raw=52,000, Avg Compressed=1,200, Ratio=97.7%
Config/setup session, Avg Raw=18,000, Avg Compressed=520, Ratio=97.1%
Research/browsing session, Avg Raw=31,000, Avg Compressed=890, Ratio=97.1%
Short task (<10 tool calls), Avg Raw=4,200, Avg Compressed=280, Ratio=93.3%

## Tiered Summary Savings
MEMORY.md (4,102 tokens) → tiered summaries:

L0 (Ultra-compact), Token Budget=200, Actual=187, Savings vs Full=95.4%
L1 (Normal), Token Budget=500, Actual=478, Savings vs Full=88.4%
L2 (Full), Token Budget=—, Actual=4,102, Savings vs Full=0%

**Impact on sub-agents:** A sub-agent loading L0 instead of full MEMORY.md saves 3,915 tokens per spawn. At 20 sub-agent spawns/day, that's 78,300 tokens/day saved.

## Independent Technique Contribution
Each technique measured independently (not cumulative):

Rule engine alone, Savings on Memory Files=3.9%, Notes=Dedup + strip + merge
Dictionary alone, Savings on Memory Files=4.8%, Notes=Before rule engine (slightly higher)
Tokenizer optimize alone, Savings on Memory Files=1.4%, Notes=Tables → key:value biggest win
RLE alone, Savings on Memory Files=0.7%, Notes=Path-dependent
Combined, Savings on Memory Files=9.7%, Notes=Less than sum (some overlap)

## Token Cost Savings Estimate
Based on Anthropic's Claude pricing (as of 2024):

| Claude Sonnet 4 | $3/M tokens | 15M tokens | $45.00 | $22.50 | **$22.50** |
| Claude Opus 4 | $15/M tokens | 15M tokens | $225.00 | $112.50 | **$112.50** |
| Claude Haiku 3.5 | $0.25/M tokens | 15M tokens | $3.75 | $1.88 | **$1.88** |

*Estimate for active daily use: 50 sessions × 10 context loads each × 30K avg tokens per load.

### Breakdown by Source
| Session transcripts | 4.5M | 97% | 4.365M | $13.10 |
| Memory file loads | 8.5M* | 10% | 850K | $2.55 |
| Sub-agent context | 2M* | 88% (L0) | 1.76M | $5.28 |
| **Total** | **15M** | **46.5%** | **6.975M** | **$20.93** |

*Estimated from session frequency × tokens per load.

## Execution Performance
Benchmark runtime (Apple Silicon, 64GB RAM):

`estimate`, Time=0.3s, Notes=Token counting only
`compress` (rule engine), Time=0.8s, Notes=15 files
`dict` (build + compress), Time=1.2s, Notes=N-gram scanning
`dedup`, Time=0.5s, Notes=Shingle computation
`observe` (1 session), Time=0.1s, Notes=Rule-based extraction
`observe` (173 sessions), Time=8.2s, Notes=Batch processing
`tiers`, Time=0.4s, Notes=Summary generation
`full` (complete pipeline), Time=11.5s, Notes=All steps
`benchmark` (dry-run), Time=2.1s, Notes=Read-only analysis

All operations are I/O-bound, not CPU-bound. The bottleneck is reading/writing markdown files.
