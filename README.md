## Dewey Audiobook Migrator

Node-based containerized watcher that organizes incoming audiobook files into a canonical library structure using Claude AI for intelligent author/title normalization.

### Features
- **Smart Directory Watching**: Monitors source directory with configurable stability timeout to ensure complete uploads
- **AI-Powered Normalization**: Uses Claude AI to intelligently parse and normalize author/title from filenames
- **Multiple File Formats**: Supports `.mp3` and `.m4b` audiobook files  
- **Flexible Structure**: Handles both single files and multi-file directories
- **Robust Processing**: Prevents race conditions with directory stability checks and processing locks
- **Automatic Organization**: Creates clean `[Author]/[Book Title]` library structure
- **Smart Fallbacks**: Falls back to heuristic parsing when Claude API is unavailable
- **Comprehensive Logging**: Detailed logging to console and persistent log file with configurable levels
- **File Permissions**: Configurable ownership (PUID/PGID) and permissions for migrated content
- **Rate Limiting**: Built-in Claude API rate limiting with exponential backoff retry logic

### Quick Start
```bash
docker run -d --name dewey \
  -e ANTHROPIC_API_KEY=sk-ant-xxxx \
  -v your/path/to/incoming:/data/incoming \
  -v your/path/to/library:/data/library \
  -v your/path/to/logs:/data/logs \
  ghcr.io/masonfox/dewey:latest
```

### Local Development

```bash
# Install dependencies
yarn install

# Set environment variables
cp .env.example .env

# Run the application
yarn start

# Run tests
yarn test
```

Drop `.mp3`/`.m4b` files or directories into the `incoming/` directory. Dewey will automatically detect and migrate them to your organized library.

### GitHub Container Registry (GHCR)
This repository automatically publishes Docker images to GitHub Container Registry on pushes to `main`/`master` branches.

**Published Image**: `ghcr.io/masonfox/dewey:latest`

The workflow builds and publishes when changes are made to:
- `Dockerfile`
- `src/**` (source code)
- `package.json` (dependencies)
- `.github/workflows/publish.yml` (CI configuration)

Ensure your repository has Actions permissions set to `Read and write packages` in Settings → Actions → General.

### How It Works

1. **Directory Monitoring**: `chokidar` watches the source directory for file/folder additions and changes
2. **Stability Checking**: New items are queued and checked for stability (no recent modifications) before processing
3. **Smart Grouping**: 
   - Multi-file directories are processed as single units
   - Single files are handled individually or grouped with their parent directory
   - Processing locks prevent race conditions
4. **Metadata Extraction**: 
   - Claude AI analyzes filenames to extract normalized author and title
   - Falls back to heuristic parsing if Claude is unavailable
   - Rate limiting prevents API quota exhaustion
5. **Library Organization**: Files are moved to `DEST_DIR/[Author]/[Title]/` structure
6. **Cleanup**: Source files/directories are removed after successful migration
7. **Logging**: All operations logged to console and persistent log file

### Technical Details

#### Directory Stability
- Configurable timeout (default 5s) ensures complete uploads before processing
- Prevents partial file processing during slow network transfers
- Multiple stability checks on both directory and file modification times

#### AI Integration
- Claude API validation on startup with graceful fallback
- Built-in rate limiting (45 requests/minute with buffer)
- Exponential backoff retry logic for transient failures
- Structured JSON parsing with validation

#### Error Handling
- Comprehensive error logging with context
- Graceful degradation when Claude API is unavailable
- Automatic cleanup of partial migrations on failure
- Non-fatal validation errors with detailed reporting

### Notes
- **Fallback Behavior**: If Claude API fails, uses filename-based heuristics for author/title extraction
- **Idempotent Operations**: Existing library structure is respected; duplicates are handled intelligently  
- **File Preservation**: Original file extensions and quality are maintained during migration
- **Resource Efficiency**: Intelligent batching and deduplication minimize unnecessary processing


