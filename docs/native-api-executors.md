# Native API executors: lifecycle and dispatch gate

This document describes the generic OpenAI-compatible API executor backend. It
does not change the Sol root provider, the default peak-Luna/valley-DeepSeek
route, the strict DeepSeek gateway, or the plugin's MCP/UI surface.

## Settings and immutable profiles

Settings live in the plugin-owned `native-api/router.json` under
`LOCALAPPDATA/sol-luna-deepseek-router` (or the platform equivalent). The
existing `schemaVersion: 1` shape is unchanged. A profile may now carry an
optional `contextWindow` integer from `1024` to `2000000`.

`contextWindow` participates in the canonical profile definition only when it
is explicitly present. A profile without the field keeps its previous 24-hex
profile ID. When an installed profile omits it, artifact generation uses the
plugin default working budget of `128000` tokens. That default is a plugin
input budget, not a probe or claim about the selected model's real context
limit; users should set a budget appropriate for the model and their tool
payloads, and some models may not fit the current tool context at all.

The generated catalog records `context_window` and `max_context_window` with
the configured budget and `effective_context_window_percent: 85`. It advertises
only the profile's declared reasoning efforts and the profile default. It does
not inherit DeepSeek's 1M-token window or claim a web/search capability.

Settings additions, validation, compare-and-swap writes, and immutable
profiles are implemented in `scripts/native-api-settings.mjs`.

## Generated artifacts

For profile ID `<24hex>`, the installer owns:

- `agents/native_api_<24hex>.toml`: `name`, exact `model`, configured reasoning
  effort, and `unbounded_connection_retries = false`. It carries no credential,
  base URL, provider, catalog, or developer instructions.
- `sol-luna-native-models-<24hex>.json`: exactly one model entry for the exact
  wire model.
- one `[model_providers.api-native-<24hex>]` table inside the owned
  `# sol-luna-native-api` config block. Its base URL is the profile-specific
  loopback URL, it uses `wire_api = "responses"`, and it has no OpenAI auth,
  environment key, embedded headers, query parameters, WebSockets, or retries.

The role provider and catalog are derived from the profile ID by the patched
CLI. A profile edit creates a new ID; old role and catalog files are never
rewritten in place. Installed profiles are recorded in
`native-api/installed-profiles.json`. Installing a new profile preserves every
previous profile artifact.

## Install and service lifecycle

The commands use explicit paths; they do not discover or modify a task by
guessing. `prepare` verifies the runtime, stages a content-addressed API source
bundle, prepares a private gateway identity, snapshots config/role/catalog/
registry/task state, and writes a journal. `activate` writes only the
snapshotted files and registers the independently owned API Task. It does not
start the gateway.

```text
node scripts/native-api-install.mjs prepare \
  --profile-id <24hex> --settings <router.json> --api-dir <native-api> \
  --codex-home <CODEX_HOME> --version-dir <verified-runtime-version> \
  --plugin-root <installed-plugin-root> --journal-path <journal.json>
node scripts/native-api-install.mjs activate --journal-path <journal.json>
node scripts/native-api-install.mjs status --journal-path <journal.json>
node scripts/native-api-install.mjs rollback --journal-path <journal.json>
```

`activate` reports `restartNeeded: true`. New native role/catalog discovery is
not proven hot-reloadable; fully exit and restart the Codex application before
claiming the role is visible. Existing chats are not changed by this install.

The API service is started on demand for a selected profile by the dispatch
gate. The default `auto` plan remains Luna/DeepSeek and does not start an API
service. The API Task is registered without a logon trigger; only the explicit
selected-profile start path launches it. It has its own namespace, ownership
marker, hidden VBS launcher, and health contract:

```text
GET /<token>/_health
{ "ok": true, "pid": <pid>, "api_only": true, "relay_allowed": false }
```

The DeepSeek gateway's `deepseek_only=true` and `relay_allowed=false` contract
is unchanged. The API service is not a relay and does not accept the DeepSeek
identity or health contract.

```text
node scripts/native-api-manager.mjs start|ensure|stop|status \
  --api-dir <dir> --gateway-script <native-api-serve.mjs>
```

Normal dispatch uses the journal's exact Task plan.

## UI integration seam

`scripts/native-api-install.mjs` exports two production functions with these
exact first arguments; UI tests may inject dependencies but must not treat
those mocks as production API acceptance.

```js
const status = await getExecutorStatus({ settings, profileId });
// { installed, runtimeCompatible, restartRequired, gatewayRunning,
//   localHealthy, credentialAvailable, apiVerified: false, detail }

const applied = await applyApiConfiguration({ settings, expectedSha256 });
```

`getExecutorStatus` is read-only. It does not ensure/start the gateway, call a
model, download a runtime, or mutate settings. `gatewayRunning` and
`localHealthy` are local Task/health observations; `localHealthy` does not
prove provider authentication or model output. `apiVerified` stays `false`
until a separate real probe exists. When artifacts are installed,
`restartRequired` is `"unknown"`: a newly applied role needs a full restart,
but this backend has no reliable observation that the running application has
adopted it. Do not turn that unknown into a permanent “must restart” banner or
edit a journal to manufacture an accepted state.

`applyApiConfiguration` is the explicit Apply-button path. It verifies that
the supplied settings were already saved (and the optional `expectedSha256`
still matches), requires an already staged compatible runtime, then applies
the owned role/catalog/provider/Task transaction for the saved profiles. It
does not download or replace the runtime, change the root Sol connection,
restart the application, or call a model. Its successful apply result reports
`restartRequired: true` for a newly applied role; a later status read reports
adoption as `"unknown"` because the application-restart observation is not
available.

Saving JSON never installs by itself. With the 6ec/old-patch runtime,
`runtimeCompatible` is `false` and Apply fails as unsupported rather than
claiming a ready generic API executor.

## Dispatch gate and child binding

`native-agent.mjs` accepts a profile ID or alias only after
`ensureNativeApiDispatch` verifies all of the following:

1. the approved runtime patch hash and staged runtime files;
2. the active API journal and its authoritative source bundle;
3. the immutable profile still matches its installed model/context definition;
4. a usable credential reference (the value is resolved in memory only);
5. the exact owned role and single-model catalog bytes;
6. the owned provider block and loopback URLs, with no root provider/API
   circular reference;
7. the independently owned Task is registered, enabled, and, for a spawn,
   `Running`;
8. live health reports `api_only=true` and `relay_allowed=false` with the
   expected PID.

Any mismatch fails closed. There is no fallback to Luna, DeepSeek, another API,
or the Sol root connection. The API spawn result uses
`agent_type=native_api_<24hex>`, `provider_id=api-native-<24hex>`, the exact
resolved model, and `fork_turns: "none"`; it sends no conflicting `model`
override.

New child state stores an immutable `{executor, profileId, model, role,
providerId}` binding. A follow-up or cold recovery reads that binding rather
than the latest global settings plan. The parent, profile ID, role, provider,
and model cannot be changed on an existing child. Luna/DeepSeek explicit or
sticky choices retain their existing precedence.

## Credentials and protocol limits

`env` and `file` credentials are references; `dsh_account` is allowed only for
the known official DeepSeek origin with the Responses protocol. The verified
acceptance path is the existing default `https://api.deepseek.com` →
`/responses`; a `/v1` account profile may remain loadable for compatibility,
but a known origin does not prove that path works. Local credential status is
not authentication proof. Credential values
are never written to settings, journals, config, roles, catalogs, argv,
prompts, logs, or public receipts. Existing account/manual-key precedence in
the DeepSeek path is unchanged, and no third-party probe is performed.

For official DeepSeek API profiles (account or manual env/file credentials),
reasoning is limited to the documented `none/low/high/max` levels. The
[official Responses API](https://api-docs.deepseek.com/api/create-response/)
and [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
list these effort values, and the
[thinking-mode guide](https://api-docs.deepseek.com/guides/thinking_mode/)
states that `none` disables thinking while `xhigh` maps to `high` and `max` is
preserved. The API adapter therefore maps a requested `xhigh` to `high`,
preserves a valid `max`, and passes `none` through without inventing an
`off` value. Other API profiles retain their declared effort levels. The
historical DeepSeek gateway effort folding is a separate path and is not reused
for generic roles.

These are documented wire rules. They do not prove that a real generic API
role, account credential, gateway, and model endpoint have completed
end-to-end acceptance.

Chat Completions profiles are adapted to a stateless Chat request. Codex's
built-in web search is not representable by that adapter; the gateway reports
an explicit unsupported-parameter error instead of forwarding it. Use a
Responses profile when web search is required. The local smoke fixture disables
web search explicitly.

## Verification and current limits

The current runtime approval hash is
`7f72fee85efecea550249035d2696bf9216cc256b7afc0cabb6ebc0bed0094e0`. Runtime
manifests built with the older `7a5c...` patch (including the installed 6ec
binary) are not accepted by the API dispatch gate. The old binary may still be
used as an adapter-level CLI smoke target, but it is not evidence that a new
native API role passed end-to-end.

Mocked/free tests cover artifacts, install/rollback, Task namespace, health,
gate failures, source-bundle stability, immutable state bindings, and CLI
failure without an install. Windows CI runs the lifecycle tests. Linux CI runs
the pure settings/routing/protocol/artifact tests. The real CLI adapter smoke is
opt-in:

```text
node tests/native-api-cli-smoke.mjs --binary <codex.exe> --sha256 <64-hex>
```

It uses temporary loopback servers, a fail-closed HTTP proxy, and
`windowsHide: true`. It makes no real provider request and does not install or
activate anything. The hosted workflow's opt-in step fails rather than silently
skipping when enabled without both values.

New-role end-to-end acceptance must wait for a build of the current Rust patch,
a full application restart, and a real desktop run. README/SKILL product
onboarding for the generic API panel is a separate next stage; this backend
does not claim that UI or desktop acceptance is complete.
