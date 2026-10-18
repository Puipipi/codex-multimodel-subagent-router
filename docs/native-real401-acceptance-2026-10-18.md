# Native gateway upstream 401 diagnostic

This record documents a completed production-gateway CLI diagnostic using installed plugin source version 0.10.0 (distinct from Codex CLI version 0.163) and a private isolated instance. The run used a fake, non-secret API key and a process-scoped isolated DSH home; it did not read, copy, or modify real DSH credentials.

One request used the expected DeepSeek model. The local gateway returned HTTP 401, matching the official upstream HTTP 401. The request-event-to-upstream-response-event interval was 118 ms within a 30-second observation limit. The startup health check passed, DeepSeek-only routing was enabled, and relay calls stayed at zero. Usage data was absent, so this run does not establish zero token usage or zero cost.

The production config hash and the four gateway production source hashes were unchanged. Shutdown of the exact child process was observed after SIGTERM; private diagnostics and state were retained, and the isolated run directory was not removed.

This verifies only an upstream authentication rejection through a private production-gateway CLI instance. It does not verify Task Scheduler operation, native child acceptance in the Codex UI, a desktop restart, or the complete routing objective. The receipt hash is `316cdd731106eb93dfc9cb5ffc632f47c07231b53e82edb4f598091bcb79f187`.

| Production source | SHA-256 |
| --- | --- |
| `native-gateway.mjs` | `664d1771c6ea0a949c2f93579a6b01c00ba7d9f9a9130af34335d667e65aa587` |
| `native-gateway-manager.mjs` | `042b7c7e97a15a98469a94409987575bf2458100744c814b09d8dcc6f080bcad` |
| `native-routing.mjs` | `cef5726dae3e6f4b8aef8f6ee2815a70e2291edf35a9d3305957647148fb7a4f` |
| `native-credentials.mjs` | `68b089912a8b0d7bd2eabf63514093f4c035cf6d1267e88a8b1b9298048b0519` |
