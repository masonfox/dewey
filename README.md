## Dewey Audiobook Migrator

[![GHCR Package](https://img.shields.io/badge/ghcr-dewey-blue?logo=docker)](https://github.com/masonfox/dewey/pkgs/container/dewey)
[![codecov](https://codecov.io/gh/masonfox/dewey/graph/badge.svg?token=5CR300GF1F)](https://codecov.io/gh/masonfox/dewey)

Node-based containerized watcher that organizes incoming audiobook files into a canonical library structure using ffprobe and Claude AI for intelligent author/title normalization.

### Features
- **Smart Directory Watching**: Monitors source directory with configurable stability timeout to ensure complete uploads
- **ffprobe & AI-Powered Normalization**: Uses ffprobe and Claude AI to intelligently parse and normalize author/title from filenames
- **Multiple File Formats**: Supports `.mp3` and `.m4b` audiobook files
- **Flexible Structure**: Handles both single files and multi-file directories
- **Robust Processing**: Prevents race conditions with directory stability checks and processing locks
- **Automatic Organization**: Creates clean `[Author]/[Book Title]` library structure
- **Smart Fallbacks**: Falls back to heuristic parsing when Claude API is unavailable
- **Comprehensive Logging**: Detailed logging to console and persistent log file with configurable levels
- **File Permissions**: Configurable ownership (PUID/PGID) and permissions for migrated content
- **Rate Limiting**: Built-in Claude API rate limiting with exponential backoff retry logic

### Quick Start
**Docker Compose** (Recommended)
```
services:
  dewey:
    image: ghcr.io/masonfox/dewey:latest
    container_name: dewey
    environment:
      ANTHROPIC_API_KEY: sk-ant-xxxx
    volumes:
      - your/path/to/incoming:/data/incoming
      - your/path/to/library:/data/library
      - your/path/to/logs:/data/logs
    restart: unless-stopped
```

**Docker Run Script**
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
bun install

# Set environment variables
cp .env.example .env

# change these .env values to local paths:
SOURCE_DIR=./data/incoming
DEST_DIR=./data/library

# Run the application
bun start

# Run tests
bun test

# Run tests with full integration test coverage (requires API key)
ANTHROPIC_API_KEY=sk-ant-xxx bun test
```

**Note on Testing**: Integration tests requiring Claude API access will be automatically skipped if `ANTHROPIC_API_KEY` is not set. This allows the test suite to run in CI without API credentials while still providing comprehensive coverage for core functionality.

Drop `.mp3`/`.m4b` files or directories into the `incoming/` directory. Dewey will automatically detect and migrate them to your organized library.

Ensure your repository has Actions permissions set to `Read and write packages` in Settings → Actions → General.

### How It Works

1. **Directory Monitoring**: `chokidar` watches the source directory for file/folder additions and changes
2. **Stability Checking**: New items are queued and checked for stability (no recent modifications) before processing
3. **Smart Grouping**: 
   - Multi-file directories are processed as single units
   - Single files are handled individually or grouped with their parent directory
   - Processing locks prevent race conditions
4. **Metadata Extraction**:
   - Uses ffprobe to pull metadata from files/directories
   - Uses Claude to normalize this data for correctness and consistency
   - Falls back to heuristic parsing if Claude is unavailable
   - Rate limiting prevents API quota exhaustion
5. **Library Organization**: Files are moved to `DEST_DIR/[Author]/[Title]/` structure
6. **Cleanup**: Source files/directories are removed after successful migration
7. **Logging**: All operations logged to console and persistent log file