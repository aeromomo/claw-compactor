"""Configuration management for claw-compactor.

Loads settings from claw-compactor-config.json in the workspace root,
falling back to sensible defaults.

Part of claw-compactor. License: MIT.
"""

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger("claw-compactor.config")

DEFAULT_CONFIG: Dict[str, Any] = {
    "chars_per_token": 4,
    "level0_max_tokens": 200,
    "level1_max_tokens": 500,
    "dedup_similarity_threshold": 0.6,
    "dedup_shingle_size": 3,
    "dedup_max_results": 50,
    "dedup_min_line_length": 20,
    "compress_min_tokens": 50,
    "compress_target_ratio": 0.4,
    "date_format": "%Y-%m-%d",
    "memory_dir": "memory",
    "memory_file": "MEMORY.md",
    "summary_tiers_file": "memory/summary-tiers.md",
    "compressed_suffix": ".compressed.md",
    "log_level": "INFO",
}

CONFIG_FILENAME = "claw-compactor-config.json"


@dataclass
class MemCompressConfig:
    """Runtime configuration for claw-compactor."""

    chars_per_token: int = DEFAULT_CONFIG["chars_per_token"]
    level0_max_tokens: int = DEFAULT_CONFIG["level0_max_tokens"]
    level1_max_tokens: int = DEFAULT_CONFIG["level1_max_tokens"]
    dedup_similarity_threshold: float = DEFAULT_CONFIG["dedup_similarity_threshold"]
    dedup_shingle_size: int = DEFAULT_CONFIG["dedup_shingle_size"]
    dedup_max_results: int = DEFAULT_CONFIG["dedup_max_results"]
    dedup_min_line_length: int = DEFAULT_CONFIG["dedup_min_line_length"]
    compress_min_tokens: int = DEFAULT_CONFIG["compress_min_tokens"]
    compress_target_ratio: float = DEFAULT_CONFIG["compress_target_ratio"]
    date_format: str = DEFAULT_CONFIG["date_format"]
    memory_dir: str = DEFAULT_CONFIG["memory_dir"]
    memory_file: str = DEFAULT_CONFIG["memory_file"]
    summary_tiers_file: str = DEFAULT_CONFIG["summary_tiers_file"]
    compressed_suffix: str = DEFAULT_CONFIG["compressed_suffix"]
    log_level: str = DEFAULT_CONFIG["log_level"]


def load_config(workspace: Path) -> MemCompressConfig:
    """Load configuration from *workspace*/claw-compactor-config.json.

    Returns default config if the file is missing, empty, or invalid.
    """
    config_path = workspace / CONFIG_FILENAME
    if not config_path.exists():
        return MemCompressConfig()
    try:
        text = config_path.read_text(encoding="utf-8").strip()
        if not text:
            return MemCompressConfig()
        data = json.loads(text)
        if not isinstance(data, dict):
            logger.warning("Config is not a JSON object, using defaults")
            return MemCompressConfig()
        # Filter to known fields only
        known = {f.name for f in MemCompressConfig.__dataclass_fields__.values()}
        filtered = {k: v for k, v in data.items() if k in known}
        return MemCompressConfig(**filtered)
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        logger.warning("Invalid config %s: %s — using defaults", config_path, exc)
        return MemCompressConfig()
