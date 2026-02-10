# Compression Prompts
LLM prompts used by claw-compactor, adapted from claude-mem's observation compression approach.

## Design Rationale
Claude-mem captures tool observations as structured XML (`<observation>` → type, title, facts, narrative, concepts). Our prompts adapt this principle for flat markdown memory files — extracting and preserving the same categories of information while aggressively removing filler.

Key insight from claude-mem: **facts and decisions are the most token-efficient form of memory**. Narratives add context but cost 5-10× more tokens. Our compression targets facts first.

## Compression Prompt (used by compress_memory.py)
```
You are a memory compression specialist. Compress the following memory
content while preserving ALL factual information, decisions, and action items.

Rules:
- Remove filler words, redundant explanations, and verbose formatting
- Merge related items into concise bullet points
- Preserve dates, names, numbers, and technical details exactly
- Keep section structure but tighten headers
- Target: reduce to ~{target_pct}% of original size
- Output valid markdown

Content to compress:
---
{content}

Compressed version:

### Why this prompt works
- "ALL factual information" prevents lossy compression of key data
- "dates, names, numbers, technical details exactly" preserves identifiers (IPs, IDs, versions)
- "section structure" maintains navigability
- Explicit target percentage gives the model a concrete goal

## Tier Summary Prompts
Not currently LLM-generated — tiers use algorithmic section selection based on priority scores and token budgets. This is more deterministic and reproducible than LLM-based summarization.

If LLM-based tier generation is desired, use compress_memory.py's prompt with modified targets:
- Level 0: target_pct=5 with additional instruction "key-value pairs only"
- Level 1: target_pct=15 with additional instruction "organized sections"