## 1. Dependencies and configuration

- [x] 1.1 Select mutually compatible stable `ai` and Anthropic, OpenAI, Google, and OpenAI-compatible adapter versions, update `package.json` and `bun.lock`, and verify installation with `bun install --frozen-lockfile` on the supported Bun runtime.
- [x] 1.2 Implement dynamic provider/model/credential/base-URL resolution in `src/config.js`; verify all four providers, Anthropic defaults, new-over-legacy precedence, credential cleanup, and ignored unselected settings with configuration tests.
- [x] 1.3 Add selected-provider validation and safe diagnostics; verify unsupported providers, missing models, invalid HTTP(S) URLs, missing native keys, and unauthenticated compatible endpoints against the configuration spec, including assertions that secrets are absent from diagnostics.

## 2. Provider-independent normalization

- [x] 2.1 Add explicit model construction in `src/ai.js` for all four adapters; verify mock transport requests target the selected provider/model, carry only the intended credentials, omit auth for credential-free compatible endpoints, and preserve legacy Anthropic `/v1/messages` routing.
- [x] 2.2 Move prompt construction and JSON result handling into the neutral module; verify filename/parent/tag context, fenced JSON acceptance, nonblank string validation, malformed content rejection, and nullable fallback with deterministic tests.
- [x] 2.3 Implement three-attempt retry ownership with SDK retries disabled, 15-second attempt deadlines, and 2s/4s transient backoff; verify retryable statuses/network errors, aborts, exhausted attempts, and non-retryable authentication/refusal/content failures using fake timers.
- [x] 2.4 Preserve process-local 45-attempt rolling-minute pacing per configuration with retries counted and atomic slot reservation; verify boundaries, concurrent waits, and isolation between configurations using fake timers.
- [x] 2.5 Add selected-provider startup validation with a ten-second deadline and zero retries; verify no request without native credentials, advisory failure, later normalization recovery, and secret-free logs for startup and normalization failures.

## 3. Application integration and regression coverage

- [x] 3.1 Update `src/index.js` and both normalization calls in `src/migrate.js` to use neutral exports; verify mocked file and directory migrations use selected-provider metadata and retain heuristic fallback and path sanitization when AI fails.
- [x] 3.2 Retain forwarding exports in `src/claude.js`, remove the duplicate Anthropic transport, and remove Axios only if no consumers remain; verify legacy imports still work and repository searches show no active raw Anthropic request path.
- [x] 3.3 Isolate all AI-related environment variables in heuristic tests and make live integration cases explicitly opt-in; verify the full Vitest suite via `bun run test` without credentials and verify mocked tests never send live requests.

## 4. Operator documentation and release validation

- [x] 4.1 Update `.env.example` and README with all four provider configurations, required model/key variables, credential-free compatible endpoints, base-URL path semantics, precedence, legacy compatibility, and fallback behavior; verify every documented example resolves to the intended configuration through the configuration tests.
- [x] 4.2 Review container defaults so legacy settings do not override explicit provider choices, updating Dockerfile where necessary; verify a production image builds with `docker build -t dewey:ai-sdk .` using the frozen lockfile and the default no-key configuration remains valid.
- [x] 4.3 Run `openspec validate add-vercel-ai-sdk --strict` and review acceptance coverage across both delta specs; verify all implementation tasks have evidence, the full suite passes, and any unavailable optional live smoke checks are recorded.
