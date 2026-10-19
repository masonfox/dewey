## Purpose

Guarantee that migrations never silently overwrite or destructively merge library content, are idempotent and recoverable after interruption, can be previewed with a dry run, and preserve uncertain inputs for manual resolution.

## ADDED Requirements

### Requirement: Whole-unit planning before writes
For each unit, the system SHALL compute and validate the complete set of destination paths before creating, copying, renaming, or deleting anything. A unit whose plan contains any conflict or ambiguity SHALL NOT write any of its files into the library.

#### Scenario: One conflicting file in a directory unit
- **WHEN** a three-file directory unit has one file whose destination already exists with different content
- **THEN** none of the three files is written to the library and the unit is quarantined

### Requirement: No silent overwrites
When a planned destination file already exists and its content differs from the incoming file, the system SHALL NOT overwrite it. It SHALL treat the unit as conflicting.

#### Scenario: Different file with the same name
- **WHEN** `Frank Herbert/Dune/Dune.epub` exists and a different `Dune.epub` targets that path
- **THEN** the existing file is unchanged and the incoming unit is quarantined with reason `conflict`

### Requirement: Idempotent re-ingestion
When a planned destination file already exists with identical size and content hash, the system SHALL NOT copy it again. It SHALL remove that source file once the identity is verified. A unit whose files are all identical or newly placed SHALL complete successfully. Reprocessing the same input SHALL NOT create duplicate files or folders.

#### Scenario: Same file ingested twice
- **WHEN** `Dune.m4b` is ingested, then an identical `Dune.m4b` is dropped into `SOURCE_DIR` again
- **THEN** the library still contains exactly one `Dune.m4b`, and the second source copy is removed

#### Scenario: Partly new unit
- **WHEN** a directory unit contains an identical copy of an existing library file plus a new EPUB
- **THEN** only the EPUB is copied, the unit completes, and the whole source directory is removed

### Requirement: Recoverable file transfer
Each file SHALL be copied to a temporary name in the destination folder, verified by size, and then renamed to its final name. Source files SHALL be removed only after every file in the unit is in place and verified. At startup, leftover temporary files in the library SHALL be removed. After an interruption at any point, reprocessing the unit SHALL reach the same final state without manual cleanup.

#### Scenario: Crash after copy, before source removal
- **WHEN** the process stops after a unit's files are renamed into place but before its sources are removed
- **THEN** on restart the unit is reprocessed, recognized as identical, and its sources are removed

#### Scenario: Crash mid-copy
- **WHEN** the process stops while a temporary file is partly written
- **THEN** startup removes the temporary file and the unit is migrated normally on reprocessing

### Requirement: Review quarantine
Ambiguous or conflicting units SHALL be moved to `REVIEW_DIR`. It defaults to `.dewey-review` inside `SOURCE_DIR`, and the watcher SHALL ignore it. Each quarantined unit SHALL get its own folder in `REVIEW_DIR` that preserves the unit's original relative structure. That folder SHALL contain a `dewey-review.json` file recording:
- the reason: `ambiguous` or `conflict`
- a human-readable explanation
- the candidate or conflicting library paths
- the timestamp

A suffix SHALL be appended when a quarantine folder name already exists. Quarantine SHALL NOT delete any file. Configuration validation SHALL reject a `REVIEW_DIR` inside `DEST_DIR`.

#### Scenario: Ambiguous unit quarantined
- **WHEN** a unit is classified ambiguous
- **THEN** its files are moved under `REVIEW_DIR` with a `dewey-review.json` explaining why, and nothing is written to the library

#### Scenario: Quarantined files are not reprocessed
- **WHEN** a unit has been moved into the default `REVIEW_DIR`
- **THEN** the watcher does not enqueue it again

#### Scenario: Review directory inside library
- **WHEN** `REVIEW_DIR` resolves to a path inside `DEST_DIR`
- **THEN** startup fails configuration validation naming `REVIEW_DIR`

### Requirement: Dry-run mode
When `DRY_RUN` is `true`, the system SHALL perform discovery, metadata extraction, normalization, and matching. It SHALL log every action it would take (create folder, copy, skip identical, remove source, quarantine) with a dry-run marker. It SHALL NOT create, copy, rename, chown, chmod, move, or delete anything in `SOURCE_DIR`, `DEST_DIR`, or `REVIEW_DIR`. Dry-run units SHALL finish as completed.

#### Scenario: Preview a mixed library
- **WHEN** `DRY_RUN=true` and `Dune.epub` is ingested next to an existing `Dune.m4b`
- **THEN** the logs show the planned copy into `Frank Herbert/Dune/` and the filesystem is unchanged

### Requirement: Organization decision logging
For each unit, the system SHALL log at `info` level:
- the chosen destination folder or quarantine path
- the per-file action: copied, skipped as identical, renamed by layout, or conflicting
- the final outcome

#### Scenario: Successful mixed migration logged
- **WHEN** a unit is placed in an existing book folder
- **THEN** the log lists each file's action and the destination folder
