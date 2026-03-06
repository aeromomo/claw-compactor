"""compressors.py — Four compression strategies for the Engram Benchmark.

Strategies:
1. EngramCompressor   — LLM Observer + Reflector (Layer 6 Engram)
2. RuleCompressor     — claw-compactor Layers 1-5 (deterministic, no LLM)
3. RandomDropCompressor — Random token drop (LLMLingua-2 baseline proxy)
4. NoCompressor       — Raw text, no compression (baseline)

Python 3.9+ / no external deps beyond stdlib.
EngramCompressor uses the proxy at http://localhost:8403.
"""

from __future__ import annotations

import json
import logging
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# Load .env from project root
# ---------------------------------------------------------------------------

def _load_env() -> None:
    env_path = Path(__file__).parent.parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                os.environ.setdefault(k.strip(), v.strip())

_load_env()

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Base class
# ---------------------------------------------------------------------------

class BaseCompressor:
    """Abstract base compressor."""

    name: str = "base"

    def compress(self, messages: list[dict]) -> tuple[str, int]:
        """
        Compress a list of messages.

        Returns:
            (compressed_text, llm_call_count)
        """
        raise NotImplementedError

    @staticmethod
    def _messages_to_text(messages: list[dict]) -> str:
        """Flatten messages to readable text."""
        parts = []
        for m in messages:
            role = m.get("role", "?").upper()
            content = m.get("content", "")
            ts = m.get("ts", "")
            if ts:
                parts.append(f"[{ts}] {role}: {content}")
            else:
                parts.append(f"{role}: {content}")
        return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# 1. NoCompressor — raw text baseline
# ---------------------------------------------------------------------------

class NoCompressor(BaseCompressor):
    """No compression — returns raw conversation text."""

    name = "NoCompression"

    def compress(self, messages: list[dict]) -> tuple[str, int]:
        return self._messages_to_text(messages), 0


# ---------------------------------------------------------------------------
# 2. RandomDropCompressor — simulates LLMLingua token-drop baseline
# ---------------------------------------------------------------------------

class RandomDropCompressor(BaseCompressor):
    """
    Random token drop compression — proxy for LLMLingua-2.

    Randomly removes tokens to achieve a target compression ratio.
    Preserves sentence boundaries (never drops period-ending words).
    Uses a fixed seed for reproducibility.
    """

    name = "RandomDrop"

    def __init__(self, target_ratio: float = 0.4, seed: int = 42):
        """
        Args:
            target_ratio: fraction of tokens to KEEP (0.4 = keep 40%, drop 60%)
            seed: random seed for reproducibility
        """
        self.target_ratio = target_ratio
        self.seed = seed

    def compress(self, messages: list[dict]) -> tuple[str, int]:
        text = self._messages_to_text(messages)
        rng = random.Random(self.seed)

        # Preserve role headers like "[ts] USER:" by splitting into chunks
        chunks = re.split(r"(\n\n)", text)
        result_parts = []

        for chunk in chunks:
            if chunk == "\n\n":
                result_parts.append(chunk)
                continue

            # Detect if this is a role header line — preserve it fully
            lines = chunk.split("\n")
            out_lines = []
            for line in lines:
                # Role header: preserve
                if re.match(r"^(\[.+?\])?\s*(USER|ASSISTANT|SYSTEM)\s*:", line):
                    out_lines.append(line)
                else:
                    # Token-level random drop
                    tokens = line.split()
                    if not tokens:
                        out_lines.append(line)
                        continue
                    kept = []
                    for i, tok in enumerate(tokens):
                        is_last = (i == len(tokens) - 1)
                        keep_prob = self.target_ratio
                        # Never drop sentence-ending tokens
                        if is_last or tok.endswith((".", "!", "?")):
                            keep_prob = 1.0
                        if rng.random() < keep_prob:
                            kept.append(tok)
                    out_lines.append(" ".join(kept))
            result_parts.append("\n".join(out_lines))

        return "".join(result_parts), 0


# ---------------------------------------------------------------------------
# 3. RuleCompressor — claw-compactor Layers 1-5
# ---------------------------------------------------------------------------

class RuleCompressor(BaseCompressor):
    """
    Rule-based compression using claw-compactor's deterministic pipeline.

    Applies (in order):
      Layer 1 — Chinese punctuation normalization, whitespace strip
      Layer 2 — Duplicate line removal
      Layer 3 — Repeated phrase/RLE compression
      Layer 4 — Markdown redundancy strip (excess blank lines, trailing spaces)
      Layer 5 — Abbreviation dictionary substitution (common tech terms)

    Zero LLM calls. Pure deterministic text transformations.
    """

    name = "RuleCompressor"

    # Abbreviation dictionary for common patterns in tech conversations
    ABBREV = {
        "Kubernetes": "K8s",
        "kubernetes": "k8s",
        "PostgreSQL": "PG",
        "postgresql": "pg",
        "JavaScript": "JS",
        "javascript": "js",
        "TypeScript": "TS",
        "typescript": "ts",
        "Docker Compose": "Compose",
        "docker compose": "compose",
        "machine learning": "ML",
        "Machine Learning": "ML",
        "deep learning": "DL",
        "Deep Learning": "DL",
        "infrastructure": "infra",
        "Infrastructure": "Infra",
        "configuration": "config",
        "Configuration": "Config",
        "environment": "env",
        "Environment": "Env",
        "authentication": "auth",
        "Authentication": "Auth",
        "authorization": "authz",
        "Authorization": "Authz",
        "database": "DB",
        "Database": "DB",
        "application": "app",
        "Application": "App",
        "microservices": "µsvc",
        "Microservices": "µsvc",
        "deployment": "deploy",
        "Deployment": "Deploy",
        "development": "dev",
        "Development": "Dev",
        "production": "prod",
        "Production": "Prod",
        "repository": "repo",
        "Repository": "Repo",
        "continuous integration": "CI",
        "Continuous Integration": "CI",
        "continuous deployment": "CD",
        "Continuous Deployment": "CD",
    }

    def compress(self, messages: list[dict]) -> tuple[str, int]:
        text = self._messages_to_text(messages)

        # Layer 1: Normalize whitespace and Chinese punctuation
        text = self._layer1_normalize(text)

        # Layer 2: Remove duplicate lines
        text = self._layer2_dedup_lines(text)

        # Layer 3: RLE — compress repeated patterns
        text = self._layer3_rle(text)

        # Layer 4: Strip markdown redundancy
        text = self._layer4_markdown_strip(text)

        # Layer 5: Dictionary abbreviation substitution
        text = self._layer5_abbreviate(text)

        return text, 0

    def _layer1_normalize(self, text: str) -> str:
        """Normalize whitespace, strip trailing spaces per line."""
        # Chinese full-width punctuation → ASCII
        replacements = {
            "，": ",", "。": ".", "！": "!", "？": "?",
            "：": ":", "；": ";", "（": "(", "）": ")",
            "【": "[", "】": "]", "—": "-", "…": "...",
            "\u3000": " ",  # ideographic space → regular space
        }
        for zh, en in replacements.items():
            text = text.replace(zh, en)

        # Strip trailing whitespace from each line
        lines = [line.rstrip() for line in text.splitlines()]
        # Collapse multiple consecutive blank lines to single blank line
        result = []
        blank_count = 0
        for line in lines:
            if line.strip() == "":
                blank_count += 1
                if blank_count <= 1:
                    result.append("")
            else:
                blank_count = 0
                result.append(line)
        return "\n".join(result)

    def _layer2_dedup_lines(self, text: str) -> str:
        """Remove exact duplicate lines, preserving order."""
        seen: set[str] = set()
        result = []
        for line in text.splitlines():
            key = line.strip()
            if key in seen and len(key) > 20:  # Only dedup non-trivial lines
                continue
            if key:
                seen.add(key)
            result.append(line)
        return "\n".join(result)

    def _layer3_rle(self, text: str) -> str:
        """Compress repeated words/phrases using run-length encoding."""
        # Compress repeated adjacent words: "very very very" → "very×3"
        def replace_repeats(m: re.Match) -> str:
            word = m.group(1)
            count = len(m.group(0).split())
            if count > 2:
                return f"{word}×{count}"
            return m.group(0)

        # Match 3+ consecutive repetitions of the same word
        text = re.sub(
            r"\b(\w+)(?:\s+\1){2,}\b",
            replace_repeats,
            text,
            flags=re.IGNORECASE,
        )

        # Collapse very long lines of dashes/equals (separators)
        text = re.sub(r"[-=]{20,}", "---", text)

        return text

    def _layer4_markdown_strip(self, text: str) -> str:
        """Remove markdown redundancy: excess blank lines, redundant headers."""
        lines = text.splitlines()
        result = []
        prev_header = None

        for line in lines:
            stripped = line.strip()

            # Skip duplicate adjacent headers
            if stripped.startswith("#"):
                if stripped == prev_header:
                    continue
                prev_header = stripped
            else:
                if stripped:
                    prev_header = None

            # Trim overly long code block output lines (keep first 120 chars)
            if len(line) > 200 and not stripped.startswith("#"):
                line = line[:200] + "…"

            result.append(line)

        return "\n".join(result)

    def _layer5_abbreviate(self, text: str) -> str:
        """Apply abbreviation dictionary substitution."""
        for full, abbrev in self.ABBREV.items():
            # Word-boundary aware replacement
            text = re.sub(
                r"\b" + re.escape(full) + r"\b",
                abbrev,
                text,
            )
        return text


# ---------------------------------------------------------------------------
# 4. EngramCompressor — LLM Observer + Reflector (Layer 6)
# ---------------------------------------------------------------------------

class EngramCompressor(BaseCompressor):
    """
    Engram Layer 6: LLM-driven Observer + Reflector compression.

    - Observer:   Converts raw messages into structured observation log
    - Reflector:  Distills observations into a concise long-term reflection

    Uses the claw-compactor proxy at http://localhost:8403.
    Model: claude-code/sonnet (configurable).
    """

    name = "Engram"

    OBSERVER_SYSTEM = """\
You are the Observer Agent. Transform raw conversation messages into a structured, \
high-signal observation log.

Output format:
Date: YYYY-MM-DD
- 🔴 HH:MM <critical observation — key decisions, goals, blockers>
- 🟡 HH:MM <important detail — technical context, plans>
- 🟢 HH:MM <useful note — background info>

Rules:
- Achieve 4-8× token compression
- Preserve ALL critical (🔴) items
- Summarize code blocks (outcome, not full code)
- Output ONLY the observation log — no preamble
"""

    OBSERVER_USER_TEMPLATE = """\
Compress the following conversation into an observation log:

---
{messages}
---

Observation log:"""

    REFLECTOR_SYSTEM = """\
You are the Reflector Agent. Distill a structured observation log into an even more \
concise long-term memory reflection.

Output: A single, dense markdown document with:
- ## Key Context (2-3 bullet points — the most critical facts)
- ## Active Tasks (what's in progress or planned)
- ## Technical Decisions (key architectural/config choices made)

Rules:
- Aim for 3-5× additional compression on top of the observation log
- Use key:value notation for technical settings
- Omit pleasantries, greetings, and filler entirely
- Output ONLY the reflection document
"""

    REFLECTOR_USER_TEMPLATE = """\
Distill this observation log into a long-term memory reflection:

---
{observations}
---

Reflection:"""

    def __init__(
        self,
        base_url: str = "http://localhost:8403",
        model: str = "claude-code/sonnet",
        max_tokens: int = 2048,
        timeout: int = 90,
        use_reflector: bool = True,
    ):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.max_tokens = max_tokens
        self.timeout = timeout
        self.use_reflector = use_reflector
        self._api_key = os.environ.get("OPENAI_API_KEY", "dummy-key")

    def _call_llm(self, system: str, user: str) -> str:
        """Make a single LLM call via the OpenAI-compatible proxy."""
        payload = json.dumps({
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": [
                {"role": "user", "content": f"{system}\n\n{user}"}
            ],
        }).encode("utf-8")

        req = urllib.request.Request(
            f"{self.base_url}/v1/chat/completions",
            data=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._api_key}",
            },
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                return data["choices"][0]["message"]["content"].strip()
        except urllib.error.URLError as e:
            logger.error(f"LLM call failed: {e}")
            raise RuntimeError(f"LLM proxy unavailable: {e}") from e
        except (KeyError, json.JSONDecodeError) as e:
            logger.error(f"LLM response parse error: {e}")
            raise RuntimeError(f"LLM response malformed: {e}") from e

    def compress(self, messages: list[dict]) -> tuple[str, int]:
        """
        Two-stage compression:
        1. Observer: raw messages → observation log
        2. Reflector: observation log → final reflection (if use_reflector=True)

        Returns (compressed_text, llm_call_count).
        """
        raw_text = self._messages_to_text(messages)
        llm_calls = 0

        # Stage 1: Observer
        observer_prompt = self.OBSERVER_USER_TEMPLATE.format(messages=raw_text)
        observations = self._call_llm(self.OBSERVER_SYSTEM, observer_prompt)
        llm_calls += 1
        logger.debug(f"Observer output ({len(observations)} chars)")

        if not self.use_reflector:
            return observations, llm_calls

        # Stage 2: Reflector
        reflector_prompt = self.REFLECTOR_USER_TEMPLATE.format(observations=observations)
        reflection = self._call_llm(self.REFLECTOR_SYSTEM, reflector_prompt)
        llm_calls += 1
        logger.debug(f"Reflector output ({len(reflection)} chars)")

        return reflection, llm_calls


# ---------------------------------------------------------------------------
# Factory
# ---------------------------------------------------------------------------

def get_all_compressors() -> list[BaseCompressor]:
    """Return all four compressor instances for benchmarking."""
    return [
        NoCompressor(),
        RandomDropCompressor(target_ratio=0.4, seed=42),
        RuleCompressor(),
        EngramCompressor(use_reflector=True),
    ]


if __name__ == "__main__":
    # Quick smoke test with tiny messages
    test_messages = [
        {"role": "user", "content": "How do I set up Docker Compose for PostgreSQL?", "ts": "2026-01-01T10:00:00Z"},
        {"role": "assistant", "content": "Create a docker-compose.yml with the PostgreSQL service. Use volumes for data persistence and environment variables for the database configuration.", "ts": "2026-01-01T10:00:10Z"},
        {"role": "user", "content": "What PostgreSQL version should I use?", "ts": "2026-01-01T10:01:00Z"},
        {"role": "assistant", "content": "Use PostgreSQL 16 — it's the latest stable version with excellent performance improvements.", "ts": "2026-01-01T10:01:10Z"},
    ]

    print("Testing compressors (skipping Engram — requires LLM proxy):")
    for cls in [NoCompressor, RandomDropCompressor, RuleCompressor]:
        c = cls()
        result, calls = c.compress(test_messages)
        print(f"\n[{c.name}] ({len(result)} chars, {calls} LLM calls):")
        print(result[:200])

    print("\ncompressors.py smoke test passed ✓")
