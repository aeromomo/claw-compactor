"""Canonical Unicode character maps for claw-compactor.

Single source of truth for all character-substitution tables used during
text normalization and compression.  Both :mod:`lib.markdown` and
:mod:`lib.tokenizer_optimizer` import from here so that their
normalization behaviour is always identical.

Historically the two modules each maintained a separate ``_ZH_PUNCT_MAP``
dict that had diverged: ``tokenizer_optimizer`` was missing the four curly-
quote entries (U+201C/D, U+2018/9) and contained a garbled 7-character key.
This module contains the canonical, corrected superset.

Part of claw-compactor. License: MIT.
"""

import re
from typing import Dict

# ---------------------------------------------------------------------------
# Chinese / CJK fullwidth punctuation → ASCII equivalents
# ---------------------------------------------------------------------------
# Order matters for the regex: longer keys (——) must sort first so they are
# tried before their component characters.
ZH_PUNCT_MAP: Dict[str, str] = {
    # Two-character sequences first (longer match priority)
    '\u2014\u2014': '--',        # ——  EM DASH × 2  → --

    # Fullwidth ASCII punctuation (FF00–FFEF block)
    '\uFF0C': ',',               # ，  FULLWIDTH COMMA
    '\uFF0E': '.',               # ．  FULLWIDTH FULL STOP (alt for 。)
    '\uFF01': '!',               # ！  FULLWIDTH EXCLAMATION MARK
    '\uFF1A': ':',               # ：  FULLWIDTH COLON
    '\uFF1B': ';',               # ；  FULLWIDTH SEMICOLON
    '\uFF1F': '?',               # ？  FULLWIDTH QUESTION MARK
    '\uFF08': '(',               # （  FULLWIDTH LEFT PARENTHESIS
    '\uFF09': ')',               # ）  FULLWIDTH RIGHT PARENTHESIS
    '\uFF5E': '~',               # ～  FULLWIDTH TILDE

    # CJK punctuation (3000–303F block)
    '\u3002': '.',               # 。  IDEOGRAPHIC FULL STOP
    '\u3001': ',',               # 、  IDEOGRAPHIC COMMA
    '\u3010': '[',               # 【  LEFT BLACK LENTICULAR BRACKET
    '\u3011': ']',               # 】  RIGHT BLACK LENTICULAR BRACKET

    # General punctuation (2000–206F block)
    '\u2026': '...',             # …   HORIZONTAL ELLIPSIS
    '\u2014': '-',               # —   EM DASH (single; after the pair above)

    # Typographic quotes → straight quotes
    '\u201C': '"',               # "   LEFT DOUBLE QUOTATION MARK
    '\u201D': '"',               # "   RIGHT DOUBLE QUOTATION MARK
    '\u2018': "'",               # '   LEFT SINGLE QUOTATION MARK
    '\u2019': "'",               # '   RIGHT SINGLE QUOTATION MARK
}

# Pre-compiled regex — longer keys must appear first so that '——' is
# matched before a lone '—'.
_ZH_PUNCT_RE = re.compile(
    '|'.join(re.escape(k) for k in ZH_PUNCT_MAP),
)


def normalize_zh_punctuation(text: str) -> str:
    """Replace Chinese / typographic punctuation with ASCII equivalents.

    Operates on the canonical :data:`ZH_PUNCT_MAP`.  The double-EM-DASH
    sequence ``——`` is replaced before the single ``—`` so that ``——→--``
    rather than ``——→--`` via two single replacements.

    Args:
        text: Input string (may be empty).

    Returns:
        String with all mapped characters replaced; unchanged otherwise.
    """
    if not text:
        return ""
    return _ZH_PUNCT_RE.sub(lambda m: ZH_PUNCT_MAP[m.group()], text)
