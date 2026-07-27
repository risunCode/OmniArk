# Requirements Document

## Introduction

This refactor reorganizes the backend under `src/` without changing its externally observable behavior. The immediate priority is the provider layer, where `kiro.ts`, `qoder.ts`, and `codex.ts` have grown beyond a maintainable size. The refactor will move each provider into its own subdirectory and split responsibilities into cohesive modules. It will then address the duplicate BYOK route registrations in `src/api/accounts.ts` and prepare additional large proxy modules for later extraction.

This is a structural refactor, not a feature rewrite. It must preserve HTTP routes, request and response formats, provider routing, account state, token encryption, database schema, WebSocket event shapes, upstream protocol behavior, and configuration keys.

## Scope

### In scope

- Reorganize Kiro, Codex, and Qoder provider implementations into provider-specific directories.
- Keep every provider implementation to a maximum of three cohesive TypeScript modules, with two modules preferred where practical.
- Preserve each provider's public class import and named helper exports through a stable directory entry module.
- Remove duplicate BYOK route registrations from `src/api/accounts.ts` while retaining the behavior of the currently effective route definitions.
- Split account management into at most three cohesive modules.
- Add or update focused regression tests for extracted boundaries and run existing applicable checks.
- Produce a staged migration that can be reviewed and reverted provider by provider.

### Out of scope

- Changing provider credentials, endpoints, headers, request payloads, or response transformations.
- Changing account selection, retry, quota, rate-limit, warmup, or load-balancing policy.
- Changing SQLite tables, migrations, stored JSON shapes, encryption behavior, or environment-variable names.
- Reformatting, deleting, or simplifying business logic merely to reduce line count.
- Refactoring the dashboard, installers, authentication scripts, or `trsh/` artifacts except where a test fixture must follow a moved import.
- Adding providers or changing supported model catalogs.

## Requirements

### Requirement 1: Preserve observable behavior

**User Story:** As an operator of the proxy pool, I want the internal layout to change without changing proxy behavior, so that I can improve maintainability without disrupting connected clients or stored accounts.

#### Acceptance Criteria

1. WHEN the refactor is complete THEN `POST /v1/chat/completions`, `POST /v1/messages`, `GET /v1/models`, and all existing `/api/*` routes SHALL retain their current paths, authentication requirements, request contracts, response contracts, and status-code behavior.
2. WHEN a request is routed to Kiro, Codex, or Qoder THEN the system SHALL preserve the same provider selection, model ownership rules, account-selection behavior, token refresh behavior, upstream request construction, SSE framing, tool-call translation, usage extraction, and error classification.
3. WHEN an account or request state is written THEN the system SHALL preserve the existing database schema, field names, stored token shapes, encryption behavior, and WebSocket event type and payload shape.
4. IF a behavior is ambiguous between duplicated route definitions THEN the refactor SHALL preserve the behavior of the first route registration that Hono currently matches and SHALL remove the unreachable duplicate implementation only after that behavior is covered by verification.

### Requirement 2: Reorganize provider modules

**User Story:** As a maintainer, I want each provider implementation located in a provider-specific directory with cohesive files, so that I can work on one upstream integration without navigating unrelated protocol logic.

#### Acceptance Criteria

1. WHEN the provider refactor is complete THEN Kiro SHALL be located under `src/proxy/providers/kiro/`, Codex under `src/proxy/providers/codex/`, and Qoder under `src/proxy/providers/qoder/`.
2. WHEN an existing module imports `KiroProvider`, `CodexProvider`, `QoderProvider`, or currently exported Qoder helpers THEN a stable provider entry module SHALL continue to expose the required symbol with no change to the symbol's runtime contract.
3. WHERE a provider has a distinct stream parser or protocol implementation THEN that concern SHALL be extracted from the provider adapter class instead of copied or reimplemented.
4. WHERE practical, each provider SHALL use two modules: an `index.ts` adapter entry and one focused implementation module; IF protocol complexity requires a third module THEN the third module SHALL have one explicit responsibility and no behavior duplication.
5. WHEN imports are moved THEN the refactor SHALL avoid circular dependencies between provider entries, protocol helpers, shared `base.ts`, the provider registry, and account APIs.

### Requirement 3: Preserve provider-specific boundaries

**User Story:** As a maintainer, I want provider-specific protocol code isolated from proxy orchestration, so that changes to one upstream provider have a limited blast radius.

#### Acceptance Criteria

1. WHEN Kiro is reorganized THEN its AWS event-stream helpers and message transformation helpers SHALL remain reusable from the Kiro adapter, and the Kiro-Pro variant model map and standard-provider fallback behavior SHALL remain unchanged.
2. WHEN Codex is reorganized THEN Responses API payload conversion, SSE response parsing, OpenAI-compatible stream emission, OAuth refresh, and usage health checks SHALL retain their existing semantics.
3. WHEN Qoder is reorganized THEN COSY signing, encrypted bearer session construction, payload encoding, chat-body construction, SSE parsing, PAT activation, activity quota retrieval, and account health behavior SHALL retain their existing semantics.
4. WHEN public provider helper types are moved THEN they SHALL be exported from the narrowest shared module needed by their actual consumers and SHALL not expose account secrets in logs or API responses.

### Requirement 4: Consolidate account routes safely

**User Story:** As a maintainer, I want account, BYOK, and Codex onboarding code separated by concern, so that route changes do not accidentally shadow one another.

#### Acceptance Criteria

1. WHEN account routes are reorganized THEN `src/api/accounts/index.ts` SHALL remain the module exported as `accountsRouter` by `src/api/index.ts`.
2. WHEN BYOK routes are registered THEN each supported BYOK route and HTTP method SHALL be registered exactly once.
3. WHEN the duplicate BYOK implementations are removed THEN the retained implementation SHALL preserve grouped multi-key BYOK behavior, masked listing behavior, explicit key reveal behavior, load-balancing settings, model-cache refresh, request-log foreign-key cleanup, and broadcast events.
4. WHEN Codex OAuth or instant-login helpers are moved THEN their current named exports and their callers SHALL remain valid, including authorization-code exchange, refresh-token import, and access-token import behavior.
5. WHEN generic account routes are moved THEN literal routes such as `/byok`, `/bulk`, `/instant-login`, `/toggle-all`, and `/bulk-delete` SHALL be registered before `/:id` routes so dynamic matching cannot shadow them.

### Requirement 5: Stage future proxy refactors without mixing scope

**User Story:** As a maintainer, I want the largest remaining proxy modules prepared for later refactors, so that the first migration remains reviewable and does not block other work.

#### Acceptance Criteria

1. WHEN the first implementation phase is planned THEN `src/proxy/index.ts` and `src/proxy/pool.ts` SHALL be treated as separate follow-up slices after provider and account route reorganization.
2. WHEN `src/proxy/index.ts` is later split THEN HTTP route handlers and request-log/usage stream finalization SHALL be separated without changing `proxyRouter`, `recordRequest`, or endpoint behavior.
3. WHEN `src/proxy/pool.ts` is later split THEN account selection and cache state SHALL remain in one state-owning service boundary, while persistence mutations and statistics may be extracted without changing the exported `pool` singleton contract.
4. WHILE implementing the provider and accounts phases, the system SHALL NOT alter the behavior of `src/proxy/index.ts` or `src/proxy/pool.ts` beyond import-path updates required by moved modules.

### Requirement 6: Verification and migration safety

**User Story:** As an operator, I want each structural change independently verified, so that a path move cannot silently alter live proxy behavior.

#### Acceptance Criteria

1. WHEN a provider is moved THEN compilation/type checking SHALL complete successfully before the next provider is moved.
2. WHEN a provider stream implementation is extracted THEN focused tests SHALL verify non-stream output, SSE framing, tool calls, error handling, and token/usage propagation relevant to that provider.
3. WHEN account routes are consolidated THEN focused route tests SHALL verify literal-route precedence, each BYOK route method, and that only one registration exists for every BYOK method/path pair.
4. WHEN the complete refactor slice is ready THEN the dashboard production build and the backend TypeScript check SHALL pass.
5. IF an integration test requires live provider credentials or network access THEN the test plan SHALL separate deterministic mocked protocol tests from opt-in live smoke tests and SHALL not expose credentials.

## Success Measures

- The provider files currently measuring 982 lines (Kiro), 816 lines (Codex), and 1539 lines (Qoder) are replaced by focused directory modules.
- No provider directory has more than three top-level implementation modules excluding already-existing low-level Kiro helpers and tests.
- `src/api/accounts.ts` no longer contains duplicate BYOK route registrations.
- Existing external import consumers resolve after the move.
- Type checks and applicable regression tests pass with no endpoint, schema, or configuration changes.
