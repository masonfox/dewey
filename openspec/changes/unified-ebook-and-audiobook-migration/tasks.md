## 1. Foundations: configuration, formats, dependencies

- [x] 1.1 Add `yauzl` and `fast-xml-parser` (pinned versions) to `package.json`, then run `bun install`; verify the lockfile updates and `npm test` still passes
- [x] 1.2 Add `LIBRARY_LAYOUT`, `REVIEW_DIR`, `DRY_RUN`, `INGEST_EBOOKS` getters to `src/config.js` and include them in `getConfig()`. Add `validateConfig()` checks for an invalid layout and for a `REVIEW_DIR` inside `DEST_DIR` (D9). Verify with new cases in `__tests__/config.test.js` covering defaults, case-insensitive layout values, invalid layout, and `REVIEW_DIR` inside `DEST_DIR`
- [x] 1.3 Add `isEbook`, `isSupportedBook`, and `bookFileKind` to `src/utils.js`, honoring `INGEST_EBOOKS`. Verify with `__tests__/utils.test.js` cases for `.epub`/`.EPUB`, audio extensions, unsupported files, and `INGEST_EBOOKS=false`

## 2. Metadata extraction

- [x] 2.1 Implement `extractEpubMetadata(path, log)` in `src/metadata.js` (D2): container.xml → OPF, title, author-role creator, language, ISBN (checksum-validated, 10→13)/ASIN/other identifiers, `readaloud` from media overlays, and an entry-size cap. Verify with tests that build small EPUB fixtures in a temp dir: well-formed, role via `<meta refines>`, no roles, media-overlay, missing OPF, and non-ZIP file (warns and returns null)
- [x] 2.2 Broaden `extractAudioMetadata` to request all format tags and read keys case-insensitively, adding `isbn`, `asin`, and `language` without changing existing returned fields (D3). Verify that existing `__tests__/metadata.test.js` passes unchanged, plus new mocked-ffprobe cases for `ASIN`/`AUDIBLE_ASIN`/`ISBN`
- [x] 2.3 Generalize `extractDirectoryMetadata` into `extractUnitMetadata(files, log)` with m4b → epub → mp3/m4a → readaloud precedence and merged identifiers/language (D10), keeping `extractDirectoryMetadata` as a wrapper. Verify with tests for audio-only (m4b-first unchanged), mixed m4b+epub, and epub-only units

## 3. Discovery and queue grouping

- [x] 3.1 Replace `isAudio` gating with `isSupportedBook` in `discoverMigrationUnits`. Skip `REVIEW_DIR` during traversal. Verify with `__tests__/migrate.test.js` discovery cases: loose epub, mixed directory, epub-only directory, author folder with nested books, and a review folder that is ignored
- [x] 3.2 Update `JobQueue` grouping helpers (`checkForParentDirectoryJob`, `shouldSkipParentDirectory`, `directoryContainsAudio` → supported-book equivalent) and ignore paths under `REVIEW_DIR`. Verify with `__tests__/jobQueue.test.js` cases where a loose `.epub` beside an `.m4b` in a subfolder yields one directory job
- [x] 3.3 Add a chokidar `ignored` predicate for `REVIEW_DIR` in `src/index.js` (D8). Verify with a unit test of the exported predicate showing that paths under `REVIEW_DIR` are ignored and sibling paths are not

## 4. Layout strategies

- [x] 4.1 Create `src/layout.js` with `audiobookshelf` and `bookorbit` strategies and `getLayout()` (D6), including the read-aloud collision suffix for `audiobookshelf`. Verify with a new `__tests__/layout.test.js` covering every scenario in `specs/library-layout/spec.md`

## 5. Cross-format matching

- [x] 5.1 Create `src/matching.js` with `authorKey`, `titleKey`, the exported noise-word list, abridged-marker detection, and near-match detection (D4). Verify with a new `__tests__/matching.test.js` table of key-normalization and near-match cases ("Herbert, Frank", diacritics, leading articles, "(Unabridged)", "[M4B]", subtitle prefix, small typos)
- [x] 5.2 Implement `findCandidates(unit)`: fresh on-demand `DEST_DIR` read, author-key filter, and lazy candidate detail loading (EPUB OPF, one audio file's tags, name markers). Verify with temp-dir library fixtures that show only same-author-key book folders containing supported files are returned
- [x] 5.3 Implement `resolveMatch(unit, candidates)` in the order identifier → exact keys → near → AI → new/ambiguous, with abridged, language, multiple-candidate, and differing-EPUB-ISBN ambiguity rules. Verify with tests covering every scenario in `specs/cross-format-matching/spec.md` (AI mocked)
- [x] 5.4 Add `resolveMatchViaAI` to `src/ai.js`, reusing pacing, deadline, retry, and refusal handling. Accept only a valid, high-confidence, same-edition single candidate (D5). Verify with `__tests__/ai.test.js` cases: accepted match, null match, medium confidence, out-of-range index, invalid JSON, refusal, unusable config (all non-accepted cases → ambiguous), and attempts counted toward the 45/min budget
- [x] 5.5 Make `buildPrompt` format-aware (ebook/audio label, OPF metadata section) while preserving the JSON output contract. Verify that existing prompt tests still pass, plus a new test asserting that an EPUB unit's prompt names the ebook format and OPF title/author/language
- [x] 5.6 Add the single `info` match-decision log line (outcome, folders, deciding signal) and verify its content in matching tests with a captured logger

## 6. Planning, execution, and safety

- [ ] 6.1 Refactor `migrateJobFile`/`migrateJobDirectory` into unit building + `planUnit` + `executePlan` (D1), with the existing `migrateJob`/`migratePath` signatures unchanged. Verify that all existing `__tests__/migrate.test.js`, `integration.test.js`, and `ai-migration.test.js` tests pass unchanged (audiobook regression)
- [ ] 6.2 Implement plan-time collision classification: `copy`, `skip-identical` (size + streaming SHA-256), and `conflict`. Any conflict makes the whole unit quarantine. Verify with tests: identical re-ingestion removes the source and leaves one library copy; a different same-named file leaves the library untouched; a partly new unit copies only new files
- [ ] 6.3 Implement the staged transfer (`.dewey-partial-*`, `COPYFILE_EXCL`, size verify, no-clobber rename) and source removal only after the whole unit succeeds, with partial-file cleanup on failure (D7). Verify with tests that inject a copy failure mid-unit (no partial files remain, sources intact) and simulate a crash after rename (reprocessing ends identical and removes sources)
- [ ] 6.4 Add the startup sweep that removes stale `.dewey-partial-*` files under `DEST_DIR`, wired into `src/index.js` startup. Verify with a test that seeds stale partial files and asserts they are removed while real files remain
- [ ] 6.5 Implement quarantine to `REVIEW_DIR` (structure-preserving move, unique folder suffix, `dewey-review.json` with reason, explanation, paths, and timestamp), with jobs completing as `outcome: 'quarantined'` and a `warn` log (D8). Verify with tests for ambiguous and conflict reasons, a name collision in `REVIEW_DIR`, and the job state not being `FAILED` or retried
- [ ] 6.6 Implement `DRY_RUN` in `executePlan` (log each planned action with a dry-run marker and perform zero mutations, including chown/chmod and quarantine). Verify with a test that snapshots `SOURCE_DIR`, `DEST_DIR`, and `REVIEW_DIR` trees before and after a mixed-format run and asserts they are identical, plus a log-content assertion
- [ ] 6.7 Apply layout file naming in plans and log per-file actions (copied / skipped identical / renamed by layout / conflicting) plus the destination. Verify with plan-level tests under both layouts

## 7. Acceptance and regression tests

- [ ] 7.1 Add an end-to-end test: `Dune.epub` ingested into a library containing `Frank Herbert/Dune/Dune.m4b` ends with both files in that folder (acceptance 1)
- [ ] 7.2 Add an order-independence test: EPUB-first and audiobook-first runs into empty libraries produce identical directory trees under both layouts (acceptance 2)
- [ ] 7.3 Add a simultaneous-arrival test: loose `Dune.epub` and `Dune.m4b` enqueued together through `JobQueue` produce one book folder. This pins the reliance on serial processing (D4)
- [ ] 7.4 Add a reprocessing idempotency test: ingesting the same files twice yields no duplicates and no overwrites (acceptance 5)
- [ ] 7.5 Add an ambiguity safety test: an ambiguous unit leaves `DEST_DIR` byte-for-byte unchanged and lands in `REVIEW_DIR` (acceptance 4)
- [ ] 7.6 Add a read-aloud coexistence test: the original and read-aloud EPUBs both end up in the book folder under both layouts, including the same-filename case
- [ ] 7.7 Run the full suite with `npm test` and confirm that all pre-existing audiobook tests pass without modification (acceptance 3)

## 8. Documentation and deployment

- [ ] 8.1 Update `.env.example` with `LIBRARY_LAYOUT`, `REVIEW_DIR`, `DRY_RUN`, and `INGEST_EBOOKS`, documented in the existing comment style. Verify by review against D9 defaults
- [ ] 8.2 Add the new variables to the Dockerfile `ENV` block (leaving `REVIEW_DIR` unset so it derives from `SOURCE_DIR`), then verify `docker build -t dewey .` succeeds
- [ ] 8.3 Update README: supported formats, layouts with example trees, matching rules, review quarantine, dry-run rollout recipe, and the overwrite→quarantine behavior change. Update CLAUDE.md's architecture notes for the plan/execute split and the new modules. Verify that README examples match the spec scenarios
- [ ] 8.4 Manually verify against a running Book Orbit instance (book_per_folder library) that a placed `Author/Title/` folder with audio, EPUB, and read-aloud EPUB appears as one book with multiple formats. Also check the ebook-only `<Title>.epub` + `<Title> (readaloud).epub` case flagged in design Risks, and record the result in the change folder (acceptance 6)
