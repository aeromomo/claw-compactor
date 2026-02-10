# References

Technical documentation for claw-compactor internals.

## Files
- **compression-techniques.md** — Deep dive into all 5 compression techniques
- **benchmarks.md** — Real-world performance measurements
- **architecture.md** — System architecture and module relationships
- **testing.md** — Test strategy and coverage goals
- **compression-prompts.md** — LLM prompt templates for observation compression

## Key Design Decisions

### Dictionary Encoding
The codebook uses `$XX` codes (uppercase alpha) to avoid conflicts with:
- Shell variables (`$lower_case`)
- Markdown formatting (`**bold**`)
- Natural text (`$100`, `$USD`)

Code length starts at 3 chars (`$AA`) and grows to 4 (`$AAA`) after 676 entries.

### Workspace Path Shorthand
`$WS` replaces the full workspace path. This is the single highest-value substitution for most workspaces since the path appears in every file reference.

Example codebook:
```json
{
 "$A1": "example_user",
 "$A2": "10.0.1",
 "$A3": "workspace"
}
```

**Before:** `ssh deploy@10.0.1.2` / `ssh admin@10.0.1.3`
**After:** `ssh deploy@$A2.2` / `ssh admin@$A2.3`

### Token Estimation
Two backends:
1. **tiktoken** (preferred) — exact cl100k_base encoding, same as Claude models
2. **Heuristic fallback** — CJK-aware chars÷4 approximation, ~90% accurate

### Workspace paths
- `/home/user/workspace` → `$WS`

All path compression is fully reversible via `decompress_paths()`.
