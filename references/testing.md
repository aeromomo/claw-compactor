# Testing

## Philosophy
claw-compactor follows a **trust-through-testing** approach. Every compression technique must prove:

1. **Correctness** — lossless techniques roundtrip perfectly; lossy techniques preserve all facts
2. **Safety** — edge cases (empty files, Unicode, malformed markdown) never crash
3. **Non-inflation** — compressed output is never larger than input
4. **Idempotency** — running compression twice produces the same result

## Test Suite Overview
**810+ tests** across 30 test files, covering unit tests, integration tests, and real-workspace validation.

```
tests/
├── conftest.py # Shared fixtures
│
├── # Core module tests
├── test_compress_memory.py # Rule engine compression
├── test_compress_memory_comprehensive.py # Extended rule engine tests
├── test_dictionary.py # Dictionary encoding basics
├── test_dictionary_comprehensive.py # Codebook edge cases, roundtrip
├── test_observation_compressor.py # Observation pipeline
├── test_observation_comprehensive.py # Extended observation tests
├── test_compressed_context.py # CCP levels
├── test_dedup_memory.py # Shingle dedup
├── test_generate_summary_tiers.py # Tier generation
├── test_estimate_tokens.py # Token estimation
├── test_audit_memory.py # Audit checks
├── test_audit_comprehensive.py # Extended audit tests
├── # Library tests
├── test_lib_tokens.py # tiktoken + fallback
├── test_lib_dedup.py # Shingle hashing, Jaccard
├── test_lib_markdown.py # MD parsing, normalization
├── test_rle.py # RLE basics
├── test_rle_comprehensive.py # Path/IP/enum edge cases
├── test_tokenizer_optimizer.py # Format optimization
├── test_tokenizer_optimizer_comprehensive.py # Extended optimizer tests
├── test_config.py # Config loading
├── test_tokens.py # Token utilities
├── # Integration & validation
├── test_main_entry.py # mem_compress.py CLI routing
├── test_cli_commands.py # Subprocess CLI invocation
├── test_pipeline.py # Full pipeline integration
├── test_integration.py # End-to-end scenarios
├── test_roundtrip.py # Roundtrip guarantees
├── test_roundtrip_comprehensive.py # Extended roundtrip tests
├── test_performance.py # Performance regression
├── test_benchmark.py # Benchmark command
├── test_tiers_comprehensive.py # Tier edge cases
├── test_error_handling.py # Error paths
├── test_new_features.py # Recent feature tests
├── test_real_workspace.py # Real workspace validation
├── test_token_economics.py # Cost calculations
└── test_markdown_advanced.py # Advanced MD scenarios

## Coverage Matrix
| compress_memory | | | | |
| dictionary_compress | | | | (50+ cases) |
| observation_compressor | | | | N/A (lossy) |
| dedup_memory | | | | N/A |
| generate_summary_tiers | | | | N/A |
| estimate_tokens | | | | N/A |
| audit_memory | | | | N/A |
| compressed_context | | | | N/A (lossy) |
| lib/tokens | | — | | N/A |
| lib/markdown | | — | | N/A |
| lib/dedup | | — | | N/A |
| lib/dictionary | | — | | |
| lib/rle | | — | | |
| lib/tokenizer_optimizer | | — | | N/A |
| lib/config | | — | | N/A |
| mem_compress (CLI) | | | | N/A |

### Edge Cases Tested
- **Empty files** — all modules handle gracefully
- **Unicode/CJK** — Chinese headers, mixed en/zh, emoji, accented characters
- **Large files** — 100K+ characters, 2000+ sections
- **Malformed markdown** — unclosed code blocks, broken headers, missing spaces
- **Headers-only files** — no body content
- **Single-line files** — minimal content
- **Nonexistent paths** — proper errors and exit codes
- **Overlapping dictionary codes** — no collisions
- **Adjacent `$XX` codes** — correct boundary detection
- **Empty codebooks** — graceful no-op

## Running Tests
```bash
cd skills/claw-compactor

# Run all tests
PYTHONPATH=scripts python3 -m pytest tests/ -v

# Run a specific test file
PYTHONPATH=scripts python3 -m pytest tests/test_dictionary.py -v

# Run a specific test class
PYTHONPATH=scripts python3 -m pytest tests/test_roundtrip.py::TestDictionaryRoundtrip -v

# Run with coverage (requires pytest-cov)
PYTHONPATH=scripts python3 -m pytest tests/ --cov=lib --cov-report=term-missing

# Quick check (no verbose)
PYTHONPATH=scripts python3 -m pytest tests/ -q

**Expected output:**
810 passed in 31s

## Fixtures (conftest.py)
Shared test fixtures provide consistent test environments:

- `tmp_workspace`: Workspace with MEMORY.md + `memory/` containing 2 daily files
- `empty_file`: Empty `.md` file
- `unicode_file`: Chinese + Japanese + emoji + accented characters
- `large_file`: 2000 sections, 100K+ characters
- `broken_markdown`: Malformed headers, unclosed code blocks
- `headers_only`: Only header lines, no body text
- `single_line`: Single line of text
- `duplicate_content`: Two files with known overlapping sections

## Adding New Tests

### For a new compression technique
1. Create `tests/test_<technique>.py`
2. Include at minimum:
 - **Basic functionality** — happy path
 - **Empty input** — should return empty/no-op
 - **Unicode input** — CJK, emoji, mixed scripts
 - **Roundtrip** (if lossless) — `decompress(compress(x)) == x`
 - **Non-inflation** — `len(compress(x)) <= len(x)` in tokens
 - **Idempotency** — `compress(compress(x)) == compress(x)`

3. Add fixture if needed in `conftest.py`

### For a new edge case
1. Add to the most relevant existing test file
2. Use the `@pytest.mark.parametrize` decorator for variants
3. Document what the edge case covers in the test docstring

### Test naming convention
```python
class TestModuleName:
 def test_basic_functionality(self):
 """Module handles the standard case."""

 def test_empty_input(self):
 """Module handles empty input gracefully."""

 def test_unicode_content(self):
 """Module handles CJK and emoji content."""

 def test_roundtrip_guarantee(self):
 """Compress then decompress returns original."""

## Continuous Validation
Tests should be run:
- Before any code change is committed
- After modifying any `lib/` module (shared dependencies)
- After updating compression rules or codebook logic
- As part of the `full` pipeline verification (post-packaging)