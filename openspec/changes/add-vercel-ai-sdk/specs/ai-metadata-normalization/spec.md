## Purpose

Provide consistent author and title normalization across supported AI providers while keeping audiobook migration available when AI fails.

## ADDED Requirements

### Requirement: Consistent normalization inputs and results
The system SHALL use the configured provider to normalize both loose files and audiobook directories. Requests SHALL include the filename or directory name, available parent-directory context, and available embedded metadata, describing embedded tags as the primary source. Accepted results SHALL contain nonblank string `author` and `title` fields. Existing filesystem sanitization SHALL still apply before creating paths.

#### Scenario: Normalize a file or directory
- **WHEN** either migration type has AI configured and the provider returns valid author/title JSON
- **THEN** the migration uses that metadata for its canonical author/title directory layout

#### Scenario: Embedded tags are available
- **WHEN** normalization receives embedded metadata
- **THEN** the request includes the available title, author, year, and genre and prioritizes those tags

#### Scenario: Invalid response
- **WHEN** a response contains malformed JSON, missing fields, blank strings, or non-string author/title values
- **THEN** the result is rejected and the migration uses its existing heuristic fallback

### Requirement: Optional AI startup check
Startup SHALL check the selected provider and model when AI configuration is usable. Missing credentials, authentication failures, refusals, timeouts, or provider unavailability SHALL NOT prevent the watcher and migrations from starting. The check SHALL have a ten-second deadline and no retries. Logs SHALL identify the selected provider and model without leaking secrets.

#### Scenario: Startup provider is unavailable
- **WHEN** the selected provider fails its startup request
- **THEN** startup logs a warning and the application continues
- **AND** subsequent normalization attempts remain eligible to use the configured provider

### Requirement: Bounded requests and retries
Each normalization SHALL make at most three provider attempts, each with a fifteen-second deadline. Rate-limit responses, request timeouts, connection failures, and server errors SHALL be eligible for bounded backoff retries. Authentication failures, refusals, and invalid generated content SHALL return fallback without retries. Automatic retries in nested layers SHALL NOT multiply this budget.

#### Scenario: Transient error recovers
- **WHEN** a retryable error is followed by a valid response within three attempts
- **THEN** normalization returns the valid author/title result

#### Scenario: Attempts exhausted
- **WHEN** all three attempts fail
- **THEN** normalization returns control to migration for heuristic fallback

### Requirement: Graceful fallback and request pacing
AI failures SHALL preserve the existing heuristic metadata and file migration behavior, without switching providers automatically. Normalization requests SHALL retain conservative pacing of at most 45 attempts in a rolling minute per selected provider, endpoint, and credential configuration; retries SHALL count toward this limit. Logs SHALL describe fallback without exposing credentials, authorization headers, raw provider response bodies, or authenticated URL components.

#### Scenario: Provider refusal or authentication failure
- **WHEN** the configured provider refuses a request or rejects credentials
- **THEN** migration completes using its existing fallback and no other provider is contacted

#### Scenario: Request budget reached
- **WHEN** 45 attempts have occurred in the current rolling minute for one configuration
- **THEN** the next attempt waits until capacity is available
