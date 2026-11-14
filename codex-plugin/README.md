# Codex Multimodel Subagent Router

**Codex 主控 · 多模型峰谷子代理** keeps the current conversation and main model while selecting a native or explicitly configured API child. The active plugin, marketplace, MCP server and standalone skill use `codex-multimodel-subagent-router` (0.13.1 candidate).

Use `$codex-multimodel-subagent-router`. Ordinary Q&A stays with the lead. File search, edits, debugging and verification follow the configured route; the lead reviews the actual diff and evidence. Manual choice, sticky chat selection, fixed/scheduled routing and exact native models keep their existing semantics. A blocked executor is reported; no silent backend substitution occurs.

Read the short [skill](SKILL.md), then load [execution details](references/execution.md) only when dispatching. The five invariants are exact model selection, trusted ownership, workspace writer leases, executor-specific compatibility gates, and durable identity compatibility.

## Evidence and boundaries

See [current capabilities](references/capabilities.md) for the dated evidence table. Source contracts and offline fixtures are separate from current-host observations and unverified execution. On 2026-11-14 the official CLI reported **0.167.0-alpha.4.1**; a native gpt-6.1-sol child read files and returned results. The existing 0.12.8 installation exposed MCP tools/resources and trusted enabled hooks. Separately, official 0.167 isolated-home installation, identity cutover and rollback passed for the 0.13.0 candidate, including MCP enumeration (21 tools) and static settings HTML. Its two hooks remained enabled/untrusted; no human trust was inferred. The daily host remained on 0.12.8 at this baseline. Real-host cutover, GUI interaction and external calls are separate acceptance steps, recorded in local receipts when performed.

The current API compatibility guard is disabled pending validation for this CLI. No current DeepSeek/API/DSH external call was performed. Credentials, configuration, catalog entries and static UI resources are not proof of authentication or inference. Native routing remains independent of the API guard; the global user-off switch still blocks new automatic dispatch. Saving configuration is separate from explicit Apply. Ordinary routing never installs/patches a runtime, starts a gateway outside the approved gate lifecycle or runs Apply.

Old 0.10/0.11 installation, authorization, fault and acceptance records remain in place behind the [history index](references/history/README.md). Old 0.164 patches are not current CLI acceptance.

## Installation identity

Install the standalone skill at `~/.codex/skills/codex-multimodel-subagent-router`, keeping scripts and references together. Exclude `codex-plugin/` from canonical skill deployment to avoid duplicate discovery. The optional plugin has no `skills/` directory or manifest `skills` entry; marketplace source is its generated `codex-plugin/` projection.

For a fresh local marketplace installation:

```powershell
codex plugin marketplace add <repo-root>
codex plugin add codex-multimodel-subagent-router@codex-multimodel-subagent-router
```

Existing installations must use the [identity migration and rollback guide](docs/identity-migration.md). Never install two enabled routing plugins or discover two canonical skills. The old skill directory keeps its scripts for in-flight absolute references; only its SKILL discovery entry is disabled. Old cache is retained.

The durable `sol-luna-deepseek-router` state root and all protocol/schema, profile/role, ownership, lease, nonce, managed marker, task, env and header identities remain unchanged. No state copy, double write, rehash or model/guard/user-switch change is part of this rename.

The plugin auto-discovers `hooks/hooks.json`; no manifest hooks pointer is required. New hook installation does not mark them trusted; use the official `/hooks` review path. A hook notice creates no chat and does not wake an idle chat. It is model-visible status context. DSH is explicit legacy only; its event trace is a snapshot and does not create native Codex child sessions.

Runtime helpers require Node.js 24+. Legacy Windows DSH helpers additionally require PowerShell 7.3+ and the pinned `dsh-subagent-mcp@0.7.0` bridge installed with `--no-skill`. Legacy provider/model are `deepseek-official` / `deepseek-flash`; none is an automatic fallback.

## Local checks and packaging

Run focused offline checks; no paid inference is needed:

```powershell
node tests/docs.test.mjs
node tests/plugin-manifest.test.mjs
node tests/router-identity.test.mjs
node tests/router-identity-migration.test.mjs
node tests/native-state.test.mjs
node tests/native-api-routing.test.mjs
node tests/native-api-settings.test.mjs
node tests/route.test.mjs
node tests/plugin-mcp.test.mjs
node tests/plugin-router-settings.test.mjs
node tests/plugin-distribution.test.mjs
```

The wider fixture suite is listed in [CI](.github/workflows/tests.yml). See [distribution](docs/plugin-distribution.md) for allowlisted packaging from a clean committed source. Generate the plugin projection with `node scripts/package-plugin.mjs --sync --source <repo-root>`; never hand-edit generated copies. Package hashes prove bytes, not installed-host or external-call acceptance.

[MIT](LICENSE). Legacy DSH derives from [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp); the custom CLI is based on upstream Codex under Apache-2.0.
