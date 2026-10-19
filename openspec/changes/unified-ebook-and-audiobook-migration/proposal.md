## Why

Dewey only organizes audiobooks, so ebooks live in a separate library even though Book Orbit can present an EPUB and an audiobook as one logical book (and, with Storyteller, as a synchronized read-along). Extending Dewey's existing discovery, normalization, and organization pipeline to EPUBs gives one ingestion path for all book formats. It also lets an EPUB and an audiobook of the same work land in the same book folder, whichever arrives first. ([#14](https://github.com/masonfox/dewey/issues/14))

## What Changes

- Ingest `.epub` files alongside `.mp3`/`.m4b`/`.m4a` through the same watcher, stability checks, job queue, and retry mechanisms. Single EPUBs, EPUB directories, and mixed audio+EPUB directories are all migration units.
- Extract EPUB metadata from the OPF package document: title, creators, language, identifiers (ISBN/ASIN/UUID), and the presence of media overlays. Use it as embedded metadata in normalization, exactly as audio tags are used today.
- Recognize Storyteller-style read-aloud EPUBs (EPUBs with media overlays) as a distinct format variant that coexists with the original EPUB in the same book.
- Before creating a book folder, match each incoming unit against books already in `DEST_DIR` and against other in-flight units. Matching tries shared identifiers first, then deterministic normalized author/title keys, and only then, for near-misses, AI-assisted resolution. It is conservative about editions, translations, and abridgments.
- Introduce `LIBRARY_LAYOUT` with strategies `audiobookshelf` (default, preserves today's paths and filenames) and `bookorbit`. Both place every format of a book flat in `DEST_DIR/[Author]/[Title]/`. `bookorbit` additionally gives ebooks canonical names (`<Title>.epub`, `<Title> (readaloud).epub`).
- File safety:
  - **BREAKING (safety fix)**: an existing destination file with different content is no longer silently overwritten. The incoming unit is quarantined instead.
  - Byte-identical re-ingestion is a no-op that removes the source.
  - Copies are staged and renamed into place so an interrupted run is recoverable.
  - Ambiguous or conflicting units move to a new `REVIEW_DIR` (default `SOURCE_DIR/.dewey-review`, ignored by the watcher) with a JSON reason file.
  - New `DRY_RUN` mode logs every planned action without changing the filesystem.
  - Matching and placement decisions are logged at `info` with their reason.
- Update README, `.env.example`, and Dockerfile env defaults. Add tests for EPUB parsing, matching, collisions, ingestion order, dry-run, and audiobook regression behavior.

Out of scope (per the issue): Storyteller or Book Orbit API integration, read-aloud generation, position sync, UI, automated migration of existing libraries, and ebook formats other than EPUB. No database is introduced.

## Capabilities

### New Capabilities
- `book-ingestion`: Format-agnostic discovery and grouping of audiobook and EPUB migration units, EPUB/OPF metadata extraction, and read-aloud EPUB recognition, while preserving existing audiobook and multi-file behavior.
- `cross-format-matching`: Deciding whether an incoming unit is the same book as an existing library book or an in-flight unit, using identifiers, deterministic metadata keys, and bounded AI assistance, with conservative ambiguity handling and ingestion-order independence.
- `library-layout`: Configurable organization strategies (`audiobookshelf`, `bookorbit`) that map a resolved book and its files to destination paths, independently of extraction and matching.
- `migration-safety`: Dry-run mode, collision handling without silent overwrites, idempotent re-ingestion, recovery after interruption, the review quarantine, and decision logging.

### Modified Capabilities
- `ai-metadata-normalization`: Normalization inputs now cover EPUB units and OPF-derived embedded metadata, not only audio files and audiobook directories.

## Impact

- **Code**:
  - `src/utils.js` (format classification)
  - `src/metadata.js` (OPF extraction, read-aloud detection, audio identifier tags)
  - `src/migrate.js` (plan/execute split, matching, layout, collision handling, quarantine, dry-run)
  - `src/jobQueue.js` (supported-format grouping and per-book serialization)
  - `src/ai.js` (ebook-aware prompt, match-resolution request)
  - `src/config.js` (`LIBRARY_LAYOUT`, `REVIEW_DIR`, `DRY_RUN`, `INGEST_EBOOKS`)
  - `src/index.js` (watcher ignores the review area; startup cleanup of stale staging files)
  - New modules for matching and layout strategies.
- **Dependencies**: a small ZIP reader and XML parser are needed to read OPF from EPUB archives.
- **Behavior for existing users**:
  - With no configuration changes, audiobook paths and filenames are unchanged.
  - EPUBs dropped into `SOURCE_DIR`, previously ignored, are now organized. `INGEST_EBOOKS=false` restores the old behavior.
  - Destination conflicts now quarantine instead of overwriting.
- **Docs/ops**: README, `.env.example`, Dockerfile `ENV` defaults, and the volume guidance for `REVIEW_DIR`.
