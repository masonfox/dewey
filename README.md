## Dewey Audiobook Migrator

[![GHCR Package](https://img.shields.io/badge/ghcr-dewey-blue?logo=docker)](https://github.com/masonfox/dewey/pkgs/container/dewey)
[![codecov](https://codecov.io/gh/masonfox/dewey/graph/badge.svg?token=5CR300GF1F)](https://codecov.io/gh/masonfox/dewey)

Node-based containerized watcher that organizes incoming audiobook files into a canonical library structure using ffprobe and optional AI for intelligent author/title normalization.

### Features
- **Smart Directory Watching**: Monitors source directory with configurable stability timeout to ensure complete uploads
- **ffprobe & AI-Powered Normalization**: Uses ffprobe and optional AI to intelligently parse and normalize author/title from filenames
- **Multiple File Formats**: Supports `.mp3` and `.m4b` audiobook files
- **Flexible Structure**: Handles both single files and multi-file directories
- **Robust Processing**: Prevents race conditions with directory stability checks and processing locks
- **Automatic Organization**: Creates clean `[Author]/[Book Title]` library structure
- **Smart Fallbacks**: Falls back to heuristic parsing when AI is unavailable
- **Comprehensive Logging**: Detailed logging to console and persistent log file with configurable levels
- **File Permissions**: Configurable ownership (PUID/PGID) and permissions for migrated content
- **Rate Limiting**: Built-in AI request pacing with exponential backoff retry logic

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
   - Uses the selected AI provider to normalize this data for correctness and consistency
   - Falls back to heuristic parsing if AI is unavailable
   - Rate limiting prevents API quota exhaustion
5. **Library Organization**: Files are moved to `DEST_DIR/[Author]/[Title]/` structure
6. **Cleanup**: Source files/directories are removed after successful migration
7. **Logging**: All operations logged to console and persistent log file
### AI provider configuration

AI normalization is optional. With no provider variables, Dewey selects Anthropic,
model `claude-haiku-4-5-20251001`, and uses heuristics when no Anthropic key is set.
Selection is explicit: available keys never select a provider and no gateway or
provider failover is used. Configuration is read dynamically for each operation.

| AI_PROVIDER | AI_MODEL | Credential | AI_BASE_URL |
| --- | --- | --- | --- |
| `anthropic` (default) | Optional; see precedence below | `ANTHROPIC_API_KEY` | Optional; default `https://api.anthropic.com/v1` |
| `openai` | Required | `OPENAI_API_KEY` | Optional; default `https://api.openai.com/v1` |
| `google` | Required | `GOOGLE_GENERATIVE_AI_API_KEY` | Optional; default `https://generativelanguage.googleapis.com/v1beta` |
| `openai-compatible` | Required | Optional `AI_API_KEY` | Required HTTP(S) API base |

Use one of these environment blocks (model identifiers must be available to your account/server):

```dotenv
# Anthropic, including existing deployments:
ANTHROPIC_API_KEY=sk-ant-example
# Default model is used without AI_MODEL.
```

```dotenv
AI_PROVIDER=openai
AI_MODEL=gpt-4.1-mini
OPENAI_API_KEY=your-openai-key
```

```dotenv
AI_PROVIDER=google
AI_MODEL=gemini-2.5-flash
GOOGLE_GENERATIVE_AI_API_KEY=your-google-key
```

```dotenv
# Local server without authentication (authorization header is omitted):
AI_PROVIDER=openai-compatible
AI_MODEL=local-model
AI_BASE_URL=http://localhost:1234/v1
```

```dotenv
# Hosted compatible endpoint with authentication:
AI_PROVIDER=openai-compatible
AI_MODEL=hosted-model
AI_BASE_URL=https://inference.example.com/v1
AI_API_KEY=your-compatible-key
```

In Docker, use a host or service address reachable from the container; localhost
refers to the container itself. Protocol compatibility does not guarantee that a
local model can reliably return useful JSON metadata.

Only the selected provider's key is read. `AI_API_KEY` never overrides native
provider keys. Keys are trimmed and matching surrounding single or double quotes
are removed. Unselected provider settings, including legacy Anthropic settings,
are ignored. A missing native key warns and disables AI network calls; a
compatible endpoint can run without a key.

Anthropic model precedence is nonblank `AI_MODEL`, then nonblank `CLAUDE_MODEL`,
then `claude-haiku-4-5-20251001`. Anthropic endpoint precedence is nonblank
`AI_BASE_URL`, then `ANTHROPIC_API_URL`, then the native default. Empty or
whitespace-only new settings fall through. Legacy settings still work:

```dotenv
ANTHROPIC_API_KEY=sk-ant-example
CLAUDE_MODEL=legacy-model
ANTHROPIC_API_URL=https://proxy.example.com
```

`ANTHROPIC_API_URL` retains API-root semantics: trailing slashes are removed and
`/v1/messages` is used. In contrast, `AI_BASE_URL` is the adapter API base,
including the version path: Anthropic and OpenAI commonly need `/v1`, Google
needs `/v1beta`. Dewey appends only the adapter's operation path to this new
setting, so do not include `/messages` or `/chat/completions` itself. Custom
path prefixes are preserved. Unsupported providers, missing required models, and
invalid/missing required bases are configuration errors before network access.

Startup probes the selected model once with a ten-second deadline. Failure is
advisory and later normalization remains eligible. Normalization prioritizes
embedded tags, accepts plain or fenced JSON with nonblank string author/title,
and retains heuristic fallback and path sanitization. Each normalization has at
most three attempts, fifteen seconds per attempt, with 2s/4s backoff for network
errors, timeouts, HTTP 408/429 and 5xx. Authentication failures, refusals and
invalid content do not retry. SDK retries are disabled. A process-local rolling
minute budget allows 45 normalization attempts per provider/endpoint/credential
configuration; retries count, and concurrent callers wait for capacity. Logs show
safe provider/model/status summaries without raw provider errors or credentials.

SDK dependencies are pinned together and verified on Bun 1.3.0. Provider creation
uses explicit model objects, including OpenAI chat models and compatible chat
models. See the [official provider documentation](https://ai-sdk.dev/providers/ai-sdk-providers)
and [compatible adapter documentation](https://ai-sdk.dev/providers/openai-compatible-providers)
for the transport APIs; installed package sources define the pinned versions.
