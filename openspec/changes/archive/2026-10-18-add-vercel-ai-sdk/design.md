## Context

See proposal.md for motivation and the two delta specs for behavior contracts. `src/claude.js` currently builds the metadata prompt, calls Anthropic through Axios, parses JSON, throttles requests, and retries transient errors. `src/index.js` performs a non-fatal startup check; both migration paths call the normalizer. Configuration uses dynamic getters, and Docker supplies legacy Anthropic defaults. Tests include credential-dependent integration cases and heuristic-only cases that currently clear only the Anthropic key.

## Goals / Non-Goals

**Goals:** Keep provider details behind one model-resolution boundary; retain the caller's nullable metadata contract and runtime-readable configuration; make acceptance tests deterministic.

**Non-Goals:** Provider-specific tuning surfaces, automatic model discovery, gateway routing, streaming, arbitrary runtime adapter imports, and changes to filesystem or job processing.

## Decisions

### 1. Explicit adapters behind a neutral AI module

Introduce `src/ai.js` with provider-neutral normalization and startup validation, using `ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, and `@ai-sdk/openai-compatible`. Resolve a model object explicitly and pass it to `generateText`, avoiding implicit gateway routing from bare model strings. Use OpenAI chat models for the native OpenAI route and the compatible chat adapter for custom endpoints. Keep the adapter map small and extensible.

Alternative: retain raw HTTP implementations per provider. This duplicates transport behavior and does not deliver the requested SDK integration. A gateway-only solution introduces an account and routing requirement outside the chosen scope.

Select mutually compatible stable SDK versions during implementation and verify their Bun 1.3.0 runtime requirements before locking dependencies. API details must match installed versions rather than assuming a particular current major.

### 2. Central configuration resolution with documented precedence

Keep getters in `src/config.js` and add a resolved AI configuration function called at use time. Use the variables and precedence specified in `ai-provider-configuration/spec.md`. Require explicit models for non-Anthropic providers to avoid silently selecting a billable model. Native keys remain provider-specific; `AI_API_KEY` belongs only to compatible endpoints. For unauthenticated compatible endpoints omit authorization headers rather than inventing credentials.

`AI_BASE_URL` is an adapter API base: examples include an Anthropic base ending `/v1`, an OpenAI base ending `/v1`, and a Google base ending `/v1beta`. Native adapter defaults apply when no override is set. Convert legacy `ANTHROPIC_API_URL` from its historical API-root semantics by trimming trailing slashes and appending `/v1`; do not perform that conversion on `AI_BASE_URL`. Document this distinction explicitly and test request URLs with a mock HTTP transport. Reject non-HTTP(S) URLs and sanitize any displayed URL.

Alternative: reuse `CLAUDE_MODEL` for every provider or introduce a generic key overriding native keys. Both obscure ownership and risk accidental cross-provider settings. Ignore unselected provider configuration during validation. Structural configuration errors remain fatal; absent native credentials remain optional warnings.

### 3. Shared prompt and portable JSON validation

Move the current prompt into the neutral normalizer, preserving filename, parent-directory, and authoritative embedded-tag guidance. Use text generation requesting JSON, strip optional surrounding JSON fences, parse, and validate nonblank string author/title fields. Return only those fields or `null`; callers retain heuristics and path sanitization. Keep existing generation settings where supported, but avoid making optional tuning such as temperature a requirement for every model.

Alternative: mandatory native structured-output schemas. Some compatible endpoints do not implement them, so portable text plus local validation provides broader support without weakening acceptance checks.

### 4. One retry owner and conservative pacing

Set SDK retries to zero. The neutral normalizer owns at most three attempts with per-attempt abort deadlines of 15 seconds. Retry transient network errors, timeouts, HTTP 408/429, and 5xx with 2s then 4s backoff. Do not retry authentication errors, explicit refusals, or invalid content. Throttle every attempted normalization request, including retries, to 45 attempts per rolling minute using a configuration identity that never appears in logs. Reserve slots atomically and recheck after waits to avoid concurrent callers exceeding the limit. The limiter is process-local, matching existing deployment behavior.

Startup uses the same model resolver with a short probe, a ten-second deadline, and zero retries. Its failure is advisory and does not permanently disable later normalization. Missing native keys bypass network calls entirely. SDK exceptions are reduced to safe categories and status codes; raw request/response objects and error messages that might contain credentials are not logged.

Alternative: SDK retries plus the existing loop can multiply attempts. Removing pacing would also regress existing quota protection; retaining a conservative shared policy is preferable until per-provider limits are explicitly requested.

### 5. Integrate callers and isolate tests

Update startup and both migration paths to use neutral exports and neutral diagnostics. Keep `src/claude.js` as thin forwarding exports for compatibility with existing imports, with no second transport implementation. Leave unrelated error types intact unless their consumers require changes. Remove Axios only after checking all consumers.

Use mocked SDK calls for control-flow cases and mock fetch/HTTP responses to validate adapter URLs, authorization, provider/model selection, and response extraction without live traffic. Clear all AI selection and credential variables in heuristic-only tests; make live integration tests explicitly opt-in and restore environment state after each test.

## Risks / Trade-offs

- [Compatible endpoints vary in model features and JSON quality] -> Use the chat/text baseline, strict local result validation, and heuristic fallback; document that protocol compatibility does not guarantee model quality.
- [Dependency runtime incompatibility] -> Verify engine requirements, Bun install, and a container build with the updated frozen lockfile.
- [Legacy and SDK base URL semantics differ] -> Centralize the conversion and assert exact request paths in transport tests.
- [Conservative pacing underuses higher quotas] -> Preserve predictable behavior; provider-specific rate controls can follow separately.
- [SDK exceptions include sensitive material] -> Log safe provider/model/status summaries and test redaction with sentinel credentials.
- [Live model output is nondeterministic] -> Keep required CI tests mocked and live smoke tests opt-in.

## Migration Plan

1. Add locked SDK dependencies, configuration resolution, and neutral normalization with regression tests.
2. Wire startup and migration callers, retain legacy export wrappers, and update documentation and container configuration examples.
3. Run the full Vitest suite without live credentials, verify adapter transport tests, and build the production container using the frozen lockfile. Optional live smoke checks require explicitly supplied test credentials.
4. Existing Anthropic deployments need no changes. Other providers set `AI_PROVIDER`, `AI_MODEL`, and their documented credentials; compatible endpoints additionally set `AI_BASE_URL`.
5. Roll back by restoring the prior image or dependency/source revision. Keep legacy environment variables available for rollback; deployments using newly added providers must restore Anthropic settings or operate with heuristics on the old release.

References: [Issue #12](https://github.com/masonfox/dewey/issues/12), [AI SDK provider management](https://ai-sdk.dev/docs/ai-sdk-core/provider-management). Confirm concrete adapter APIs against installed-version documentation during implementation.
