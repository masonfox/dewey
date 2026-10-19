## Dewey Book Migrator

[![GHCR Package](https://img.shields.io/badge/ghcr-dewey-blue?logo=docker)](https://github.com/masonfox/dewey/pkgs/container/dewey)
[![codecov](https://codecov.io/gh/masonfox/dewey/graph/badge.svg?token=5CR300GF1F)](https://codecov.io/gh/masonfox/dewey)

Node-based containerized watcher that organizes incoming audiobooks and EPUB ebooks into one canonical library using ffprobe, EPUB package metadata, and optional AI for author/title normalization. Every format of a book (audiobook, EPUB, and Storyteller read-aloud EPUB) lands in the same `[Author]/[Title]` folder, whichever arrives first.

### Features
- **Smart Directory Watching**: Monitors source directory with configurable stability timeout to ensure complete uploads
- **ffprobe, EPUB & AI-Powered Normalization**: Uses audio tags, EPUB OPF metadata, and optional AI to normalize author/title
- **Audiobooks and Ebooks**: Supports `.mp3`, `.m4b`, `.m4a`, and `.epub`, including read-aloud EPUBs with media overlays
- **Cross-Format Matching**: Places a new format into the book folder that already exists for it, by identifier, normalized metadata, or AI-confirmed near match
- **Configurable Layouts**: `audiobookshelf` (default, unchanged paths) or `bookorbit` (canonical ebook names)
- **Safe by Default**: Never overwrites a library file; ambiguous or conflicting units go to a review folder with an explanation
- **Dry Run**: Preview every planned action without touching the filesystem
- **Flexible Structure**: Handles single files, multi-file directories, and mixed audio + EPUB directories
- **Robust Processing**: Stability checks, processing locks, staged copies, and recovery after interruption
- **Smart Fallbacks**: Falls back to heuristic parsing when AI or embedded metadata is unavailable
- **Comprehensive Logging**: Every match and placement decision is logged with its reason
- **File Permissions**: Configurable ownership (PUID/PGID) and permissions for migrated content
- **Rate Limiting**: Built-in AI request pacing with exponential backoff retry logic

### Quick Start
**Docker Compose** (Recommended)
```
services:
  dewey:
    image: ghcr.io/masonfox/dewey:latest
    container_name: dewey
    environment:
      ANTHROPIC_API_KEY: sk-ant-xxxx
      # LIBRARY_LAYOUT: bookorbit
      # REVIEW_DIR: /data/review
    volumes:
      - your/path/to/incoming:/data/incoming
      - your/path/to/library:/data/library
      - your/path/to/logs:/data/logs
      # Optional: keep quarantined units outside the incoming folder
      # - your/path/to/review:/data/review
    restart: unless-stopped
```

**Docker Run Script**
```bash
docker run -d --name dewey \
  -e ANTHROPIC_API_KEY=sk-ant-xxxx \
  -v your/path/to/incoming:/data/incoming \
  -v your/path/to/library:/data/library \
  -v your/path/to/logs:/data/logs \
  ghcr.io/masonfox/dewey:latest
```

No extra volume is required for the review folder: by default it lives at `/data/incoming/.dewey-review`, inside the already-mounted source directory. To keep it elsewhere, mount a directory and point `REVIEW_DIR` at it (it must be outside `DEST_DIR`).

### Local Development

```bash
# Install dependencies
bun install

# Set environment variables
cp .env.example .env

# change these .env values to local paths:
SOURCE_DIR=./data/incoming
DEST_DIR=./data/library

# Run the application
bun start

# Run tests
bun test

# Run tests with full integration test coverage (requires API key)
ANTHROPIC_API_KEY=sk-ant-xxx bun test
```

**Note on Testing**: Integration tests requiring Claude API access will be automatically skipped if `ANTHROPIC_API_KEY` is not set. This allows the test suite to run in CI without API credentials while still providing comprehensive coverage for core functionality.

Drop `.mp3`/`.m4b`/`.m4a`/`.epub` files or directories into the `incoming/` directory. Dewey will automatically detect and migrate them to your organized library.

Ensure your repository has Actions permissions set to `Read and write packages` in Settings → Actions → General.

### Supported Formats

| Kind | Extensions (case-insensitive) | Metadata source |
| --- | --- | --- |
| Audio | `.mp3`, `.m4b`, `.m4a` | ffprobe format tags (title, artist, year, genre, ISBN, ASIN, language) |
| Ebook | `.epub` | OPF package document (title, author-role creator, language, ISBN/ASIN identifiers) |
| Read-aloud ebook | `.epub` whose OPF manifest declares media overlays (e.g. Storyteller output) | Same as ebook |

Other file types never make a file or folder a migration unit on their own. Set `INGEST_EBOOKS=false` to ignore `.epub` files entirely, as before ebook support.

- A loose supported file directly in `SOURCE_DIR` is a single-file unit.
- A folder that directly contains supported files is one unit; all of its direct supported files, of any mix of formats, migrate together into the same book.
- A folder with no direct supported files (e.g. an author folder) is traversed, and each book folder inside it becomes its own unit.
- An EPUB whose archive or OPF can't be read logs a warning and falls back to filename heuristics.

When a unit has several files, author/title come from the first available source in this order: `.m4b`, EPUB, `.mp3`/`.m4a`, read-aloud EPUB. Identifiers are collected from every EPUB and `.m4b` and one representative audio track.

### Library Layouts

`LIBRARY_LAYOUT` chooses how files are named. Both layouts put every format of a book directly in one folder, `DEST_DIR/[Author]/[Title]/`, with no format subfolders, so Book Orbit (`book_per_folder`) and Audiobookshelf both read it as one book. A unit that matches an existing book uses that folder exactly as it is named.

**`audiobookshelf`** (default) keeps every original filename, so audiobook paths are the same as before this feature. The one exception: a read-aloud EPUB whose name equals a regular EPUB already in the folder gets ` (readaloud)` before its extension.

```
library/
└── Frank Herbert/
    └── Dune/
        ├── Dune.m4b
        ├── Dune.epub                 # original EPUB
        └── Dune (readaloud).epub     # read-aloud EPUB that was also named Dune.epub
```

**`bookorbit`** keeps audio filenames and gives ebooks canonical names from the book folder's title: `<Title>.epub` and `<Title> (readaloud).epub`.

```
incoming/                              library/
├── Dune.m4b                           └── Frank Herbert/
├── dune_herbert_retail.epub    ──▶        └── Dune/
└── dune_storyteller.epub                      ├── Dune.m4b
    (has media overlays)                       ├── Dune.epub
                                               └── Dune (readaloud).epub
```

Under `audiobookshelf`, the same input keeps `dune_herbert_retail.epub` and `dune_storyteller.epub` as-is. Layout affects only names: it never changes metadata extraction or matching, and switching layouts never renames files already in the library.

### Cross-Format Matching

Before creating a folder, Dewey compares each unit against the library as it is on disk right now. Candidates are book folders that contain at least one supported file, under author folders whose normalized author key equals the unit's. The library is re-read for every unit, so books placed moments ago, or by other tools, are visible. Matching tries, in order:

1. **Identifier**: a shared ISBN or ASIN with exactly one candidate wins (e.g. a read-aloud EPUB carrying the same ISBN as `Dune.epub`). Different identifiers across formats don't block a match, since ebook and audiobook editions carry different ones.
2. **Deterministic keys**: exactly one candidate with equal normalized author and title keys. Author keys fold case, diacritics, punctuation, and whitespace and turn "Herbert, Frank" into "frank herbert". Title keys also drop a leading article and format noise such as `(Unabridged)`, `Audiobook`, `[M4B]`, or `Retail`. So `Herbert, Frank/Dune (Unabridged)` matches an EPUB "Dune" by "Frank Herbert" without an AI request.
3. **Near match + AI**: same author key, and titles related by a subtitle prefix or a small typo (edit distance ≤ 2, both keys ≥ 6 characters). AI (if configured) sees up to five candidates. Its answer is accepted only if it names one candidate as the same work and edition with high confidence ("Dune: Deluxe Edition" → existing `Dune`). A high-confidence "none of these" makes a new book ("Dune Messiah" next to "Dune").
4. **New book or ambiguous**: no equal or near candidate makes a new book at `[Author]/[Title]`. Anything uncertain is ambiguous.

A unit is **ambiguous**, and is quarantined instead of placed, when:
- more than one candidate matches equally (e.g. both `Frank Herbert/Dune` and `Frank Herbert/Dune 1`), or one identifier appears in more than one book;
- one side is abridged and the other is not (`Dune (Abridged)` vs an unabridged library book);
- both sides have a known language and they differ (a `de` EPUB vs an `en` library EPUB);
- a regular EPUB's ISBN differs from the regular EPUB already in the book (a different ebook edition);
- only a near match exists and AI is unavailable, unsure, refused, or didn't confirm.

Each unit logs one `info` line with the outcome (identifier, deterministic, AI, new book, or ambiguous), the book folders involved, and the deciding signal, for example:

```
🔗 Match deterministic match for "Dune.epub": book Frank Herbert/Dune; signal: equal author/title keys; normalized author and title keys are equal
```

Units are processed one at a time, so `Dune.epub` and `Dune.m4b` dropped together still produce a single `Frank Herbert/Dune/` folder, and EPUB-first and audiobook-first ingestion give the same result.

### Safety, Review Quarantine, and Dry Run

**No silent overwrites.** Dewey plans every destination path for a unit before writing anything. For each file:
- the destination doesn't exist → copied;
- the destination exists with the same size and SHA-256 → skipped as identical (re-dropping the same file is a no-op that removes the source);
- the destination exists with different content → conflict.

A single conflict or ambiguity stops the whole unit: none of its files are written to the library.

**Review quarantine.** Ambiguous and conflicting units are moved (never deleted) to `REVIEW_DIR`, default `SOURCE_DIR/.dewey-review`. The watcher ignores it, so quarantined files are not picked up again. Each unit gets its own `<timestamp>-<name>` folder that keeps the unit's original relative structure (a `-2`, `-3`… suffix is added if the name is taken), plus a `dewey-review.json`:

```
incoming/.dewey-review/
└── 20261019143005-Dune (German)/
    ├── Dune (German)/
    │   └── Dune.epub
    └── dewey-review.json
```

```json
{
  "reason": "ambiguous",
  "explanation": "the languages differ (language de != en)",
  "paths": ["/data/library/Frank Herbert/Dune"],
  "timestamp": "2026-10-19T14:30:05.123Z"
}
```

`reason` is `ambiguous` or `conflict`; `paths` lists the candidate or conflicting library paths. The quarantine is logged at `warn` with the review path. The job finishes as completed (outcome `quarantined`) and is not retried. To resolve, fix the library or the files, then move them back into `SOURCE_DIR`.

**Recoverable transfers.** Each file is copied to a hidden `.dewey-partial-*` name in the book folder, verified by size, and renamed into place without clobbering. Sources are removed only after every file of the unit is in place. On startup, leftover `.dewey-partial-*` files are removed; reprocessing an interrupted unit recognizes already-placed files as identical and finishes normally.

**Dry run.** With `DRY_RUN=true`, Dewey still discovers, reads metadata, normalizes, and matches, but only logs what it would do (create folder, copy, skip identical, remove source, quarantine) with a `🧪 [dry-run]` marker. Nothing in `SOURCE_DIR`, `DEST_DIR`, or `REVIEW_DIR` is created, copied, renamed, moved, deleted, chowned, or chmodded.

**Recommended rollout for Book Orbit users:**

1. Start with `LIBRARY_LAYOUT=bookorbit` and `DRY_RUN=true`.
2. Drop books into `incoming/` and read the logs: the match line and the planned actions for each unit.
3. When the plan looks right, set `DRY_RUN=false` and restart. Files still in `incoming/` are picked up on startup.

### Upgrading: Behavior Changes

- **Overwrite → quarantine.** Previously, a file whose library destination already existed was overwritten. Now an identical file is skipped and its source removed, and a *different* file quarantines the whole unit with reason `conflict`, leaving the library untouched. Re-dropping a corrected file to replace a library file no longer works; remove or rename the library file first.
- **EPUBs are now organized.** `.epub` files in `SOURCE_DIR` were ignored before; directory units that previously copied only audio now also copy their EPUBs. Set `INGEST_EBOOKS=false` to keep the old behavior.
- **Audiobook paths are unchanged.** With default settings (`LIBRARY_LAYOUT=audiobookshelf`), an audio-only unit gets the same `DEST_DIR/[Author]/[Title]/<original filename>` as before, unless it now matches an existing book folder.
- **Rollback:** redeploy the previous image. Library contents are valid for both versions, and anything in `REVIEW_DIR` is plain files you can move back into `SOURCE_DIR`.

### Library Configuration

| Variable | Default | Values |
| --- | --- | --- |
| `LIBRARY_LAYOUT` | `audiobookshelf` | `audiobookshelf` or `bookorbit` (case-insensitive); anything else fails startup validation |
| `REVIEW_DIR` | `SOURCE_DIR/.dewey-review` | Any path outside `DEST_DIR`; a path inside `DEST_DIR` fails startup validation |
| `DRY_RUN` | `false` | `true` / `false` |
| `INGEST_EBOOKS` | `true` | `true` / `false` |

See `.env.example` for every variable.

### How It Works

1. **Directory Monitoring**: `chokidar` watches the source directory (except `REVIEW_DIR`) for file/folder additions and changes
2. **Stability Checking**: New items are queued and checked for stability (no recent modifications) before processing
3. **Smart Grouping**:
   - Directories with supported files (audio, EPUB, or both) are processed as single units
   - Single files are handled individually or grouped with their parent directory
   - Processing locks prevent race conditions; jobs run one at a time
4. **Metadata Extraction**:
   - Uses ffprobe for audio tags and the OPF package for EPUBs
   - Uses the selected AI provider to normalize this data for correctness and consistency
   - Falls back to heuristic parsing if AI is unavailable
   - Rate limiting prevents API quota exhaustion
5. **Matching**: The unit is matched against existing library books (identifier → normalized keys → near match + AI → new book or ambiguous)
6. **Planning**: Every destination path is decided and checked for identical files and conflicts before anything is written
7. **Library Organization**: Files are staged and renamed into `DEST_DIR/[Author]/[Title]/`, or the unit is quarantined to `REVIEW_DIR`
8. **Cleanup**: Source files/directories are removed after the whole unit is placed
9. **Logging**: All operations logged to console and persistent log file
### AI provider configuration

AI normalization is optional. With no provider variables, Dewey selects Anthropic,
model `claude-haiku-4-5-20251001`, and uses heuristics when no Anthropic key is set.
Selection is explicit: available keys never select a provider and no gateway or
provider failover is used. Configuration is read dynamically for each operation.

| AI_PROVIDER | AI_MODEL | Credential | AI_BASE_URL |
| --- | --- | --- | --- |
| `anthropic` (default) | Optional; see precedence below | `ANTHROPIC_API_KEY` | Optional; default `https://api.anthropic.com/v1` |
| `openai` | Required | `OPENAI_API_KEY` | Optional; default `https://api.openai.com/v1` |
| `google` | Required | `GOOGLE_GENERATIVE_AI_API_KEY` | Optional; default `https://generativelanguage.googleapis.com/v1beta` |
| `openai-compatible` | Required | Optional `AI_API_KEY` | Required HTTP(S) API base |

Use one of these environment blocks (model identifiers must be available to your account/server):

```dotenv
# Anthropic, including existing deployments:
ANTHROPIC_API_KEY=sk-ant-example
# Default model is used without AI_MODEL.
```

```dotenv
AI_PROVIDER=openai
AI_MODEL=gpt-4.1-mini
OPENAI_API_KEY=your-openai-key
```

```dotenv
AI_PROVIDER=google
AI_MODEL=gemini-2.5-flash
GOOGLE_GENERATIVE_AI_API_KEY=your-google-key
```

```dotenv
# Local server without authentication (authorization header is omitted):
AI_PROVIDER=openai-compatible
AI_MODEL=local-model
AI_BASE_URL=http://localhost:1234/v1
```

```dotenv
# Hosted compatible endpoint with authentication:
AI_PROVIDER=openai-compatible
AI_MODEL=hosted-model
AI_BASE_URL=https://inference.example.com/v1
AI_API_KEY=your-compatible-key
```

In Docker, use a host or service address reachable from the container; localhost
refers to the container itself. Protocol compatibility does not guarantee that a
local model can reliably return useful JSON metadata.

Only the selected provider's key is read. `AI_API_KEY` never overrides native
provider keys. Keys are trimmed and matching surrounding single or double quotes
are removed. Unselected provider settings, including legacy Anthropic settings,
are ignored. A missing native key warns and disables AI network calls; a
compatible endpoint can run without a key.

Anthropic model precedence is nonblank `AI_MODEL`, then nonblank `CLAUDE_MODEL`,
then `claude-haiku-4-5-20251001`. Anthropic endpoint precedence is nonblank
`AI_BASE_URL`, then `ANTHROPIC_API_URL`, then the native default. Empty or
whitespace-only new settings fall through. Legacy settings still work:

```dotenv
ANTHROPIC_API_KEY=sk-ant-example
CLAUDE_MODEL=legacy-model
ANTHROPIC_API_URL=https://proxy.example.com
```

`ANTHROPIC_API_URL` retains API-root semantics: trailing slashes are removed and
`/v1/messages` is used. In contrast, `AI_BASE_URL` is the adapter API base,
including the version path: Anthropic and OpenAI commonly need `/v1`, Google
needs `/v1beta`. Dewey appends only the adapter's operation path to this new
setting, so do not include `/messages` or `/chat/completions` itself. Custom
path prefixes are preserved. Unsupported providers, missing required models, and
invalid/missing required bases are configuration errors before network access.

Startup probes the selected model once with a ten-second deadline. Failure is
advisory and later normalization remains eligible. Normalization prioritizes
embedded tags, accepts plain or fenced JSON with nonblank string author/title,
and retains heuristic fallback and path sanitization. Each normalization has at
most three attempts, fifteen seconds per attempt, with 2s/4s backoff for network
errors, timeouts, HTTP 408/429 and 5xx. Authentication failures, refusals and
invalid content do not retry. SDK retries are disabled. A process-local rolling
minute budget allows 45 normalization attempts per provider/endpoint/credential
configuration; retries count, and concurrent callers wait for capacity. Logs show
safe provider/model/status summaries without raw provider errors or credentials.

SDK dependencies are pinned together and verified on Bun 1.3.0. Provider creation
uses explicit model objects, including OpenAI chat models and compatible chat
models. See the [official provider documentation](https://ai-sdk.dev/providers/ai-sdk-providers)
and [compatible adapter documentation](https://ai-sdk.dev/providers/openai-compatible-providers)
for the transport APIs; installed package sources define the pinned versions.
