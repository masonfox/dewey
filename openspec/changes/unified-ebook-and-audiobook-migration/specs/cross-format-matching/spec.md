## Purpose

Decide whether an incoming migration unit is the same book as a book already in the library or another in-flight unit, so all formats of one book share a single book folder, regardless of arrival order, without ever merging on an uncertain decision.

## ADDED Requirements

### Requirement: Match candidates
Before choosing a destination, the system SHALL compare each unit against the library as it currently exists on disk. Candidates SHALL be book folders at `DEST_DIR/[Author]/[Title]` that contain at least one supported file, under author folders whose normalized author key equals the unit's normalized author key. Library state SHALL be read fresh for every unit, so books placed by earlier units, or added to the library by other tools, are visible.

#### Scenario: Book already in library
- **WHEN** `DEST_DIR/Frank Herbert/Dune/Dune.m4b` exists and `Dune.epub` by Frank Herbert is ingested
- **THEN** the existing Dune folder is a match candidate

### Requirement: Identifier matching first
A shared ISBN or ASIN between a unit and exactly one candidate SHALL resolve the match to that candidate before any metadata comparison. Different identifiers across different formats SHALL NOT, on their own, prevent a match, because ebook and audiobook editions carry distinct identifiers. A non-read-aloud EPUB whose ISBN differs from the ISBN of a non-read-aloud EPUB already in the candidate book SHALL be treated as ambiguous.

#### Scenario: Read-aloud EPUB shares the original's ISBN
- **WHEN** a read-aloud EPUB carries the same ISBN as `Dune.epub` in the library
- **THEN** it matches that book by identifier

#### Scenario: Different ebook edition
- **WHEN** a non-read-aloud EPUB titled "Dune" with ISBN A arrives and the library book holds a non-read-aloud EPUB with ISBN B
- **THEN** the unit is ambiguous and is not placed in the library

### Requirement: Deterministic metadata matching
Without an identifier match, the system SHALL compare normalized keys. Author keys SHALL fold case, diacritics, punctuation, and whitespace, and SHALL reorder "Last, First" to "First Last". Title keys SHALL fold case, diacritics, punctuation, and whitespace, and SHALL drop a leading article and format or edition noise (for example "Unabridged", "Audiobook", "[M4B]", "Retail"). When exactly one candidate has equal author and title keys, it SHALL be the match. When no candidate is equal or near, the unit SHALL become a new book.

#### Scenario: Equal keys despite formatting differences
- **WHEN** the library has `Herbert, Frank / Dune (Unabridged)` normalized to the same keys as an incoming EPUB "Dune" by "Frank Herbert"
- **THEN** the EPUB matches that book deterministically without an AI request

#### Scenario: No related book
- **WHEN** no candidate shares the unit's author key or identifiers
- **THEN** the unit becomes a new book at its own normalized author/title folder

### Requirement: Conservative ambiguity handling
A unit SHALL be classified as ambiguous, and SHALL NOT be copied into the library, when any of the following holds:
- More than one candidate matches equally.
- One side is marked abridged and the other is not.
- Both sides have a known language and the languages differ.
- Only a near match exists (same author key, title keys related by a subtitle or a small edit distance) and AI resolution did not confirm exactly one candidate.

Ambiguous units SHALL be quarantined for manual resolution as defined by migration safety.

#### Scenario: Abridged audiobook
- **WHEN** an audiobook titled "Dune (Abridged)" arrives and the library book holds an unabridged EPUB of Dune
- **THEN** the unit is quarantined as ambiguous and the library is unchanged

#### Scenario: Translation
- **WHEN** an EPUB of Dune with language `de` arrives and the library book's EPUB has language `en`
- **THEN** the unit is quarantined as ambiguous

#### Scenario: Two equal candidates
- **WHEN** both `Frank Herbert/Dune` and `Frank Herbert/Dune 1` normalize to keys equal to the unit's
- **THEN** the unit is quarantined as ambiguous

### Requirement: Bounded AI-assisted resolution
AI resolution SHALL be attempted only for near matches, only when AI configuration is usable, and only after identifier and deterministic matching fail. The request SHALL include the unit's metadata and at most five candidates. It SHALL accept only a response naming exactly one listed candidate as the same work, edition-compatible, with high confidence. Every other outcome SHALL leave the unit ambiguous: no match, low confidence, an invalid response, refusal, timeout, or unavailable AI. These requests SHALL follow the same per-request attempt limits, deadlines, and pacing budget as metadata normalization.

#### Scenario: AI confirms a subtitle variant
- **WHEN** an audiobook "Dune: Deluxe Edition" near-matches the library book "Dune" and AI names that book with high confidence
- **THEN** the audiobook is placed in the existing Dune folder

#### Scenario: AI unavailable
- **WHEN** a near match exists and no AI provider is usable
- **THEN** the unit is quarantined as ambiguous

### Requirement: Ingestion-order independence
A matched unit SHALL be placed in the matched book's existing folder, keeping that folder's author and title names. Units that resolve to the same book SHALL be decided and placed one at a time, so units arriving together produce a single book folder. For formats whose normalized metadata agree, EPUB-first and audiobook-first ingestion SHALL produce the same directory structure.

#### Scenario: EPUB first, then audiobook
- **WHEN** `Dune.epub` is ingested into an empty library and `Dune.m4b` is ingested afterwards
- **THEN** the library contains one `Frank Herbert/Dune/` folder holding both files

#### Scenario: Audiobook first, then EPUB
- **WHEN** the same two files are ingested in reverse order into an empty library
- **THEN** the resulting directory structure is identical to the EPUB-first case

#### Scenario: Simultaneous arrival
- **WHEN** `Dune.epub` and `Dune.m4b` are added as separate loose files at the same time
- **THEN** exactly one book folder is created and both files are placed in it

### Requirement: Match decision logging
Each unit SHALL log one `info` line naming the match outcome. The outcome SHALL be one of identifier, deterministic, AI, new book, or ambiguous. The line SHALL include the matched or candidate book folders and the deciding signal (for example the shared identifier or the conflicting language). It SHALL NOT include credentials or raw AI response bodies.

#### Scenario: Deterministic match logged
- **WHEN** a unit matches a library book by normalized keys
- **THEN** the log states a deterministic match and names the destination book folder
