## Purpose

Discover, group, and describe incoming audiobook and EPUB files as migration units through one format-agnostic pipeline, preserving existing audiobook behavior.

## ADDED Requirements

### Requirement: Supported book formats
The system SHALL treat files ending in `.mp3`, `.m4b`, or `.m4a` as audio and files ending in `.epub` as ebooks, matching extensions case-insensitively. Ebook ingestion SHALL be enabled by default. When `INGEST_EBOOKS` is `false`, `.epub` files SHALL be treated as unsupported, as they were before this change. Other file types SHALL NOT, by themselves, make a file or directory a migration unit.

#### Scenario: EPUB dropped into the source directory
- **WHEN** `Dune.epub` is added directly to `SOURCE_DIR` with default configuration
- **THEN** it is enqueued as a single-file migration unit

#### Scenario: Ebook ingestion disabled
- **WHEN** `INGEST_EBOOKS=false` and `Dune.epub` is added to `SOURCE_DIR`
- **THEN** the file is not migrated and remains in place

### Requirement: Format-agnostic migration units
A loose supported file directly in `SOURCE_DIR` SHALL be a single-file unit. A directory below `SOURCE_DIR` that directly contains at least one supported file SHALL be one directory unit. All of its direct supported files, of any mix of formats, SHALL migrate together. Directories without direct supported files SHALL be traversed to find nested units and SHALL NOT be units themselves. Every unit SHALL use the existing stability checks, job states, and retry limits, whatever its formats.

#### Scenario: Mixed-format directory
- **WHEN** a directory `Dune/` containing `Dune.m4b` and `Dune.epub` becomes stable
- **THEN** a single directory unit migrates both files to the same book

#### Scenario: Multi-file audiobook unchanged
- **WHEN** a directory of numbered `.mp3` tracks is ingested
- **THEN** it is processed as one directory unit, as before this change

#### Scenario: Author folder with nested books
- **WHEN** `Frank Herbert/` contains subdirectories `Dune/` and `Children of Dune/`, each with supported files, and no direct supported files
- **THEN** each subdirectory is its own unit and `Frank Herbert/` is not a unit

### Requirement: EPUB metadata extraction
For each EPUB, the system SHALL read the OPF package document referenced by the container manifest. It SHALL extract the title, the primary author (the first creator with an author role, or the first creator when no roles are present), the language, and identifiers. ISBN-10 values SHALL be normalized to ISBN-13. ASINs and other identifiers SHALL be retained with their scheme. An EPUB whose archive or OPF cannot be read SHALL be migrated using filename heuristics and SHALL NOT fail for that reason alone.

#### Scenario: Well-formed OPF
- **WHEN** an EPUB's OPF declares title "Dune", creator "Frank Herbert" with role `aut`, and identifier `urn:isbn:0441013597`
- **THEN** its embedded metadata is author "Frank Herbert", title "Dune", identifier ISBN `9780441013593`

#### Scenario: Corrupt EPUB archive
- **WHEN** an `.epub` file is not a readable ZIP archive
- **THEN** a warning is logged and migration continues using heuristics

### Requirement: Read-aloud EPUB recognition
An EPUB whose OPF manifest declares media overlays SHALL be classified as a read-aloud variant. A read-aloud EPUB and a non-read-aloud EPUB of the same book SHALL be able to coexist in the same book folder. Neither SHALL be treated as a duplicate or conflicting version of the other.

#### Scenario: Storyteller output alongside original
- **WHEN** a book folder contains `Dune.epub` and a read-aloud EPUB of Dune arrives
- **THEN** the read-aloud EPUB is added to that book folder and the original EPUB is unchanged

### Requirement: Unit metadata source precedence
When a unit contains several files with embedded metadata, the system SHALL choose author/title metadata from the first available source in this order: `.m4b`, non-read-aloud EPUB, `.mp3`/`.m4a`, read-aloud EPUB. Identifiers SHALL be collected from every EPUB and `.m4b` file in the unit and from one representative `.mp3`/`.m4a` track, since tracks of one recording share tags.

#### Scenario: Audio and EPUB disagree on capitalization
- **WHEN** a directory unit contains `Dune.m4b` tagged "DUNE" and `Dune.epub` whose OPF says "Dune"
- **THEN** the `.m4b` tags are the primary embedded metadata and the EPUB's identifiers are still available for matching

### Requirement: Audiobook-only regression compatibility
With default configuration, an audio-only unit SHALL be migrated to the same destination folder and filenames it would have received before this change, as long as no destination conflict exists.

#### Scenario: Existing deployment upgrades
- **WHEN** an operator upgrades without changing configuration and ingests a single `.m4b`
- **THEN** it is placed at `DEST_DIR/[Author]/[Title]/<original filename>` and the source is removed
