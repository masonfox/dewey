# Implementation acceptance evidence

Validated on 2026-10-18. All fourteen implementation tasks are complete. No commits were created and there are no outstanding blockers.

## Commands and results

The host does not expose `bun` directly on PATH. `npm exec --yes --package=bun@1.3.0 -- bun` runs the exact supported runtime; `bun --version` through that prefix returned `1.3.0`.

| Command | Result |
| --- | --- |
| `npm exec --yes --package=bun@1.3.0 -- bun install --frozen-lockfile` | Exit 0; 130 installs checked across 179 packages, no changes |
| `npm exec --yes --package=bun@1.3.0 -- bun run test` | Exit 0; 218 passed, 17 optional live cases skipped, 12 files passed and one fully skipped |
| Same full-suite command with all AI configuration/key variables set to an invalid ambient sentinel and `RUN_LIVE_AI_TESTS=0` | Exit 0; same 218 passed and 17 skipped; setup isolates ambient configuration and blocks live fetch |
| `docker build -t dewey:ai-sdk .` | Exit 0; production image built using `oven/bun:1.3.0-slim` and `bun install --production --frozen-lockfile` |
| `openspec validate add-vercel-ai-sdk --strict` | Exit 0; change valid |
| `git diff --check` | Exit 0; only Git's Windows line-ending notices |
| `rg -n -e axios -e axios.post -e /v1/messages -e claude.js src package.json bun.lock` | No matches; there is no active raw Anthropic request path or Axios dependency |

Two additional stdin assertion programs passed:

- `npm exec --yes --package=bun@1.3.0 -- bun run -`: direct execution on Bun 1.3.0 verified default no-key configuration and real installed SDK startup/normalization for all four adapters with mocked fetch responses (two requests per provider, valid metadata returned).
- `docker run --rm -i dewey:ai-sdk bun run -`: the built production image verified default Anthropic/no-key configuration, advisory startup and normalization fallback, explicit OpenAI model selection despite invalid legacy Anthropic settings, and exactly zero network calls.

Docker was initially unavailable; the coordinator started the Linux daemon. The mandatory build and runtime checks subsequently succeeded.

## Task-to-evidence mapping

| Task | Acceptance evidence |
| --- | --- |
| 1.1 | Exact compatible stable dependencies locked; frozen install, direct Bun SDK execution and production build pass |
| 1.2 | `ai-config.test.js`: four providers, dynamic reads, defaults, new-over-legacy precedence, matching-quote key cleanup and unused settings |
| 1.3 | `ai-config.test.js`: structural errors, required model/base, HTTP(S), missing native credentials, credential-free compatible configuration and safe diagnostics; `ai-transport.test.js`: invalid selection causes no transport access |
| 2.1 | `ai-transport.test.js`: real adapters target all four expected operation URLs/models, exact selected headers, custom paths, no compatible auth and legacy `/v1/messages` |
| 2.2 | `ai.test.js`: filename/parent/all tag context and authoritative guidance, fenced JSON, trimmed nonblank string fields, malformed/missing/non-string text and fields, nullable fallback |
| 2.3 | `ai.test.js`: fake-timer 15-second aborts, three attempts, 2s/4s backoff, 408/429/5xx, network/abort recovery, exhaustion, nonretryable auth/content/refusal; real-SDK transport test confirms retries do not multiply |
| 2.4 | `ai.test.js`: 45 slots, exact rolling-minute boundary, 46 concurrent waiters across two windows, provider/endpoint/full-key isolation and retries counted |
| 2.5 | `ai.test.js`: missing native keys cause no SDK calls, ten-second startup abort, zero retries, advisory failure followed by recovery, secret-free logs; real adapter startup and refusal tests |
| 3.1 | `ai-migration.test.js`: real neutral SDK module plus mocked fetch/audio metadata, file and directory selection, preserved bytes and source cleanup, path sanitization and heuristic fallback after auth failure |
| 3.2 | `ai.test.js`: legacy exports are identical forwarding functions; source/dependency search confirms no Axios or duplicate transport |
| 3.3 | `setup.js` and `ai-env.js`: all AI environment settings isolated and live fetch denied by default; live suites require explicit flag and key; full suite passes with absent credentials and hostile ambient settings |
| 4.1 | `ai-config.test.js`: provider examples plus literal README dotenv blocks and active `.env.example` parsed and validated; transport tests verify documented API-base path semantics |
| 4.2 | Legacy AI defaults removed from Dockerfile; production frozen build and no-key/explicit-provider image checks pass |
| 4.3 | Both delta specs reviewed against the mapping below, full suite and strict OpenSpec validation pass; optional live cases recorded below |

## Delta-spec coverage review

`ai-provider-configuration`: explicit environment selection without credential inference, each provider's model/key ownership, Anthropic defaults and legacy precedence, API root versus API base semantics, custom endpoints, unauthenticated compatible operation, selected-only validation and secret-free diagnostics are covered by configuration and transport tests.

`ai-metadata-normalization`: both migration types, authoritative tags and parent context, validated JSON, filesystem sanitization, advisory startup recovery, bounded attempts/deadlines, refusals/authentication/invalid-content fallback, no provider failover, safe logging and atomic per-configuration rolling pacing are covered by control-flow, transport and migration tests.

## SDK compatibility basis

Pinned `ai@7.0.143`, `@ai-sdk/anthropic@4.0.82`, `@ai-sdk/openai@4.0.96`, `@ai-sdk/google@4.0.99`, `@ai-sdk/openai-compatible@3.0.71` and peer-compatible `zod@4.1.12`. The provider packages share `@ai-sdk/provider@4.0.29`; their published Node engine requirement is >=22. Bun 1.3.0 compatibility was demonstrated by frozen installation, direct real-SDK mocked transport execution and the production image.

Verified official [Anthropic](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic), [Google](https://ai-sdk.dev/providers/ai-sdk-providers/google), and [compatible-provider documentation](https://ai-sdk.dev/providers/openai-compatible-providers), and the installed version's bundled docs/source for all four adapters and `generateText`. The installed APIs confirm `.chat()` for OpenAI, `.chatModel()` for compatible endpoints, optional compatible keys, `maxRetries: 0`, AbortSignal support and `include.responseBody` for detecting explicit refusal flags. Raw bodies are inspected only for refusal and never logged.

## Optional live checks

No live provider or local-model-server smoke tests were run. They require explicit operator opt-in (`RUN_LIVE_AI_TESTS=1`), credentials and/or locally available audio/server fixtures. The seventeen skipped legacy live tests are optional; all mandatory acceptance uses deterministic mocks and real installed adapters without live traffic.
