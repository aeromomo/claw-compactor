# Compression Techniques
claw-compactor applies 5 independent compression techniques in a layered pipeline. Each targets a different source of token waste and can run independently.

---

## 1. Rule-Based Compression
**Module:** `compress_memory.py` + `lib/markdown.py`
**Typical savings:** 4-8% on memory files
**Lossless:** Yes

The rule engine applies deterministic transformations that remove redundancy without losing any information.

### Rules Applied
Exact dedup, Description=Remove duplicate lines within a section, Typical Impact=1-3%
Near-dedup merge, Description=Merge sections with >60% Jaccard similarity, Typical Impact=1-2%
Whitespace strip, Description=Collapse excessive blank lines, trailing spaces, Typical Impact=0.5-1%
Empty section removal, Description=Remove headers with no body content, Typical Impact=0.5%
Markdown filler, Description=Strip unnecessary bold/italic/backtick markers, Typical Impact=0.5-1%
Chinese punctuation, Description=Fullwidth `,.!` → halfwidth `,.!` (saves 1 token each), Typical Impact=0-1%

### Before / After
**Before:**
```markdown

## Remote Machines

### Production Server
- IP: 10.0.2.1, Internal: 10.0.1.2, User: deploy

### Production Server
- Internal IP: 10.0.2.1, IP: 10.0.1.2, SSH user: deploy
- SSH: `ssh -i ~/.ssh/server_key.pem deploy@10.0.2.1`

## Notes
```

**After:**

The duplicate "Production Server" section was merged (near-dedup), and the empty "Notes" section was removed.

## 2. Dictionary Encoding
**Module:** `dictionary_compress.py` + `lib/dictionary.py`
**Typical savings:** 4-5% on memory files
**Lossless:** Yes (perfect roundtrip)

### How It Works
1. **Scan** — Analyze all workspace markdown files for n-gram frequencies (1-4 words)
2. **Score** — For each candidate phrase: `score = freq × (len(phrase) - len(code)) - codebook_overhead`
3. **Build** — Select top-scoring phrases, assign `$A1`, `$A2`, ... codes
4. **Compress** — Replace all occurrences of phrases with their codes
5. **Store** — Save codebook to `memory/.codebook.json`

### Codebook Format
```json
{
 "version": 1,
 "entries": {
 "$A1": "example_user",
 "$A2": "10.0.1",
 "$A3": "workspace",
 "$A4": "server_key.pem",
 "$A5": "my-secret-token-2024"
 }
}
```

**Before (TOOLS.md excerpt):**
- user: example_user
- SSH: ssh -i ~/.ssh/server_key.pem deploy@10.0.1.2
- IP: 10.0.1.1, Token: my-secret-token-2024, Workspace: /home/user/workspace

**After:**
- user: $A1
- SSH: ssh -i ~/.ssh/$A4 deploy@$A2.2
- IP: $A2.1, Token: $A5, Workspace: /home/$A1/$A3

### Roundtrip Guarantee
`decompress_text(compress_text(text, codebook), codebook) == text` — always. The compression and decompression functions are perfect inverses. This is verified by 50+ roundtrip tests covering edge cases (overlapping phrases, adjacent codes, Unicode, empty input).

### Collision Avoidance
Codes use the `$` prefix followed by uppercase alphanumeric characters. The codebook builder checks that no code is a substring of another code and that no code appears naturally in the source text.

## 3. Session Observation Compression
**Module:** `observation_compressor.py`
**Typical savings:** ~97% on session transcripts
**Lossless:** No (facts preserved, verbosity removed)

This is the single largest source of savings. Raw session transcripts contain verbose tool output — file contents, command results, API responses — most of which is never needed again.

### Pipeline
.jsonl transcript (26,000 tokens)
 │
 ▼
 Parse messages → extract tool calls
 Classify interactions → [feature|bugfix|decision|discovery|config|...]
 Rule-based extraction → key facts, errors, decisions
 Generate LLM prompt (optional) → structured XML
 Format as markdown observation (~780 tokens)

### Observation XML Format
```xml
<observations>
 <observation>
 <type>config</type>
 <title>Network configured for multi-node setup</title>
 <facts>
 - Gateway: 10.0.1.1, Remote node: 10.0.1.2, Worker: 10.0.1.3
 </facts>
 <narrative>Set up mesh network connecting 3 nodes</narrative>
 </observation>
</observations>
```

**Before (raw session, 847 lines):**
```
{"role":"assistant","content":"Let me check the network..."}
{"role":"tool","name":"exec","content":"network status\n200 OK...\n"}
{"role":"assistant","content":"Good, the network is active. Let me check peers..."}
... (800+ more lines of tool output)
```

**After (observation, 12 lines):**

## 1. [config] Multi-Node Network Setup
**Facts:**
- Gateway: 10.0.1.1
- Remote node: 10.0.1.2
- All peers connected

**Result:** 3-node mesh network operational

## 4. RLE Pattern Compression
**Module:** `lib/rle.py`
**Typical savings:** 1-2%
**Lossless:** Yes (roundtrip supported)

Targets three categories of structured repetitive data:

### Path Compression
Long workspace paths are replaced with `$WS`:

Before: /home/user/workspace/skills/claw-compactor/scripts/lib/tokens.py
After: $WS/skills/claw-compactor/scripts/lib/tokens.py

Decompression: `decompress_paths(text, "/home/user/workspace")`

### IP Family Compression
When multiple IPs share a common prefix (≥2 occurrences), the prefix is extracted:

Before:
 - 10.0.1.1
 - 10.0.1.2
 - 10.0.1.3

After:
 $IP1=10.0.1.
 - $IP1.1
 - $IP1.2
 - $IP1.3

### Enumeration Compaction
Detects comma-separated uppercase lists and compacts them:

Before: The supported types are FEATURE, BUGFIX, DECISION, DISCOVERY, CONFIG, DEPLOYMENT, DATA, INVESTIGATION
After: Types: [FEATURE,BUGFIX,DECISION,DISCOVERY,CONFIG,DEPLOYMENT,DATA,INVESTIGATION]

## 5. Compressed Context Protocol (CCP)
**Module:** `compressed_context.py`
**Typical savings:** 20-60% depending on level
**Lossless:** No (designed for model consumption)

CCP is designed for a specific use case: compress context on a cheap model, then feed it to an expensive model. The receiving model gets decompression instructions in its system prompt.

### Three Levels

#### Ultra (40-60% compression)
Aggressive abbreviation + filler removal. The output looks telegraphic:

 John has approximately 15 years of experience in software development,
 with a focus on infrastructure and cloud architecture. He is the
 Chief Executive Officer of TechCorp, based in San Francisco.

 John ~15y exp software dev, focus infra+cloud arch. CEO: TechCorp, loc:SF

Decompression instruction:
 "Compressed notation: key:val=attribute, loc:X=location,
 Ny+=N+ years, slash-separated=alternatives. Expand naturally."

#### Medium (20-35% compression)
Moderate abbreviation with key:value notation:

 The application server runs on port 8080 with a maximum of 256
 concurrent connections. The database connection pool is configured
 with 20 minimum and 50 maximum connections.

 App server: port 8080, max 256 concurrent conns.
 DB pool: min 20, max 50 conns.

#### Light (10-20% compression)
Light condensation only — remains fully human-readable:

 We decided to use PostgreSQL instead of MySQL for the new project
 because it has better support for JSON columns and more advanced
 indexing capabilities that we need for our search functionality.

 Decision: PostgreSQL over MySQL — better JSON column support
 and advanced indexing for search needs.

### Decompression Instructions
Each level generates a decompression instruction block to prepend to the receiving model's system prompt:

Ultra: "Compressed notation: key:val=attribute, loc:X=location, ..."
Medium: "Text uses abbreviated notation: key:value pairs, condensed lists, ..."
Light: "Text is lightly condensed. Read normally."

## Technique Comparison
| Rule engine | 4-8% | | Zero | Memory files |
| Dictionary | 4-5% | | Zero | Repetitive workspaces |
| Observation | ~97% | * | Zero or 1 LLM call | Session transcripts |
| RLE | 1-2% | | Zero | Path-heavy, IP-heavy docs |
| CCP | 20-60% | | Zero | Cross-model context passing |

*Observation compression preserves all facts and decisions; only verbose tool output is removed.

## Pipeline Interaction
The techniques are designed to compose:

1. **Rule engine first** — removes obvious waste before dictionary scoring
2. **Dictionary second** — works on cleaner text, better phrase detection
3. **RLE alongside dictionary** — different targets, no interference
4. **Observation runs independently** — operates on transcripts, not memory files
5. **CCP runs last or standalone** — can compress already-compressed output further
