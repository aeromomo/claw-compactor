# REFACTOR_PLAN.md — claw-compactor Full Refactor

**Audit Date:** 2026-03-07  
**Baseline:** 919 tests, all passing (10 skipped)  
**Codebase size:** ~7,300 lines Python across 23 files  
**Constraint:** Max 3 files changed per Phase, serial execution

---

## Architecture Audit Findings

### Structural Issues (by priority)

#### 🔴 Critical

1. **Duplicate implementations in `markdown.py` vs `tokenizer_optimizer.py`**
   - `normalize_chinese_punctuation()` ≈ `normalize_punctuation()` — near-identical logic, different `_ZH_PUNCT_MAP` dicts (markdown.py has 4 extra quote mappings; tokenizer_optimizer.py has slightly different quote handling). These diverge silently.
   - `compress_markdown_table()` (markdown.py) vs `compress_table_to_kv()` (tokenizer_optimizer.py) — same algorithm, different output format (markdown prefixes rows with `- `, tokenizer does not). Callers pick randomly.
   - Risk: future bug fixes applied to one but not the other.

2. **`sys.path.insert(0, ...)` used in every single script file (12 files)**  
   All top-level scripts do `sys.path.insert(0, str(Path(__file__).resolve().parent))` to find `scripts/lib/`. No package structure (`__init__.py` in `scripts/`), no `pyproject.toml` entry point.  
   - Tests do `sys.path.insert(0, ".../scripts")` in conftest.py AND many individual test files (redundant, fragile).

3. **`mem_compress.py` is a 788-line monolith** — holds argument parsing, 12 command handler functions, CLI dispatch, and business logic all in one file.

#### 🟡 Medium

4. **Missing `scripts/__init__.py`** — scripts/ directory is not a proper package, preventing clean relative imports and making the layout confusing.

5. **Scattered `_ZH_PUNCT_MAP` dictionaries** — defined twice (markdown.py and tokenizer_optimizer.py) with subtle divergence. Should be a single canonical mapping in `lib/unicode_maps.py` or merged into one module.

6. **`compress_memory.py`'s `rule_compress()` calls `compress_markdown_table()` from `markdown.py`** while `optimize_tokens()` in `tokenizer_optimizer.py` calls `compress_table_to_kv()` — both are called in the `full` pipeline, so tables get compressed twice (partially idempotent but wasteful).

7. **`cmd_full()` in `mem_compress.py`** does a second `sys.path.insert` at line 344 (inside a function body). This is defensive hackery that shouldn't be needed.

8. **`FileNotFoundError_`** in `exceptions.py` shadows the built-in with a trailing underscore — unconventional; should be `MemCompressFileNotFoundError` or just inherit from `FileNotFoundError`.

#### 🟢 Low

9. **`benchmark/` directory is separate from `scripts/`** — inconsistent: some benchmark code is in `scripts/` (via `cmd_benchmark`), some in `benchmark/`. This splits related functionality.

10. **Dead import in `scripts/lib/__init__.py`**: exposes `EngramEngine` and `EngramStorage` at package level but the package is not installed (no `pip install -e .`), so these imports are only reachable after `sys.path` hacking.

11. **`tests/` has 40 test files** but no subdirectory organization. All flat in one directory. Hard to navigate.

---

## Refactor Phases

---

### Phase A — Foundation: Eliminate Duplication & Fix Import Structure
**Goal:** Single source of truth for punctuation maps and table compression; clean import path.  
**Files changed:** ≤ 3  
**Risk:** Low — pure refactor, backed by existing 919 tests.

#### A1. Create `scripts/lib/unicode_maps.py`
- Canonical `ZH_PUNCT_MAP` dict (merged superset of both existing maps).
- Canonical `_ZH_PUNCT_RE` compiled regex.
- Export: `ZH_PUNCT_MAP`, `ZH_PUNCT_RE`, `normalize_zh_punctuation(text) -> str`.

#### A2. Refactor `scripts/lib/markdown.py`
- Remove local `_ZH_PUNCT_MAP` / `_ZH_PUNCT_RE` / `normalize_chinese_punctuation()`.
- Import from `unicode_maps`: `from lib.unicode_maps import normalize_zh_punctuation as normalize_chinese_punctuation`.
- Alias for full backward compat (existing callers unchanged).

#### A3. Refactor `scripts/lib/tokenizer_optimizer.py`
- Remove local `_ZH_PUNCT_MAP` / `_ZH_PUNCT_RE` / `normalize_punctuation()`.
- Import from `unicode_maps`: `from lib.unicode_maps import normalize_zh_punctuation as normalize_punctuation`.
- Add `# noqa: F401` alias export so existing `from lib.tokenizer_optimizer import normalize_punctuation` still works.

**Validation:** `python3 -m pytest tests/ -q` → must pass ≥919.

---

### Phase B — Structure: Proper Package Layout & Monolith Split
**Goal:** Eliminate `sys.path` hacks; split `mem_compress.py` into focused modules.  
**Files changed:** ≤ 3 (but larger changes)  
**Risk:** Medium — changes import paths; tests must be updated.

#### B1. Add `scripts/__init__.py` + `pyproject.toml` entry points
- Make `scripts/` a proper package (or move lib/ up one level to `src/clawcompactor/`).
- Add `[project.scripts]` entry points in `pyproject.toml`:
  ```
  mem-compress = "scripts.mem_compress:main"
  ```
- Add `[tool.pytest.ini_options] pythonpath = ["scripts"]` to `pyproject.toml` → eliminates all `sys.path.insert` in tests.

#### B2. Split `mem_compress.py` into `scripts/cli/` subpackage
- `scripts/cli/__init__.py`
- `scripts/cli/commands.py` — all `cmd_*` functions (compress, dedup, tiers, audit, etc.)
- `scripts/cli/parser.py` — argparse setup
- `scripts/mem_compress.py` becomes a thin entry point: `from cli.parser import build_parser; from cli.commands import dispatch; ...`

#### B3. Consolidate duplicate table-compression logic
- `markdown.compress_markdown_table` and `tokenizer_optimizer.compress_table_to_kv` unified into one function in `markdown.py`.
- `tokenizer_optimizer.compress_table_to_kv` becomes an alias: `from lib.markdown import compress_markdown_table as compress_table_to_kv`.
- Decide on canonical output format (with or without `- ` prefix; recommend without for token efficiency, matching tokenizer_optimizer behavior).

---

### Phase C — Quality: Exceptions, Test Organization, `FileNotFoundError_`
**Goal:** Cleaner exception hierarchy; test suite organized into subdirectories.  
**Files changed:** ≤ 3  
**Risk:** Low.

#### C1. Fix `exceptions.py`
- Rename `FileNotFoundError_` → `CompactorFileNotFoundError(MemCompressError, FileNotFoundError)`.
- Update all callers (`scripts/*.py`, `tests/*.py`).
- Backward compat shim: `FileNotFoundError_ = CompactorFileNotFoundError`.

#### C2. Organize `tests/` into subdirectories
```
tests/
  core/         # test_lib_tokens.py, test_lib_dedup.py, test_lib_markdown.py, test_rle*.py, test_dictionary*.py
  compression/  # test_compress_memory*.py, test_observation*.py, test_tiers*.py
  integration/  # test_integration.py, test_roundtrip*.py, test_pipeline.py, test_real_workspace.py
  engram/       # test_engram*.py
  cli/          # test_cli_commands.py, test_main_entry.py
  benchmark/    # test_benchmark.py, test_performance.py, test_token_economics.py
```
- Move files, update `conftest.py` imports.

#### C3. Add `scripts/lib/unicode_maps.py` extended coverage
- Add `normalize_ascii_quotes(text)` — smart quotes to straight quotes (currently missing).
- Add `strip_zero_width(text)` — remove zero-width joiners / non-joiners (common in CJK text copy-paste).
- Expose all in `__init__.py` for clean imports.

---

## Phase A Implementation (this run)

**Implementing A1 + A2 + A3 now.**

Files to create/modify:
1. **CREATE** `scripts/lib/unicode_maps.py` — canonical punctuation map
2. **MODIFY** `scripts/lib/markdown.py` — import from unicode_maps
3. **MODIFY** `scripts/lib/tokenizer_optimizer.py` — import from unicode_maps

Expected outcome:
- Zero duplicate `_ZH_PUNCT_MAP` dicts in codebase
- `normalize_chinese_punctuation` and `normalize_punctuation` now guaranteed identical behavior
- All 919 tests continue to pass
- New module is self-contained and easily extensible for Phase C
