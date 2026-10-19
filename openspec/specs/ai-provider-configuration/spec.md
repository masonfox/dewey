# ai-provider-configuration Specification

## Purpose

Allow operators to select an AI provider through environment variables while retaining compatibility with existing Anthropic deployments.

## Requirements

### Requirement: Environment-based provider selection
The system SHALL accept `AI_PROVIDER` values `anthropic`, `openai`, `google`, and `openai-compatible`, defaulting to `anthropic` when unset or empty. It SHALL use `AI_MODEL` as the selected provider's model identifier. Non-Anthropic providers SHALL require an explicit nonblank model. It SHALL use only the selected provider and SHALL NOT infer selection from available credentials or route through a gateway implicitly.

#### Scenario: Select each supported provider
- **WHEN** an operator sets a supported `AI_PROVIDER`, a nonblank `AI_MODEL`, and the selected provider's required configuration
- **THEN** startup checks and metadata requests target that provider and model
- **AND** credentials for other providers are not required or used

#### Scenario: Multiple credentials without explicit selection
- **WHEN** `AI_PROVIDER` is absent and multiple provider credentials are present
- **THEN** Anthropic remains selected

### Requirement: Legacy Anthropic compatibility
For Anthropic, the system SHALL resolve the model from nonblank `AI_MODEL`, then nonblank `CLAUDE_MODEL`, then `claude-haiku-4-5-20251001`. It SHALL resolve the endpoint from nonblank `AI_BASE_URL`, then `ANTHROPIC_API_URL`, then `https://api.anthropic.com`. Legacy URL settings SHALL retain their existing API-root semantics. Legacy Anthropic settings SHALL NOT affect other providers.

#### Scenario: Existing deployment
- **WHEN** only existing Anthropic settings are configured
- **THEN** the same key, model, and endpoint are used without configuration changes

#### Scenario: New settings override legacy settings
- **WHEN** both new and legacy Anthropic model and endpoint variables are set
- **THEN** `AI_MODEL` and `AI_BASE_URL` take precedence

### Requirement: Credentials and custom endpoints
The system SHALL read credentials from `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, or `AI_API_KEY` for the corresponding provider. It SHALL trim whitespace and surrounding matching quotes from credentials. `AI_BASE_URL` SHALL optionally override native endpoints and SHALL be required for `openai-compatible`; new base URLs SHALL identify the adapter's API base including any required version path. OpenAI-compatible endpoints SHALL support operation without credentials when the endpoint does not require authentication.

#### Scenario: Authenticated compatible endpoint
- **WHEN** `AI_PROVIDER=openai-compatible` and valid model, base URL, and `AI_API_KEY` are configured
- **THEN** requests use that endpoint and key without using any native provider's credentials

#### Scenario: Local endpoint without authentication
- **WHEN** a compatible endpoint accepts unauthenticated requests and `AI_API_KEY` is absent
- **THEN** Dewey can normalize metadata through that endpoint

### Requirement: Configuration diagnostics and safe fallback
Unsupported providers, missing required models, and malformed or missing required base URLs SHALL produce actionable configuration errors before network access. Base URLs SHALL use HTTP or HTTPS. Missing native provider credentials SHALL produce a warning and enable heuristic-only operation. Validation SHALL consider only the selected provider's settings. Diagnostics SHALL NOT expose credential values or authenticated URL components.

#### Scenario: Unsupported provider
- **WHEN** `AI_PROVIDER` contains an unsupported value
- **THEN** startup reports the supported values and makes no AI request

#### Scenario: Incomplete non-Anthropic selection
- **WHEN** a non-Anthropic provider lacks `AI_MODEL` or a compatible provider lacks a valid base URL
- **THEN** configuration validation fails with the relevant variable names

#### Scenario: Missing native credentials
- **WHEN** the selected native provider has no credential
- **THEN** startup warns and migrations proceed using heuristics without AI network calls

#### Scenario: Unused legacy configuration
- **WHEN** OpenAI is selected with valid settings and an invalid legacy Anthropic URL is present
- **THEN** the unused Anthropic URL does not block startup
