## Context

See proposal.md (Why) for motivation. The current pipeline is audio-specific at a handful of seams:

- `isAudio()` gates discovery (`discoverMigrationUnits`), queue grouping (`checkForParentDirectoryJob`, `shouldSkipParentDirectory`, `directoryContainsAudio`), and migration (`migrateJobFile`, `migrateJobDirectory`).
- `migrateJobFile` and `migrateJobDirectory` duplicate the same steps: resolve metadata, build `DEST_DIR/author/title`, copy, verify size, apply permissions, remove the source. Both call `copyFile`, which **overwrites** an existing target, and fall back to `fs.copy({ overwrite: true })`.
- `extractAudioMetadata` shells out to `ffprobe` with a fixed tag list. `buildPrompt` describes the task as audiobook-only.
- `JobQueue.processBatch` awaits jobs **one at a time**, so at most one migration runs at any moment.
- Config follows the getter-function pattern in `src/config.js` with `validateConfig()` collecting errors and warnings.

Book Orbit facts verified in its source (`server/src/modules/scanner/lib/walk.ts`):

- In the default `book_per_folder` mode, a folder whose primary files include audio is **one book containing every file in it**.
- Disc folders (`CD 1`) and subfolders named after a sibling file's stem are flattened into the parent book.
- Dotfiles are skipped.
- Read-aloud EPUBs are detected through EPUB media overlays, not filenames.

So a flat `Author/Title/{audio, epub, readaloud epub}` folder is the simplest shape that Book Orbit groups correctly, and Audiobookshelf still reads it as one item.

## Goals / Non-Goals

**Goals:**
- One unit pipeline for all formats: discover → describe → normalize → match → plan → execute (or quarantine), shared by file and directory jobs.
- Decisions are made from the filesystem alone. No persistent index or database; re-reading the library is the source of truth.
- Every write is preceded by a complete, validated plan. Every source removal follows verification.

**Non-Goals:**
- Reorganizing or renaming books already in the library (including when `LIBRARY_LAYOUT` changes).
- Ebook formats other than EPUB, and DRM handling.
- Merging two existing library folders that turn out to be the same book.
- Parallel job execution. The serial queue is relied on, not changed.

## Decisions

### D1. Split migration into `planUnit` and `executePlan`
`migrateJob` builds a `Unit` from either job type:

- `files[]`, each with `path`, `kind` (`audio` | `epub`), `readaloud`, `size`, and per-file metadata
- `displayName`, `parentDir`

`planUnit(unit)` returns a `Plan`: `{ outcome: 'place' | 'quarantine', bookDir, match, actions: [{ src, dest, op: 'copy' | 'skip-identical' }], reason }`. `executePlan(plan, { dryRun })` performs or logs the actions. This removes the file/directory duplication, makes dry-run a flag on the executor rather than a parallel path, and gives tests a pure-ish seam: a plan can be asserted without touching the destination.
*Alternative:* patch each of the two existing functions. Rejected: the collision, layout, and dry-run logic would have to be written twice.

### D2. EPUB reading with `yauzl` + `fast-xml-parser`
The reader opens the ZIP central directory, reads only `META-INF/container.xml` and the OPF entry (with an entry-size cap of a few MB), and parses them with `fast-xml-parser`. It extracts:

- `dc:title`, `dc:creator` (prefer `opf:role="aut"` or a refining `<meta property="role">aut`)
- `dc:language`
- `dc:identifier` values classified as ISBN (validated checksum, ISBN-10 → 13), ASIN, or other
- `readaloud = manifest.some(item => item['media-overlay'] || item['media-type'] === 'application/smil+xml')`

*Alternatives:* `adm-zip`/`JSZip` load the whole archive into memory, and read-aloud EPUBs embed audio and can be hundreds of MB. Shelling out to `unzip` adds an image dependency. Regex "XML parsing" was rejected because OPF namespace and prefix variation makes it brittle.

### D3. Audio tags: request all format tags
`ffprobe` is called with `-show_entries format_tags` (no field filter). Keys are read case-insensitively, adding `isbn`, `asin`/`audible_asin`, and `language` to the existing fields. The extra fields feed identifier matching and the language/abridged checks. Existing returned fields are unchanged, so current tests and prompts still hold.

### D4. Matching lives in `src/matching.js` and reads the library on demand
- `authorKey()` and `titleKey()` implement the normalization in the cross-format-matching spec. Title noise words are kept in a single exported list so tests pin them.
- Candidates come from `readdir(DEST_DIR)`, keeping author folders whose `authorKey` equals the unit's, then `readdir` of each such author folder for book folders containing supported files.
- Candidate details (EPUB OPF identifiers and language, audio tags of one file, abridged markers in folder or file names) are read **only for candidates** that are equal or near on title.
- Order: identifier → exact keys → near-match → AI → else new book / ambiguous.
- Near match means the same author key, and title keys where one is a word-boundary prefix of the other (subtitle) or their Levenshtein distance is ≤ 2 with both keys ≥ 6 characters.

No cache survives between units. Because `processBatch` is serial, a unit always sees the previous unit's placements; this is what makes simultaneous arrival produce one folder. (A test pins this. If concurrency is ever introduced, a per-author-key lock around plan+execute becomes required.)
*Alternative:* an in-memory or on-disk library index. Rejected per the issue's "avoid a database" note. Per-unit cost is two `readdir`s plus at most a few OPF/ffprobe reads.

### D5. AI resolution reuses `ai.js` plumbing
`resolveMatchViaAI(unit, candidates, log)` reuses `resolveAIConfig`, `reserveAttempt`, `request`, `failure`, and `refused`, with the same 3-attempt / 15 s / 45-per-minute budget. The prompt lists numbered candidates (folder name, title, author, language, formats) and requires `{"match": <number|null>, "sameEdition": boolean, "confidence": "high"|"medium"|"low"}`. Only `match ∈ candidates && sameEdition && confidence === 'high'` is accepted. `match === null && confidence === 'high'` is a confident "none of these" and makes the unit a new book, so sequels that prefix-match an existing title (e.g. "Dune Messiah" vs "Dune") don't quarantine. Every other response leaves the unit ambiguous. `buildPrompt` becomes format-aware ("book librarian", lists the unit's formats, labels EPUB package metadata) while keeping its output contract.

### D6. Layout strategies are pure functions in `src/layout.js`
Each strategy is `{ name, bookDir(destRoot, author, title), fileName(file, { title, existingNames }) }`. `audiobookshelf` returns the original name, plus the ` (readaloud)` suffix on collision. `bookorbit` returns `<Title>.epub` or `<Title> (readaloud).epub` for EPUBs and the original name for audio. `getLayout()` resolves from `LIBRARY_LAYOUT()`. Matching never imports layout, and layout never inspects metadata beyond the resolved title and file flags. That separation is what the "layout independence" requirement rests on.

### D7. Transfer protocol: stage → verify → rename → remove sources
For each `copy` action:

1. `ensureDir(bookDir)`.
2. Copy to `bookDir/.dewey-partial-<jobId>-<basename>` with `COPYFILE_EXCL`.
3. Verify the size.
4. `fs.rename` to the final name, after re-checking that the final name still doesn't exist (no clobber).

Sources are removed only after all actions succeed: files for file units, and the directory plus empty parents for directory units (existing behavior). On failure mid-unit, partial files are deleted and staged files already renamed are left. They are identical to their sources, so reprocessing resolves them as `skip-identical`.

Identity is size equality, then streaming SHA-256 of both files. Hashing runs only when sizes are equal.

Startup sweeps `DEST_DIR` (readdir walk, depth ≤ 3) for `.dewey-partial-*` and removes them. Dot-prefixed staging names are ignored by Book Orbit and Audiobookshelf scanners while in flight.
*Alternative:* copy directly to the final name. Rejected: a crash leaves a truncated file at the final path, which then looks like a conflict.

### D8. Quarantine via `REVIEW_DIR`
- `REVIEW_DIR()` defaults to `path.join(SOURCE_DIR(), '.dewey-review')`.
- Quarantine uses `fs.move` (rename on the same filesystem, copy+delete fallback) of the unit's source into `REVIEW_DIR/<timestamp>-<displayName>/…`, then writes `dewey-review.json`.
- Chokidar gets an `ignored` predicate for paths under `REVIEW_DIR`. `discoverMigrationUnits` and the queue's grouping helpers skip it too, as a second guard and for explicitly configured locations inside `SOURCE_DIR`.
- A quarantined unit finishes in the `COMPLETED` state with `job.result.outcome = 'quarantined'`, not `FAILED`, so it is not retried. The quarantine is logged at `warn` with the review path, so operators notice it in normal log monitoring.

### D9. Configuration additions
New getters in `src/config.js`, all validated in `validateConfig()`:

| Variable | Default | Values |
|---|---|---|
| `LIBRARY_LAYOUT` | `audiobookshelf` | `audiobookshelf` \| `bookorbit` |
| `REVIEW_DIR` | `SOURCE_DIR/.dewey-review` | must resolve outside `DEST_DIR` |
| `DRY_RUN` | `false` | `true` / `false` |
| `INGEST_EBOOKS` | `true` | `true` / `false` |

`isAudio` stays exported. A new `isEbook()`, `isSupportedBook()`, and `bookFileKind()` in `utils.js` replace gating call sites, so `INGEST_EBOOKS=false` collapses `isSupportedBook` to `isAudio`.

### D10. Unit metadata precedence
`extractDirectoryMetadata` generalizes to `extractUnitMetadata(files)`. It returns the primary author/title source in the spec's order (m4b → epub → mp3/m4a → readaloud epub) plus a merged `identifiers` set and `language`. Audio-only directories therefore still pick the `.m4b`-first source as today.

## Risks / Trade-offs

- **[Behavior change for existing users]** EPUBs in `SOURCE_DIR` are now migrated, and directory units that previously copied only audio now also copy EPUBs. → Documented, with `INGEST_EBOOKS=false` as the escape hatch.
- **[Overwrite → quarantine]** A workflow that relied on re-dropping a corrected file to replace a library file will now quarantine. → This is the requested safety behavior. Release notes call it out, and the review JSON names the conflicting library path.
- **[Over-quarantining]** Near-matches without AI, or abridged/language markers, divert files to review. → This is the intended conservative trade-off; it is reviewable and nothing is lost. The noise-word list is easy to extend.
- **[Order independence limits]** If EPUB and audio metadata normalize to *different* author keys (e.g. "Frank Herbert" vs "Brian Herbert & Kevin J. Anderson"), they become separate books in either order, but folder names may differ by arrival order when titles only near-match and AI confirms. → Existing folder names always win, so the result is stable once placed; acceptance tests cover the equal-metadata case.
- **[Book Orbit ebook-only folders]** Book Orbit's scanner comment suggests an ebook-only folder whose EPUBs have *different stems* may split into one book per stem. `Dune.epub` + `Dune (readaloud).epub` without audio might show as two books, though the same file also states "one folder = one book". → Read-aloud EPUBs are normally generated from an existing audiobook, so audio is usually present. A manual verification task against a running Book Orbit instance covers this case.
- **[Library scan cost]** Matching reads `DEST_DIR` per unit. → Two `readdir`s plus candidate-only detail reads. That is acceptable at the serial queue's throughput and far cheaper than the AI call already made per unit.
- **[Large EPUBs]** Read-aloud EPUBs can be large. → Only the central directory and the OPF entry are read, and hashing happens only when sizes match.

## Migration Plan

1. Ship behind defaults that preserve audiobook paths (`LIBRARY_LAYOUT=audiobookshelf`, `DRY_RUN=false`).
2. Recommended rollout for Book Orbit users: set `LIBRARY_LAYOUT=bookorbit DRY_RUN=true`, inspect the logs, then disable dry-run.
3. Docker: no new volume is required, because the default `REVIEW_DIR` lives inside the already-mounted `SOURCE_DIR`. Document an optional dedicated mount.
4. Rollback: redeploy the previous image. Library contents remain valid for both versions. Anything in `REVIEW_DIR` is plain files the operator can move back into `SOURCE_DIR`.

## Open Questions

- Should the title noise-word list be operator-configurable? It can be added later without changing the specs or the approach.
