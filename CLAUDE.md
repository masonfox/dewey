# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dewey is a book migration service that watches a source directory for incoming audiobooks (.mp3, .m4b, .m4a) and EPUB ebooks (.epub, including read-aloud EPUBs with media overlays) and organizes them into a canonical library using embedded metadata and optional AI normalization. Every format of a book lands flat in one `[Author]/[Book Title]` folder; incoming units are matched against books already in the library, and uncertain or conflicting units are quarantined instead of written. Heuristics are the fallback when AI is unavailable.

## Development Commands

### Running the Application
```bash
# Install dependencies
bun install

# Start the watcher (development/production)
bun start

# Alternative (direct Node execution)
node src/index.js
```

### Testing
```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test __tests__/jobQueue.test.js

# Run tests matching a pattern
npm test -t "should migrate file job"
```

### Docker
```bash
# Build container
docker build -t dewey .

# Run container with required volumes
docker run -d \
  -e ANTHROPIC_API_KEY=sk-ant-xxxx \
  -v /path/to/incoming:/data/incoming \
  -v /path/to/library:/data/library \
  -v /path/to/logs:/data/logs \
  dewey
```

## Architecture Overview

### Core Components

**Entry Point (src/index.js)**
- Initializes the application and watcher
- Sets up `chokidar` file watcher on SOURCE_DIR with stability checks, ignoring REVIEW_DIR
- Sweeps stale `.dewey-partial-*` staging files from DEST_DIR at startup
- Starts HTTP health check server on localhost:8080
- Delegates all file events to the JobQueue

**Job System (src/job.js, src/jobQueue.js)**
- **Job**: Represents a single migration unit (file or directory) with state tracking
  - States: PENDING → WAITING_STABILITY → PROCESSING → COMPLETED/FAILED/CANCELLED
  - Each job has a unique ID generated from the source path
  - Jobs track retry counts, stability checks, and lifecycle timestamps
- **JobQueue**: Central orchestrator that manages the job lifecycle
  - Handles enqueueing, batching, and processing jobs
  - Prevents race conditions with directory grouping logic
  - Implements stability checking to ensure complete uploads
  - Groups related files (multi-file audiobooks, mixed audio + EPUB folders) into single directory jobs
  - Processes jobs serially; cross-format matching depends on this
  - Automatically discovers migration units for root directory scans

**Migration Logic (src/migrate.js)**
- Core function: `migrateJob(job, log)` - processes Job objects (file and directory jobs share one path)
- Three stages:
  - `buildUnit(job, log)` describes the source as a unit: supported files (`kind`, `readaloud`, `size`, per-file metadata), formats, and normalized author/title
  - `planUnit(unit, log)` matches against the library, picks the book folder (an existing folder's names win), names files via the layout, and classifies each destination as `copy`, `skip-identical` (size + SHA-256), or a conflict. It reads but never writes. Returns `{ outcome: 'place'|'quarantine', bookDir, match, actions, conflicts, reason, explanation, paths }`
  - `executePlan(plan, { dryRun, log })` performs or only logs the plan
- Transfer: copy to `.dewey-partial-<jobId>-<name>` with `COPYFILE_EXCL`, verify size, no-clobber rename; sources removed only after every action succeeds
- Any conflict or ambiguity quarantines the whole unit: `fs.move` to `REVIEW_DIR/<timestamp>-<name>/` plus `dewey-review.json` (`reason`, `explanation`, `paths`, `timestamp`); the job completes with `result.outcome === 'quarantined'` and is not retried
- `sweepStalePartials(log)` removes leftover `.dewey-partial-*` files at startup
- `DRY_RUN` logs every action with a `🧪 [dry-run]` marker and mutates nothing (including chown/chmod and quarantine)
- Uses `SkipError` for non-error skips (distinguishes from actual failures)

**Matching (src/matching.js)**
- `authorKey`/`titleKey` normalize names (case, diacritics, punctuation, "Last, First", leading article, `TITLE_NOISE_WORDS`)
- `findCandidates(unit, log)` reads `DEST_DIR` fresh per unit: same-author-key author folders, then book folders with supported files; OPF/audio-tag details load only for equal or near titles
- `resolveMatch(unit, candidates, log)`: identifier (ISBN/ASIN) → equal keys → near match + `resolveMatchViaAI` → new book, else `ambiguous` (several equal candidates, abridged mismatch, differing languages, differing non-read-aloud EPUB ISBNs, unconfirmed near match). Logs exactly one `info` decision line
- Never imports layout. No cache or index: correctness relies on the queue processing one job at a time

**Layout (src/layout.js)**
- Pure strategies `audiobookshelf` (original names; ` (readaloud)` suffix only when a read-aloud EPUB collides with the original) and `bookorbit` (`<Title>.epub`, `<Title> (readaloud).epub`; audio unchanged)
- `getLayout()` resolves `LIBRARY_LAYOUT()`. Layout only names folders/files; it never affects matching

**Metadata (src/metadata.js)**
- `extractAudioMetadata`: ffprobe format tags, read case-insensitively, including `isbn`, `asin`, `language`
- `extractEpubMetadata`: reads only `META-INF/container.xml` and the OPF from the ZIP (`yauzl` + `fast-xml-parser`, entry-size cap): title, author-role creator, language, identifiers (ISBN-10 → 13, ASIN, other), `readaloud` from media overlays. Unreadable EPUBs warn and return null
- `extractUnitMetadata(files, log)`: primary author/title from .m4b → EPUB → .mp3/.m4a → read-aloud EPUB, plus merged identifiers/language; `extractDirectoryMetadata` wraps it

**AI Integration (src/ai.js; src/claude.js is a legacy re-export)**
- `normalizeViaAI(name, fallbackAuthor, fallbackTitle, log, parentDir, fileMetadata, formats)`; prompts are format-aware (ebook/audio, OPF metadata)
- `resolveMatchViaAI(unit, candidates, log)` accepts only a high-confidence, same-edition single candidate; a high-confidence `null` means a new book; anything else is ambiguous. Shares the normalization pacing/retry budget
- Extracts author and title from filenames using Claude API
- Built-in rate limiting: 45 requests/min with automatic backoff
- Exponential retry logic for transient failures
- Returns structured JSON: `{ author: string, title: string }`
- Gracefully degrades to heuristics when API unavailable

**Configuration (src/config.js)**
- All config values exported as getter functions (not constants)
- This pattern enables dynamic runtime changes, critical for testing
- Key configs: SOURCE_DIR, DEST_DIR, ANTHROPIC_API_KEY, DIRECTORY_STABILITY_TIMEOUT, LIBRARY_LAYOUT, REVIEW_DIR, DRY_RUN, INGEST_EBOOKS

**Utilities (src/utils.js)**
- `isAudio(filename)`: Checks for .mp3, .m4b, or .m4a extensions
- `isEbook`, `isSupportedBook`, `bookFileKind` ('audio'|'epub'|null): format gating; `.epub` is unsupported when `INGEST_EBOOKS=false`
- `isWithinReviewDir(p)`: shared ignore predicate for the watcher, discovery, and queue grouping
- `heuristicsFromName(filename, parentDir)`: Fallback parsing for author/title
- `sanitizeSegment(str)`: Cleans filenames for filesystem safety

### Processing Flow

1. **File Detection**: Chokidar emits events (add/change/addDir) → enqueued to JobQueue
2. **Smart Grouping**: JobQueue analyzes files to determine if they should be:
   - Processed individually (single files)
   - Grouped as directory (multi-file audiobooks)
   - Skipped (nested structures that will be handled by children)
3. **Stability Checks**: Directory jobs wait for DIRECTORY_STABILITY_TIMEOUT to ensure complete uploads
4. **Metadata Extraction**: audio tags / EPUB OPF + AI normalization → author/title, with fallback to heuristics
5. **Matching**: identifier → deterministic keys → near match + AI → new book or ambiguous
6. **Planning**: every destination classified as copy, skip-identical, or conflict before any write
7. **Execution**: staged copy + rename into `DEST_DIR/[Author]/[Title]/` with configured permissions, or quarantine to `REVIEW_DIR` (dry-run only logs)
8. **Cleanup**: Source files removed after the whole unit succeeds

### Key Behaviors

**Directory Stability**: Before processing directories, the system ensures no files have been modified within DIRECTORY_STABILITY_TIMEOUT (default 5 seconds). This prevents partial migration during slow transfers.

**Job Lifecycle**: Jobs move through states with proper tracking:
- PENDING: Just created, awaiting processing
- WAITING_STABILITY: Directory waiting for stability timeout
- PROCESSING: Currently being migrated
- COMPLETED: Successfully migrated, skipped as identical, or quarantined (`result.outcome === 'quarantined'`)
- FAILED: Migration failed (tracks error)
- CANCELLED: Source deleted before processing

**Rate Limiting**: Claude API has 50 req/min limit. The system enforces 45 req/min with buffer and waits when limit reached.

**Retry Logic**: Jobs can retry up to 3 times on failure (configurable via job.maxRetries)

**Processing Locks**: JobQueue tracks `processingJobs` Set to prevent concurrent processing of the same job

## Configuration

All configuration is via environment variables (see .env.example). Key variables:
- `ANTHROPIC_API_KEY`: Required for Claude AI normalization
- `SOURCE_DIR`: Directory to watch (default: ./data/incoming)
- `DEST_DIR`: Library output directory (default: ./data/library)
- `DIRECTORY_STABILITY_TIMEOUT`: Milliseconds to wait for stability (default: 5000)
- `LOG_LEVEL`: trace, debug, info, warn, error (default: info)
- `LIBRARY_LAYOUT`: audiobookshelf or bookorbit (default: audiobookshelf)
- `REVIEW_DIR`: quarantine folder, must be outside DEST_DIR (default: SOURCE_DIR/.dewey-review)
- `DRY_RUN`: log planned actions without changing files (default: false)
- `INGEST_EBOOKS`: organize .epub files (default: true)

## Testing Patterns

Tests use Jest with ES modules support. Common patterns:
- Mock filesystem with `fs-extra` mocks
- Mock environment variables by modifying `process.env` before importing modules
- Use `beforeEach` to reset job queue state
- Test files located in `__tests__/` directory

Example test structure:
```javascript
import { Job, JobState } from '../src/job.js';

beforeEach(() => {
  // Reset state
});

test('should transition job states correctly', async () => {
  const job = new Job('/path/to/file.mp3');
  expect(job.state).toBe(JobState.PENDING);
  // ...
});
```

## Health Check

HTTP server runs on localhost:8080 with `/health` endpoint returning:
- Application readiness status
- Watcher status
- Last activity timestamp
- Recent errors (last 10)

Docker HEALTHCHECK uses `src/healthcheck.js` to verify the service.

## Common Gotchas

1. **Config Module Pattern**: Always use config getter functions (e.g., `SOURCE_DIR()`) not direct imports of constants. This ensures tests can modify environment variables dynamically.

2. **SkipError vs Error**: Use `SkipError` for non-error skips (e.g., non-audio files, duplicates). Regular `Error` indicates actual failures.

3. **Job IDs**: Jobs are identified by a short hash of the source path (first 6 chars of base64). The same source path always generates the same job ID.

4. **Directory vs File Jobs**: JobQueue intelligently determines whether to process items as files or directories based on content analysis. Don't manually specify unless you have a specific reason.

5. **Chokidar awaitWriteFinish**: The watcher uses `awaitWriteFinish` with stability threshold to prevent processing incomplete uploads. This is in addition to the JobQueue's own stability checks.

6. **Logging with Job Context**: Use `job.createLogger(baseLogger)` to get a logger that automatically prefixes messages with the job ID.

7. **Never overwrite library files**: New write paths must go through `planUnit`/`executePlan` so collisions quarantine instead of clobbering, and must honor `DRY_RUN()`.

8. **Serial queue is load-bearing**: Matching reads the library fresh per unit with no lock. Introducing concurrent job processing requires a per-author-key lock around plan + execute.
