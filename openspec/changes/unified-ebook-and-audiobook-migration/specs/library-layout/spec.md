## Purpose

Map a resolved book and its files to destination paths through a configurable organization strategy, so Dewey can produce Audiobookshelf- or Book Orbit-friendly libraries without changing extraction or matching.

## ADDED Requirements

### Requirement: Layout strategy selection
The system SHALL accept `LIBRARY_LAYOUT` values `audiobookshelf` and `bookorbit`, compared case-insensitively. It SHALL default to `audiobookshelf` when the value is unset or blank. Any other value SHALL fail configuration validation at startup with a message naming `LIBRARY_LAYOUT`.

#### Scenario: Unset layout
- **WHEN** `LIBRARY_LAYOUT` is not set
- **THEN** the `audiobookshelf` strategy is used

#### Scenario: Invalid layout
- **WHEN** `LIBRARY_LAYOUT=calibre`
- **THEN** startup fails configuration validation naming `LIBRARY_LAYOUT`

### Requirement: Book folder placement
Both strategies SHALL place every file of a book directly in one book folder, `DEST_DIR/[Author]/[Title]/`, without nested format subfolders. They SHALL use the existing filesystem sanitization for new folder names. A unit matched to an existing book SHALL use that book's existing folder unchanged.

#### Scenario: All formats share one folder
- **WHEN** a book has `Dune.m4b`, an EPUB, and a read-aloud EPUB
- **THEN** all three files are direct children of `DEST_DIR/Frank Herbert/Dune/`

### Requirement: Audiobookshelf file naming
The `audiobookshelf` strategy SHALL keep the original filename of every file, audio and ebook alike, with one exception. A read-aloud EPUB whose original name would equal the name of a non-read-aloud EPUB in the same book folder SHALL have ` (readaloud)` inserted before its extension.

#### Scenario: Original names kept
- **WHEN** `dune_herbert_retail.epub` is placed under the `audiobookshelf` layout
- **THEN** the destination file is named `dune_herbert_retail.epub`

#### Scenario: Read-aloud EPUB shares the original's name
- **WHEN** the book folder holds `Dune.epub` and a read-aloud EPUB also named `Dune.epub` arrives under the `audiobookshelf` layout
- **THEN** it is placed as `Dune (readaloud).epub` and the original is unchanged

### Requirement: Book Orbit file naming
The `bookorbit` strategy SHALL keep original filenames for audio files. It SHALL name a non-read-aloud EPUB `<Title>.epub` and a read-aloud EPUB `<Title> (readaloud).epub`, where `<Title>` is the book folder's title segment.

#### Scenario: Canonical ebook names
- **WHEN** `dune_herbert_retail.epub` and a read-aloud EPUB of it are placed in `Frank Herbert/Dune/` under the `bookorbit` layout
- **THEN** they are named `Dune.epub` and `Dune (readaloud).epub`, and the audio filenames are unchanged

### Requirement: Layout independence
The selected layout SHALL affect only destination folder and file names. It SHALL NOT change metadata extraction, normalization, or match decisions. Changing the layout SHALL NOT move or rename files already in the library.

#### Scenario: Layout switched on an existing library
- **WHEN** an operator changes `LIBRARY_LAYOUT` from `audiobookshelf` to `bookorbit`
- **THEN** existing library files keep their names and only newly placed ebooks receive canonical names
