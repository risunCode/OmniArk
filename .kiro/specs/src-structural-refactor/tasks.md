# Implementation Plan

- [ ] 1. Establish regression coverage and a move baseline
  - Add focused mocked tests for the currently observable Kiro, Codex, and Qoder adapter behavior before moving code.
  - Capture the currently effective BYOK route behavior, including literal route precedence and multi-key grouping.
  - Record the baseline typecheck command and run it successfully.
  - _Requirements: 1.1, 1.2, 4.3, 6.1, 6.2, 6.3_

- [ ] 2. Move the Kiro provider into its directory entry and stream module
  - Move `KiroProvider` and `KiroVariant` from `providers/kiro.ts` to `providers/kiro/index.ts`; adjust existing Kiro helper imports to local relative paths.
  - Extract AWS live-stream conversion into `providers/kiro/stream.ts` with explicit dependencies and no change to SSE frames, tool-call assembly, or usage extraction.
  - Update registry imports explicitly and remove the former `kiro.ts` only after imports resolve.
  - Run Kiro-focused tests and the backend typecheck.
  - _Requirements: 1.2, 2.1, 2.2, 2.3, 3.1, 6.1, 6.2_

- [ ] 3. Move the Codex provider into its directory entry and stream module
  - Move `CodexProvider` into `providers/codex/index.ts` without changing model ownership, OAuth refresh, Responses API requests, quota behavior, or provider result fields.
  - Extract Codex Responses SSE accumulation and OpenAI SSE emission into `providers/codex/stream.ts`.
  - Update the registry import explicitly and remove the former `codex.ts` after all references resolve.
  - Run Codex-focused tests and the backend typecheck.
  - _Requirements: 1.2, 2.1, 2.2, 2.3, 3.2, 6.1, 6.2_

- [ ] 4. Move the Qoder provider into protocol, chat, and entry modules
  - Move COSY encoding, signing, session construction, bearer fetch, and PAT/job-token protocol helpers into `providers/qoder/protocol.ts`.
  - Move Qoder model definitions, template/message conversion, session ID generation, native chat-body construction, tool-ID normalization, and SSE-line parsing into `providers/qoder/chat.ts`.
  - Move `QoderProvider` and `activateQoderPat` into `providers/qoder/index.ts`, preserving public helper exports required by account routes.
  - Update imports explicitly and remove the former `qoder.ts` after all references resolve.
  - Run Qoder-focused tests and the backend typecheck.
  - _Requirements: 1.2, 2.1, 2.2, 2.3, 2.4, 3.3, 6.1, 6.2_

- [ ] 5. Consolidate effective BYOK route registrations
  - Add a test that proves the first BYOK route registration is the currently effective behavior for each duplicate method/path pair.
  - Retain the grouped multi-key BYOK implementation and remove the unreachable legacy BYOK duplicate blocks only after the test passes.
  - Verify key masking, explicit reveal, load-balancing setting updates, model-cache refresh, account/request-log cleanup, and broadcasts remain unchanged.
  - _Requirements: 1.4, 4.2, 4.3, 6.3_

- [ ] 6. Split account management into core, BYOK, and Codex modules
  - Create `api/accounts/index.ts` as the exported router entry and keep static routes registered before `/:id` routes.
  - Extract BYOK helper logic and registrations into `api/accounts/byok.ts` without changing URLs or JSON contracts.
  - Extract Codex onboarding/import helpers into `api/accounts/codex.ts`, preserving their named exports and instant-login flow.
  - Move generic CRUD, bulk operations, Kiro instant login, and Qoder PAT creation into the entry module; update `api/index.ts` to the new explicit import path.
  - Run account-route tests and the backend typecheck.
  - _Requirements: 1.1, 2.5, 4.1, 4.2, 4.3, 4.4, 4.5, 6.1, 6.3_

- [ ] 7. Verify the completed provider and accounts refactor slice
  - Inspect imports with CodeGraph to confirm registry, API mounting, provider helpers, and account routes retain valid call paths with no circular dependency.
  - Run all focused provider/account tests, `bunx tsc --noEmit`, and `bun run build`.
  - Compare moved constants, route methods/paths, environment-variable reads, database writes, broadcast event names, and provider public exports against the baseline.
  - _Requirements: 1.1, 1.2, 1.3, 2.5, 4.1, 6.1, 6.2, 6.3, 6.4, 6.5_

- [ ] 8. Plan the separate proxy-core follow-up slice
  - Create focused regression coverage for `proxyRouter`, `recordRequest`, stream finalization, account selection, and pool cache/in-flight state.
  - Design and implement a separate approved slice for `proxy/index.ts`, `proxy/pool.ts`, and eventually the BYOK provider transports; do not combine it with provider/account relocation.
  - _Requirements: 5.1, 5.2, 5.3, 5.4_
