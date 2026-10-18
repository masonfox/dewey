## Why

Dewey currently ties optional AI metadata normalization to Anthropic's HTTP API. Issue #12 requests Vercel AI SDK integration so users can choose other providers through environment configuration.

## What Changes

- Support Anthropic, OpenAI, Google Gemini, and configurable OpenAI-compatible endpoints through Vercel AI SDK.
- Add provider-neutral environment settings for provider, model, and endpoint selection, using each selected provider's credentials.
- Preserve existing `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, and `ANTHROPIC_API_URL` configurations and the current Anthropic default.
- Use the selected provider for startup validation and both file and directory normalization.
- Preserve embedded metadata guidance, validated author/title results, bounded retries, and heuristic fallback when AI is unavailable.
- Document configuration and provide deterministic coverage without requiring live provider credentials.

## Capabilities

### New Capabilities

- `ai-provider-configuration`: Environment-based provider selection, credentials, model and endpoint resolution, legacy compatibility, and configuration diagnostics.
- `ai-metadata-normalization`: Provider-independent startup checks and author/title normalization with bounded requests and graceful fallback.

### Modified Capabilities

None. The repository has no existing capability specs.

## Impact

- Affects `src/config.js`, `src/claude.js` (replaced or wrapped by a neutral AI module), `src/index.js`, and normalization calls in `src/migrate.js`.
- Adds `ai` and the Anthropic, OpenAI, Google, and OpenAI-compatible SDK adapters; updates `package.json` and `bun.lock`. Remove Axios only if no remaining consumers need it.
- Updates configuration, normalization, and migration tests, `.env.example`, README instructions, and container defaults as needed.
- No changes to migration layout, file copy verification, watcher behavior, or job lifecycle. No gateway requirement, automatic provider failover, arbitrary adapter loading, or new configuration UI.
