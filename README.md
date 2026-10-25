# Sol-led Codex Executor Router

[English](README.md) / [简体中文](README_cn.md)

One routing skill and an optional Codex plugin. Sol keeps the current conversation, breaks down work, makes decisions, and reviews results. Repository searches, file edits, debugging, and tests go to native Luna during peak hours or an isolated native DeepSeek child during valley hours. Ordinary Q&A stays with Sol; users can explicitly request direct execution.

## Status

**0.12.3 is installed and usable on the maintained local deployment**, with scoped verification of routing, the settings UI, and native delegation. Its source is in [PR #1](https://github.com/Puipipi/sol-luna-deepseek-router/pull/1) / `feat/native-api-integration-20261018`; GitHub default **main still contains 0.10.4**, which this page documents. Match documentation to your source version; custom API end-to-end acceptance is tracked separately, and local usability does not imply every provider has been verified.

## Components

| Component | Purpose | Entry point |
| --- | --- | --- |
| One routing skill | Sol-led delegation and deterministic peak/valley selection | [SKILL.md](SKILL.md) |
| Route helper | Schedule, one-task choice, and chat-scoped overrides | [scripts/route.mjs](scripts/route.mjs) |
| Optional plugin | MCP wrapper, active-chat hooks, and DSH trace | [PLUGIN.md](PLUGIN.md) |
| Isolated native backend | Patched CLI, dedicated DeepSeek role/provider/catalog, owned gateway lifecycle | [Installation guide](docs/native-isolated-install.md) |
| Legacy DSH compatibility | External bridge with chat ownership and workspace writer leases | [DSH client](scripts/dsh-mcp-client.mjs) |

The formal native DeepSeek route uses the isolated `native_deepseek` role and its own `deepseek-native` provider and catalog. Sol and native Luna retain their normal provider and live model catalog. The native backend and external DSH bridge are separate execution paths; DSH is never an automatic fallback.

## Documentation and reports

Reports are dated, host-specific evidence with independent acceptance scopes. For the historical main / 0.10.4 baseline, full desktop acceptance remains pending; this does not describe the usability of the maintained 0.12.3 deployment.

| Document | Scope |
| --- | --- |
| [Plugin guide](PLUGIN.md) | Packaging, lifecycle, and standalone skill synchronization |
| [Isolated native installation](docs/native-isolated-install.md) | Explicit prepare, status, activate, and rollback workflow |
| [CLI build notes](docs/native-isolated-cli-build.md) | Matching custom CLI prerequisites and build boundaries |
| [Formal installation record](docs/native-formal-install-2026-10-18.md) | Observed installation on one host |
| [Stable gateway acceptance](docs/native-stable-gateway-acceptance-2026-10-18.md) | Owned task, source switch, and process evidence |
| [Partial desktop acceptance](docs/native-desktop-partial-acceptance-2026-10-18.md) | Accepted observations and remaining desktop gaps |
| [Real multi-chat acceptance](docs/native-real-multichat-acceptance-2026-10-18.md) | Luna delegation across two parent chats and its results |
| [Live route-hook acceptance](docs/native-live-route-hook-acceptance-2026-10-18.md) | Active-chat route notice evidence |
| [Partial fault acceptance](docs/native-formal-fault-acceptance-2026-10-18.md) | Recovery cases and remaining limitations |
| [0.10.4 package record](docs/native-plugin-update-0.10.4-2026-10-18.md) | Package update evidence |

## Installation

The Windows helper requires **Node.js 24+**, npm, and **PowerShell 7.3+**.

1. Install the canonical skill bundle into `~/.codex/skills/sol-luna-deepseek-router`. Keep `SKILL.md`, `scripts/`, and referenced `docs/` together; copying only the skill file is incomplete. Keep exactly one routing skill.
2. Optionally install the plugin from a local clone:

```powershell
codex plugin marketplace add <repo-root>
codex plugin add sol-luna-deepseek-router@sol-luna
```

For a local marketplace, rerun the second command after updating its source. Synchronize the standalone skill separately. Reload plugins or restart Codex after installation or updates. The plugin has no bundled skill; it auto-discovers `hooks/hooks.json`, and no manifest `hooks` pointer is required. Hooks are initially untrusted: inspect and approve them in `/hooks`.

3. For native DeepSeek, follow the [isolated installation guide](docs/native-isolated-install.md). This requires a matching patched Codex CLI and dedicated gateway setup; installing the skill or plugin alone is insufficient. Perform setup only when requested, then fully restart Codex after activation. Other hosts require local verification.
4. Only if you explicitly need legacy DSH compatibility, install the pinned external bridge without its companion skill:

```powershell
npx --yes dsh-subagent-mcp@0.7.0 setup --no-skill --service background
```

The external [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp) bridge defaults to `deepseek-official` / `deepseek-flash`. Its service and account setup are separate from native DeepSeek.

## Usage

Run these commands from the installed skill directory or repository root. They evaluate or update routing state without calling a model:

```powershell
node .\scripts\route.mjs --json
node .\scripts\route.mjs --json --executor deepseek
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --set-session-executor luna
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --reset-session
```

The bundled 2026 rules were based on the [DeepSeek pricing schedule](https://api-docs.deepseek.com/quick_start/pricing/) and [2026 public holiday notice](https://zwfw.gansu.gov.cn/huixian/zczx/tzgg/art/2025/art_715c16a75e4d4c289c295e77772c7274.html): weekday peak windows are UTC 01:00–04:00 and 06:00–10:00 (China time 09:00–12:00 and 14:00–18:00), excluding Chinese holidays. Weekend make-up workdays remain valley. Unknown calendar years conservatively select Luna during candidate weekday peak hours. Manual one-task choice wins over chat override, which wins over the schedule. Check provider pricing for current eligibility.

Preserve the current conversation; do not open a new chat merely to cross a peak/valley boundary. New tasks use the current route; running tasks may finish. Report executor failures without silently substituting a backend.

## Checks

These existing checks use local fixtures or fake backends; they need no paid inference or live DSH daemon:

```powershell
node .\tests\route.test.mjs
node .\tests\route-hook.test.mjs
node .\tests\docs.test.mjs
node .\tests\plugin-manifest.test.mjs
node .\tests\plugin-state.test.mjs
node .\tests\plugin-cross-process.test.mjs
node .\tests\plugin-trace.test.mjs
node .\tests\plugin-mcp.test.mjs
node .\tests\plugin-client.test.mjs
node .\tests\dsh-mcp-client.test.mjs
node .\scripts\patch-backend-windows.test.mjs
pwsh -NoProfile -File .\tests\dsh-agent-helper.test.ps1
```

See [CI](.github/workflows/tests.yml) for the wider platform matrix and native tests. The opt-in `native-config-read.test.mjs` gate needs a local Codex executable and model cache; it is not a portable quick check or proof of desktop acceptance.

## Boundaries and conventions

- The hook uses `node "${PLUGIN_ROOT}/scripts/route-hook.mjs"`. It does not create a new chat or wake an idle chat; it emits model-visible context on supported events, not a guaranteed UI banner. Model/role detection and session-ID matching have host-specific limits.
- Plugin MCP calls require trusted `_meta.threadId`; write-capable DSH work holds a workspace lease. `dsh_trace` is a read-only snapshot of real events. External agents do not become a native Codex child or a native subagent panel.
- The formal gateway rejects GPT/unknown models and encrypted collaboration input before any upstream call; its relay cap is forced to zero. Shared-root gateway and transparent relay material is historical compatibility. See the [installer](docs/native-isolated-install.md) for the formal path.
- Keep credentials, trace tickets, local user paths, and private logs out of commits. State uses hashed chat identities. Never print API credentials.

## Contributing and provenance

Keep changes scoped to routing, delegation, and compatibility. Separate source tests, installation evidence, and observed desktop behavior; report limits with dated evidence. Run checks relevant to a change before submitting a pull request.

The Sol-led pattern draws on [madman8228/sol-luna-delivery](https://github.com/madman8228/sol-luna-delivery) and [dy0000/sol-plan-luna-execute](https://github.com/dy0000/sol-plan-luna-execute). Legacy DSH uses the external [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp) project. Codex [hooks](https://learn.chatgpt.com/docs/hooks) and [plugin packaging](https://developers.openai.com/plugins/build/plugins) remain host integration prerequisites.

## License

[MIT](LICENSE) for this repository. Upstream projects retain their own licenses; the custom Codex CLI is based on upstream Codex under Apache-2.0.
