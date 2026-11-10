# Multiple Groq keys implementation plan

Follow-up: the reader now assumes independent quotas for all configured keys and
uses all eight concurrently. The separate-organization checkbox was removed.
Legacy vault preference fields remain readable but do not change scheduling.
An integrated pool/queue test confirms eight distinct keys start together; all
104 JavaScript tests and the static build pass.

**Goal:** Save up to eight Groq keys encrypted with the account and distribute preparation work between them.

**Architecture:** Keep legacy single-key vaults readable. Store a validated key list and independent-organization preference inside a version-two encrypted vault. Reuse the existing Groq transport and token budget, sharing one budget by default, or one per key when the reader explicitly identifies independent organizations. Prepare at most four chunks concurrently. Do not retry rate-limit failures through other keys.

**Tech stack:** Existing browser JavaScript, Web Crypto, Supabase Auth metadata, node:test and pytest/Playwright. No new dependencies or service configuration.

**Constraints:** Keep keys masked and out of logs/storage plaintext. Retain language/document cancellation, visible-word priority, selection priority and quota cooldowns across document/key changes. Existing single-key accounts must still work.

- [x] Add failing tests for validated key lists, encrypted multi-key round trips, parallel chunk cancellation and transport routing.
- [x] Implement small connection validator and transport pool; extend vault encoding without migrating existing records on login.
- [x] Extend the preparation queue to bounded concurrent jobs and adapt explicit selection waiting.
- [x] Add minimal masked add/remove key controls to connection/signup and account editing.
- [x] Verify unit tests, real browser account/key flows and reader regressions with mocked provider traffic; build static assets and document shared quota behavior.

Verification: 103 unit tests pass, including legacy vault compatibility, independent/shared budgets, all-job cancellation and longest cooldown preservation. The 40-case browser suite returned 39 passes and one obsolete hidden-control assertion; updating that assertion and rerunning it plus multi-key signup/login/editing returned two passes. The legacy account suite passes after adding an explicit no-rewrite-on-login assertion. Static build passes. Fresh read-only review found no blocking issues; its cooldown recommendation was applied. Work is on codex/multiple-groq-keys; no deployment, commits or provider changes are performed.
