"""run_benchmark.py — Execute the Engram compression benchmark.

Runs all compressors against all samples, collects metrics, saves results.

Usage:
    cd /path/to/claw-compactor
    python3 benchmark/run_benchmark.py [--skip-engram] [--samples data/*.json]

Results saved to benchmark/results/benchmark_results.json
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

# Ensure project lib is importable
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "scripts"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger(__name__)

from benchmark.compressors import (
    NoCompressor,
    RandomDropCompressor,
    RuleCompressor,
    EngramCompressor,
    BaseCompressor,
)
from benchmark.evaluate import evaluate, messages_to_text, estimate_tokens


# ---------------------------------------------------------------------------
# Load benchmark samples
# ---------------------------------------------------------------------------

def load_samples(data_dir: Path) -> list[dict]:
    """Load all JSON sample files from data_dir."""
    samples = []
    for f in sorted(data_dir.glob("*.json")):
        try:
            data = json.loads(f.read_text())
            samples.append(data)
            logger.info(f"Loaded sample: {f.name} ({len(data.get('messages', []))} msgs)")
        except Exception as e:
            logger.warning(f"Failed to load {f.name}: {e}")
    return samples


# ---------------------------------------------------------------------------
# Run benchmark
# ---------------------------------------------------------------------------

def run_benchmark(
    samples: list[dict],
    compressors: list[BaseCompressor],
    results_dir: Path,
) -> list[dict]:
    """Run all compressors against all samples and collect results."""

    all_results = []
    total_runs = len(samples) * len(compressors)
    run_n = 0

    for sample in samples:
        sample_id = sample.get("session_id", sample.get("session_id", "unknown"))
        messages = sample.get("messages", [])
        original_text = messages_to_text(messages)
        orig_tokens = estimate_tokens(original_text)

        logger.info(
            f"\n{'='*60}\nSample: {sample_id}\n"
            f"  Messages: {len(messages)}\n"
            f"  Original tokens: {orig_tokens}\n"
            f"  Description: {sample.get('description', '-')}"
        )

        for compressor in compressors:
            run_n += 1
            logger.info(f"\n[{run_n}/{total_runs}] Running {compressor.name} on {sample_id}...")

            start_ms = time.perf_counter() * 1000

            try:
                compressed_text, llm_calls = compressor.compress(messages)
                latency_ms = time.perf_counter() * 1000 - start_ms

                result = evaluate(
                    sample_id=sample_id,
                    compressor_name=compressor.name,
                    original_text=original_text,
                    compressed_text=compressed_text,
                    latency_ms=latency_ms,
                    llm_calls=llm_calls,
                )

                logger.info(
                    f"  ✓ {compressor.name}: "
                    f"ratio={result.compression_ratio:.3f} "
                    f"({result.space_saving_pct:.1f}% saved), "
                    f"ROUGE-L={result.rouge_l.get('f1', 0):.3f}, "
                    f"IR-F1={result.info_retention.get('f1', 0):.3f}, "
                    f"latency={result.latency_ms:.0f}ms, "
                    f"LLM calls={result.llm_calls}"
                )

                result_dict = result.to_dict()
                result_dict["sample_description"] = sample.get("description", "")
                result_dict["channel"] = sample.get("channel", "")
                all_results.append(result_dict)

            except Exception as e:
                latency_ms = time.perf_counter() * 1000 - start_ms
                logger.error(f"  ✗ {compressor.name} FAILED: {e}")
                all_results.append({
                    "sample_id": sample_id,
                    "compressor": compressor.name,
                    "error": str(e),
                    "latency_ms": round(latency_ms, 1),
                    "original_tokens": orig_tokens,
                    "compressed_tokens": 0,
                    "compression_ratio": 1.0,
                    "space_saving_pct": 0.0,
                    "rouge_l_f1": 0.0,
                    "info_retention_f1": 0.0,
                    "llm_calls": 0,
                })

    # Save results
    results_dir.mkdir(parents=True, exist_ok=True)
    out_path = results_dir / "benchmark_results.json"
    out_path.write_text(json.dumps({"results": all_results, "run_timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}, indent=2))
    logger.info(f"\nResults saved to {out_path}")

    return all_results


# ---------------------------------------------------------------------------
# Summary table
# ---------------------------------------------------------------------------

def print_summary(results: list[dict]) -> None:
    """Print a quick summary table to stdout."""
    from collections import defaultdict

    # Group by compressor
    by_compressor: dict[str, list[dict]] = defaultdict(list)
    for r in results:
        if "error" not in r:
            by_compressor[r["compressor"]].append(r)

    print("\n" + "=" * 80)
    print("BENCHMARK SUMMARY")
    print("=" * 80)
    header = f"{'Compressor':<22} {'Ratio':>8} {'Saved%':>8} {'ROUGE-L':>9} {'IR-F1':>8} {'Latency(ms)':>12} {'LLM calls':>10}"
    print(header)
    print("-" * 80)

    for name, runs in by_compressor.items():
        avg_ratio = sum(r["compression_ratio"] for r in runs) / len(runs)
        avg_saved = sum(r["space_saving_pct"] for r in runs) / len(runs)
        avg_rouge = sum(r["rouge_l_f1"] for r in runs) / len(runs)
        avg_ir = sum(r["info_retention_f1"] for r in runs) / len(runs)
        avg_lat = sum(r["latency_ms"] for r in runs) / len(runs)
        avg_llm = sum(r["llm_calls"] for r in runs) / len(runs)
        print(
            f"{name:<22} {avg_ratio:>8.3f} {avg_saved:>8.1f} "
            f"{avg_rouge:>9.3f} {avg_ir:>8.3f} "
            f"{avg_lat:>12.0f} {avg_llm:>10.1f}"
        )

    print("=" * 80)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Engram compression benchmark")
    parser.add_argument(
        "--skip-engram", action="store_true",
        help="Skip EngramCompressor (requires LLM proxy at localhost:8403)"
    )
    parser.add_argument(
        "--data-dir", type=Path,
        default=Path(__file__).parent / "data",
        help="Directory containing sample JSON files"
    )
    parser.add_argument(
        "--results-dir", type=Path,
        default=Path(__file__).parent / "results",
        help="Directory to save results JSON"
    )
    args = parser.parse_args()

    # Build compressor list
    compressors: list[BaseCompressor] = [
        NoCompressor(),
        RandomDropCompressor(target_ratio=0.4, seed=42),
        RuleCompressor(),
    ]
    if not args.skip_engram:
        compressors.append(EngramCompressor(use_reflector=True))
    else:
        logger.info("Skipping EngramCompressor (--skip-engram)")

    # Load samples
    samples = load_samples(args.data_dir)
    if not samples:
        logger.error(f"No sample files found in {args.data_dir}")
        sys.exit(1)

    logger.info(
        f"\nStarting benchmark:\n"
        f"  Samples: {len(samples)}\n"
        f"  Compressors: {[c.name for c in compressors]}\n"
        f"  Total runs: {len(samples) * len(compressors)}\n"
    )

    results = run_benchmark(samples, compressors, args.results_dir)
    print_summary(results)

    logger.info(f"\n✓ Benchmark complete. {len(results)} results collected.")


if __name__ == "__main__":
    main()
