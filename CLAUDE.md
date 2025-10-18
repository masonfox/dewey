# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Dewey is an audiobook migration service that watches a source directory for incoming audiobook files (.mp3, .m4b) and automatically organizes them into a canonical library structure using Claude AI for intelligent metadata extraction. Files are organized into `[Author]/[Book Title]` directories with heuristic fallbacks when AI is unavailable.

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
bun test

# Run tests with Jest directly
NODE_OPTIONS='--experimental-vm-modules' jest

# Run specific test file
NODE_OPTIONS='--experimental-vm-modules' jest __tests__/jobQueue.test.js
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
- Sets up `chokidar` file watcher on SOURCE_DIR with stability checks
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
  - Groups related files (multi-file audiobooks) into single directory jobs
  - Automatically discovers migration units for root directory scans

**Migration Logic (src/migrate.js)**
- Core function: `migrateJob(job, log)` - processes Job objects
- Determines metadata via Claude AI or heuristic fallbacks
- Creates `DEST_DIR/[Author]/[Title]` structure
- Copies audio files and applies configured permissions (PUID/PGID)
- Removes source files after successful migration
- Uses `SkipError` for non-error skips (distinguishes from actual failures)

**Claude Integration (src/claude.js)**
- Function: `normalizeViaClaude(name, fallbackAuthor, fallbackTitle, log, parentDir)`
- Extracts author and title from filenames using Claude API
- Built-in rate limiting: 45 requests/min with automatic backoff
- Exponential retry logic for transient failures
- Returns structured JSON: `{ author: string, title: string }`
- Gracefully degrades to heuristics when API unavailable

**Configuration (src/config.js)**
- All config values exported as getter functions (not constants)
- This pattern enables dynamic runtime changes, critical for testing
- Key configs: SOURCE_DIR, DEST_DIR, ANTHROPIC_API_KEY, DIRECTORY_STABILITY_TIMEOUT

**Utilities (src/utils.js)**
- `isAudio(filename)`: Checks for .mp3 or .m4b extensions
- `heuristicsFromName(filename, parentDir)`: Fallback parsing for author/title
- `sanitizeSegment(str)`: Cleans filenames for filesystem safety

### Processing Flow

1. **File Detection**: Chokidar emits events (add/change/addDir) → enqueued to JobQueue
2. **Smart Grouping**: JobQueue analyzes files to determine if they should be:
   - Processed individually (single files)
   - Grouped as directory (multi-file audiobooks)
   - Skipped (nested structures that will be handled by children)
3. **Stability Checks**: Directory jobs wait for DIRECTORY_STABILITY_TIMEOUT to ensure complete uploads
4. **Metadata Extraction**: Claude AI analyzes filename → extracts author/title with fallback to heuristics
5. **Migration**: Files copied to `DEST_DIR/[Author]/[Title]/` with configured permissions
6. **Cleanup**: Source files removed after successful migration

### Key Behaviors

**Directory Stability**: Before processing directories, the system ensures no files have been modified within DIRECTORY_STABILITY_TIMEOUT (default 5 seconds). This prevents partial migration during slow transfers.

**Job Lifecycle**: Jobs move through states with proper tracking:
- PENDING: Just created, awaiting processing
- WAITING_STABILITY: Directory waiting for stability timeout
- PROCESSING: Currently being migrated
- COMPLETED: Successfully migrated
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
