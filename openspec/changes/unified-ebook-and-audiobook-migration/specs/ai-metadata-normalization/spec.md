## MODIFIED Requirements

### Requirement: Consistent normalization inputs and results
The system SHALL use the configured provider to normalize every migration unit: loose audio files, audiobook directories, loose EPUB files, and directories containing EPUBs alone or mixed with audio. Each request SHALL include:
- the filename or directory name
- the unit's formats
- available parent-directory context
- available embedded metadata from audio tags or the EPUB OPF package, described as the primary source

Accepted results SHALL contain nonblank string `author` and `title` fields. Existing filesystem sanitization SHALL still apply before creating paths.

#### Scenario: Normalize a file or directory
- **WHEN** any migration unit type has AI configured and the provider returns valid author/title JSON
- **THEN** the migration uses that metadata for its canonical author/title directory layout

#### Scenario: Embedded tags are available
- **WHEN** normalization receives embedded metadata
- **THEN** the request includes the available title, author, year, and genre and prioritizes those tags

#### Scenario: EPUB package metadata is available
- **WHEN** normalization runs for an EPUB whose OPF declares a title, creator, and language
- **THEN** the request includes them as embedded metadata and identifies the unit as an ebook

#### Scenario: Invalid response
- **WHEN** a response contains malformed JSON, missing fields, blank strings, or non-string author/title values
- **THEN** the result is rejected and the migration uses its existing heuristic fallback
