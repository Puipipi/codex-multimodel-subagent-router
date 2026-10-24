# Router Recovery and Model Selection Progress

## Task 1

- Owner: model UI/routing implementation.
- Scope: settings `enabled`; `same` and exact `native:<slug>` selection; local native model list; API provider presets and explicit mocked model discovery; canonical skill and routing/MCP/UI tests.
- Guardrails: no config/install/service mutation; no real DeepSeek/OpenAI call; keep existing DSH/env/file credentials and immutable profile IDs; do not interrupt existing children.
- Baseline: with isolated `LOCALAPPDATA`, `route.test.mjs` PASS 504, `route-hook.test.mjs` PASS 116, `native-agent.test.mjs` PASS 47, `native-api-settings.test.mjs` PASS 64, `plugin-router-settings.test.mjs` PASS 214.
- Baseline caveat: the first unisolated route runs read the user's existing fixed route and failed expectations. Re-running with a fresh temporary `LOCALAPPDATA` isolated tests and passed; no live settings were changed.
- Red evidence: before production changes, `router-recovery-models.test.mjs` failed because legacy settings lacked the new default `enabled:true`; `native-api-models.test.mjs` failed to import the not-yet-created module. Existing hook assertions also exposed model-name child suppression as incompatible with `same` semantics.
- Green evidence: focused tests pass: `router-recovery-models.test.mjs` PASS 39; `native-api-models.test.mjs` PASS loopback suite; `plugin-mcp.test.mjs` PASS 177 including disabled `dsh_start`/`dsh_followup` no-backend assertions; `route.test.mjs` PASS 504; `route-hook.test.mjs` PASS 116; `native-agent.test.mjs` PASS 49; `native-api-settings.test.mjs` PASS 64; `plugin-router-settings.test.mjs` PASS 215; `native-api-protocol.test.mjs` PASS 36.
- Hook-copy regression: initial updated hook test found the copied plugin fixture omitted the new `native-state.mjs` dependency; the fixture now copies that source and the full hook test passes.
- Safety: all tests used isolated `LOCALAPPDATA`; API model discovery ran against a loopback mock only. No real DeepSeek/OpenAI calls or user configuration changes.
- Task 1 implementation commit: `cd15376b9d2a3d3a9c21702590ca1aec4341f686`.

## Task 1 review fixes

- Review red: added direct `decideRoute` stale-catalog rejection tests; the test initially failed because route returned spawn metadata without reading the model catalog.
- Fix: route now uses the shared `scripts/native-model-catalog.mjs` reader before returning `native_spawn`; disabled routing returns before this read. `native-agent.mjs` re-exports the same catalog helper to preserve existing callers.
- Fix: MCP snapshot `nativeModels.items` now declares exact `value`, `title`, and `reasoningEfforts` fields, disallows extras, and limits effort values. Test checks advertised schema and actual snapshot payload keys.
- Initial hook fixture regression after adding route catalog import exposed its source-copy list; the lightweight shared catalog module is now included in the isolated copied-plugin fixture.
- Green commands (fresh temporary `LOCALAPPDATA`): `node tests/router-recovery-models.test.mjs` PASS 48; `node tests/route.test.mjs` PASS 504; `node tests/route-hook.test.mjs` PASS 116; `node tests/native-agent.test.mjs` PASS 49; `node tests/plugin-router-settings.test.mjs` PASS 215. No network/provider requests.
- Review fixes are committed separately from the Task 1 implementation; see repository history.

## Remaining tasks

- Task 2: stop new background startup and owned idle services when disabled; no running-child interruption.
- Task 3: local reconnect diagnostics.
- Task 4: integrated verification and authorized install/apply/restart evidence.
