"""Token estimation utilities.

Uses tiktoken when available, falls back to a CJK-aware heuristic.

For the heuristic:
- ASCII/Latin text: ~4 chars per token
- CJK characters: ~1.5 chars per token (tiktoken cl100k_base)

Part of claw-compactor. License: MIT.
"""

import re
import logging
from typing import Optional

logger = logging.getLogger(__name__)

_encoder = None
_tiktoken_available = False

try:
    import tiktoken
    _encoder = tiktoken.encoding_for_model("gpt-4")
    _tiktoken_available = True
    logger.debug("tiktoken available, using cl100k_base encoding")
except (ImportError, Exception):
    logger.debug("tiktoken unavailable, using CJK-aware heuristic")

CHARS_PER_TOKEN = 4  # fallback for ASCII text
CJK_CHARS_PER_TOKEN = 1.5  # CJK characters average ~1.5 chars/token

# CJK unified ideographs + common ranges
_CJK_RE = re.compile(r'[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef]')


def _heuristic_tokens(text: str) -> int:
    """Estimate tokens using CJK-aware heuristic.

    CJK characters are counted at ~1.5 chars/token, everything else at ~4.
    """
    if not text:
        return 0
    cjk_chars = len(_CJK_RE.findall(text))
    other_chars = len(text) - cjk_chars
    cjk_tokens = cjk_chars / CJK_CHARS_PER_TOKEN
    other_tokens = other_chars / CHARS_PER_TOKEN
    return max(1, int(cjk_tokens + other_tokens))


def estimate_tokens(text: str) -> int:
    """Estimate the number of tokens in *text*.

    Uses tiktoken (cl100k_base) when available, otherwise a CJK-aware
    heuristic.  Returns 0 for empty strings.
    Raises TypeError if *text* is None.
    """
    if text is None:
        raise TypeError("estimate_tokens() requires a string, got None")
    if not text:
        return 0
    if _tiktoken_available and _encoder is not None:
        return len(_encoder.encode(text))
    return _heuristic_tokens(text)


def using_tiktoken() -> bool:
    """Return True if tiktoken is being used for estimation."""
    return _tiktoken_available
