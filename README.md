# Sol 主控 · 原生 Luna/DeepSeek 峰谷分工

This repository contains one routing skill and an optional Codex plugin. Sol stays in charge of the current conversation, then routes repository file search and reading, code or document edits, debugging, and tests to native Luna during DeepSeek's official weekday peak windows or to a native DeepSeek child during valley hours. A deterministic Node.js helper evaluates the schedule; Sol interprets user intent and does not send ordinary Q&A through the router. The formal DeepSeek path uses a shared `openai` provider and a hidden loopback gateway; DSH remains explicit legacy compatibility. Sol stays responsible for decisions and review. Users can explicitly ask Sol to work directly.

The standalone root `SKILL.md` is the canonical routing policy. The optional plugin adds the native gateway helpers, a guarded legacy DSH MCP wrapper, real DSH event access, and local lifecycle hooks; it does not add a second scheduler, a second DeepSeek client, another agent loop, or any bundled skill. Install and enable exactly one routing skill: the root standalone scheduler.

## Schedule

The schedule follows the [official DeepSeek pricing page](https://api-docs.deepseek.com/quick_start/pricing/): peak windows are UTC 01:00–04:00 and 06:00–10:00 on weekdays, excluding Chinese public holidays. In China time this is 09:00–12:00 and 14:00–18:00. Weekend make-up workdays remain valley. The bundled 2026 holiday dates follow the [State Council notice](https://zwfw.gansu.gov.cn/huixian/zczx/tzgg/art/2025/art_715c16a75e4d4c289c295e77772c7274.html). Unknown calendar years conservatively route candidate weekday peak hours to Luna; known valley hours remain DeepSeek.

The route helper supports one-task executor overrides and chat-scoped sticky overrides. One-task choice outranks a chat override, which outranks the schedule. It stores only a hashed session ID, the selected executor, and an update timestamp in the current user's LocalAppData. Use Codex's `CODEX_THREAD_ID` as the session key when available; without it, keep a persistent preference in the current Sol chat and pass it as a one-task override instead of creating shared disk state.

## One routing skill, optional plugin

- **Canonical skill:** install the root `SKILL.md` once as `sol-luna-deepseek-router`. It remains the single routing policy.
- **Plugin additions:** the plugin supplies the MCP wrapper, `dsh_trace`, and the active-chat notification hooks. Codex plugin packaging auto-discovers `hooks/hooks.json`; no manifest `hooks` pointer is required.
- **No bundled skill:** the plugin package has no `skills/` directory and declares no `skills` entry. Its job is MCP and hooks only; the root standalone scheduler remains the one routing skill. There is no second copy to enable or deduplicate.
- **Prefer the wrapper:** when the plugin MCP tools are loaded, use them. Use the PowerShell shell helper only when those tools are unavailable and only for the current old chat; do not invent a shared identity or silently move work between chats.

## Active-chat peak/valley notices

`hooks/hooks.json` registers `scripts/route-hook.mjs` for `UserPromptSubmit` and `PreToolUse` with the supported quoted command:

```json
"command": "node \"${PLUGIN_ROOT}/scripts/route-hook.mjs\""
```

The command resolves from the plugin root, so it does not depend on the user's workspace and works when the plugin path contains spaces. The hook imports `scripts/route.mjs` locally; it makes no network call, starts no child process, and calls no model.

The hook injects a concise `hookSpecificOutput.additionalContext` notice:

- once on the first observation for a chat;
- again only when the effective phase, executor, or override source changes;
- never repeatedly for the same phase, including across `UserPromptSubmit` and `PreToolUse`.

A manual one-task choice or sticky chat override wins over the schedule, and the notice reports the effective executor and source. The hook does not create a new chat, start an idle turn, poll in the background, or interrupt an executing task. An idle chat receives nothing until the user or a tool produces the next hook event. Only a new task should use the newly reported route; a running task can finish after a peak boundary.

Per-chat notification state is stored under `%LOCALAPPDATA%\sol-luna-deepseek-router\hook-state`. Filenames are SHA-256 hashes; the state contains only the notice key, timestamp, phase, executor, and source. Updates are atomic and protected by a short-lived lock so concurrent hooks for one chat emit at most one notice. If state is unavailable, the hook exits 0 silently and does not block the turn. Set `SOL_LUNA_ROUTE_HOOK_DEBUG=1` to surface hook errors on stderr. `additionalContext` is model-visible context, not a guaranteed UI banner.

### Model-role and identity limits

Codex hook payloads provide `session_id` and `model`, but not a reliable main-thread/subagent role. The hook suppresses turns whose model name contains `luna`, which covers native Luna child work in this host. A main chat intentionally running a Luna model is therefore also silent. If a host omits `model` or names a child model differently, a child session could receive a notice; notification state remains keyed by the hook `session_id`, so one session cannot consume another session's state.

Manual override lookup prefers an inherited `CODEX_THREAD_ID` and falls back to the hook `session_id`. Those two IDs are not proven identical on every Codex build. If a sticky override set with `CODEX_THREAD_ID` is not seen by a hook whose `session_id` differs, that is an identity limitation, not a schedule result. Ownership-critical work should use the plugin MCP path, which takes identity only from trusted request `_meta.threadId`.

The notice reports the router's schedule decision. It does not verify that the configured DSH provider is `deepseek-official` or that the selected model is a DeepSeek model; verify both before claiming valley pricing.

### Hook trust review and reload

Codex discovers both hooks from `hooks/hooks.json`, but it does not trust them automatically. Open `/hooks`, inspect each discovered command, source, and hash, and trust it explicitly only if you accept it. This repository does not mark hooks trusted, modify the trust store, or bypass that review. Until you approve them, hook notices stay inactive; the routing policy and plugin MCP tools remain usable.

After the initial plugin installation or a plugin update, Codex may need a plugin reload or app restart to discover the new MCP tools and hooks. Do not open a new chat merely to switch between Luna and DeepSeek at a peak/valley boundary. Keep the current conversation; the next new task uses the current route, and a task already running may finish after the boundary.

## Plugin MCP wrapper

The plugin exposes a guarded MCP surface over the published `dsh-subagent-mcp@0.7.0` bridge:

`dsh_start`, `dsh_status`, `dsh_wait`, `dsh_followup`, `dsh_list`, `dsh_interrupt`, `dsh_close`, `dsh_rename`, `dsh_events`, and `dsh_trace`.

Every tool call must carry Codex's trusted request `_meta.threadId`. Missing or blank identity fails before DSH is spawned. Identity values inside tool arguments are rejected. Ownership is durable and hashed; `dsh_list` removes other chats' rows before filtering. A write-capable start or follow-up holds a same-workspace writer lease until the agent is terminal or idle, while read-only agents may run in parallel. The wrapper does not implement an agent loop; it delegates to the published bridge through the existing client.

`dsh_trace` returns a clickable loopback URL to a read-only snapshot of real DSH events. The URL carries a short-lived access ticket, never a DSH, DeepSeek, Codex, or API credential. The ticket is exchanged for an HttpOnly SameSite cookie scoped to a per-view path such as `/trace/view/<view-id>/`, and each view uses its own cookie name, so trace tabs for different agents coexist without overwriting one another. Detail links are clickable (`查看详情`) and remain bound to the same owner/session. The browser labels, help, and error pages are Simplified Chinese; commands and code remain unchanged. It is a snapshot, not a live terminal, control channel, or Codex subagent panel. External DSH agents cannot appear as native Codex children. Call `dsh_trace` again for a fresh snapshot when a ticket expires; legacy unscoped `/trace/view` links return `410`.

## Chinese output contract

Every `dsh_start` and every `dsh_followup` message gets exactly one concise appended instruction:

```text
用户可见的进度与最终报告必须使用简体中文；代码、命令和内部 GPT-DeepSeek 通信可保持原文。
```

The original task text remains a verbatim prefix. A follow-up message receives its own marker even when the agent was started before this contract existed, so pre-existing conversations do not need to be restarted and their context is preserved. A marker already present in the task is not duplicated.

## Measured orchestration overhead and limits

The following read-only measurements used only `dsh_status` / `dsh_events` on the completed agent `ffbbbc39-f3c0-4d78-86cf-b1df492eed14`; no inference or new agent was started. Timings are Windows wall-clock milliseconds, with an already-populated npm cache, so “cold” is the first sample rather than an empty-cache/offline install.

| Path | Cold | Warm median | Samples |
| :--- | ---: | ---: | ---: |
| Old one-shot `runClient` through npx, status | 1314 | 1308 | 1 cold + 5 warm |
| Direct published 0.7 CLI, status | 272 | 298 | 1 + 5 |
| Direct bridge socket, status | 6 | 5 | 1 + 5 |
| Old plugin `dsh_status` through npx | 1403 | 1290 | 1 + 5 |
| New `runClient` with verified 0.7 entrypoint, status | 289 | 280 | 1 + 5 |
| New plugin `dsh_status` | 282 | 287 | 1 + 5 |
| New `runClient` / plugin `dsh_events` | 326 / 326 | 312 / 336 | 1 + 3 each |

The npx resolver was the dominant avoidable cost: about 1.0 s (roughly 77%) per one-shot call. The client now prefers an exact, verified `dsh-subagent-mcp@0.7.0` entrypoint from an explicit `SOL_LUNA_DSH_PACKAGE_ROOT`, an npm global prefix, or the trusted npm npx cache. It never searches the current working directory or its `node_modules`, never executes an implicit local package, and falls back to the pinned `npx --yes dsh-subagent-mcp@0.7.0 mcp` when no trusted copy is found. A different package name/version is rejected. No mutating call is retried automatically.

The plugin ownership hook adds about 5 ms per `dsh_status` call (5 warm samples; total 283 ms vs backend 278 ms median). Each helper call uses two node processes after the change (client + CLI) instead of three (client + npx + CLI); the plugin host is long-lived and adds one child per call instead of two. The remaining ~280 ms is fresh Node/MCP SDK/CLI startup. The direct bridge floor is 2–5 ms, but persistent transport reuse is deliberately not implemented because it would add cross-call lifecycle and mutating-replay risk. Concurrent workers, antivirus, and host load can add variance; these numbers are limits, not guarantees.

## Use

### Route script

Run the route script from the skill directory. The Windows DSH helper requires Node.js 24+, npm, and PowerShell 7.3+.

```powershell
node .\scripts\route.mjs --json
node .\scripts\route.mjs --json --executor deepseek
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --set-session-executor luna
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --reset-session
```

### Prefer plugin tools; shell fallback

When the plugin MCP tools are loaded, prefer `dsh_start`/`dsh_wait`/`dsh_trace` and the other wrapper tools. They bind each agent to the trusted Codex thread and isolate chats. If the MCP tools are not loaded, the PowerShell 7.3+ wrapper calls the published bridge over stdio for the current old chat:

```powershell
& .\scripts\dsh-agent.ps1 start --task "Implement the accepted task and run focused tests." --cwd (Get-Location).Path --permission workspace-write
& .\scripts\dsh-agent.ps1 wait AGENT_ID
& .\scripts\dsh-agent.ps1 followup AGENT_ID --task "Fix the reported test failure and rerun that test."
```

If a wait times out or the caller disconnects, retain the returned agent ID and continue waiting or read the result. Do not dispatch a duplicate task merely because its result was delayed. The route is evaluated when each new task is dispatched; it does not gate every model request. A running task can finish after a peak boundary. A selected executor failure is reported; it is never silently substituted.

## DeepSeek executor and Windows patch

The DeepSeek executor is the external [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp) project, pinned to published version 0.7.0 and distributed under [MIT](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp/blob/main/LICENSE). The helper and plugin are thin MCP stdio clients over its tools; they do not implement an LLM or coding-tool loop. The bridge defaults to provider `deepseek-official` and model `deepseek-flash`. The published DeepSeek price schedule may not apply to third-party compatible endpoints. Desktop completion callback support is not guaranteed; use `dsh_wait` when needed.

This repository also includes an optional idempotent Windows console-window patch, `scripts/patch-backend-windows.mjs`. It changes only the managed 0.7.0 runtime's `spawn(process.execPath, ...)` options by adding `windowsHide: true`; it does not touch the service lifecycle, `package.json`, or the license, and it keeps a verified backup. When that patch is applied, the managed install contains local changes beyond upstream 0.7.0. Run it only at a deliberate maintenance point, not while tasks are active.

## Native gateway (current path)

The native route keeps the main `openai` provider and the current Sol model. A hidden loopback gateway is the only `openai_base_url`; unrecognized model names are forwarded transparently to ChatGPT, while the exact `deepseek/deepseek-flash` slug goes to the official DeepSeek Responses API. GPT authorization stays on GPT; DeepSeek requests receive only the DSH credential read in-process. A native collaboration payload in real GPT ciphertext is relayed once through the signed-in native backend and cached by account+ciphertext; a plaintext DeepSeek payload stored in `encrypted_content` is restored directly without a relay.

```powershell
node .\scripts\native-gateway-manager.mjs start
node .\scripts\native-gateway-manager.mjs status --json
node .\scripts\native-gateway-manager.mjs stop
node .\scripts\native-install.mjs install --dry-run
node .\scripts\native-config-validate.mjs --source-home $env:USERPROFILE\.codex
node .\scripts\native-install.mjs install --autostart
node .\scripts\native-autostart.mjs install
node .\scripts\native-autostart.mjs status
node .\scripts\native-autostart.mjs remove
```

The gateway identity (stable loopback port and capability token) is persisted privately, so a restart reuses the same `openai_base_url`; the manager never replaces the endpoint with a random port. `install` starts the gateway before writing the config and inserts the marker-owned root keys before the first TOML table. `rollback` removes only the managed block and its own prior key values, preserving post-install keys. Windows login startup is provided by a hidden Startup-folder VBS launcher (`native-autostart.mjs install`); it is implemented but not run by this repository's tests.

The native child call is verified with `spawn_agent`, `task_name`, `model: "deepseek/deepseek-flash"`, and `fork_turns: "none"`. Do not pass `agent_type`; current v2 does not expose it. The optional role file remains for compatibility only. Native writer coordination reserves the workspace before spawn, binds the real child, and releases explicitly; it is not tied to a short-lived CLI PID.

The accepted evidence is in `docs/native-deepseek-acceptance-2026-10-17.md`. The desktop-panel UI is not yet verified: the local Node REPL ACL file lock blocks the intended UI check.

The legacy DSH MCP/trace path remains explicit and is never an automatic fallback from native DeepSeek.

## Validate

```powershell
node .\tests\route.test.mjs
node .\tests\route-hook.test.mjs
node .\tests\plugin-state.test.mjs
node .\tests\plugin-cross-process.test.mjs
node .\tests\plugin-trace.test.mjs
node .\tests\plugin-mcp.test.mjs
node .\tests\plugin-client.test.mjs
node .\tests\plugin-manifest.test.mjs
node .\tests\dsh-mcp-client.test.mjs
node .\tests\docs.test.mjs
node .\tests\native-routing.test.mjs
node .\tests\native-relay.test.mjs
node .\tests\native-gateway.test.mjs
node .\tests\native-state.test.mjs
node .\tests\native-agent.test.mjs
node .\tests\native-install.test.mjs
node .\tests\native-manager.test.mjs
node .\tests\native-autostart.test.mjs
node .\tests\native-config-read.test.mjs
node .\scripts\patch-backend-windows.test.mjs
pwsh -NoProfile -File .\tests\dsh-agent-helper.test.ps1
```

The plugin tests use a fake backend and fake MCP children. They do not require a DeepSeek account, a live DSH daemon, or network access. The cross-process suite launches hidden Node workers to prove that one workspace admits only one writer and that separate chat owners survive concurrent durable updates. CI runs hook tests in both jobs and runs plugin tests only when the corresponding files exist.

`native-config-read.test.mjs` is a local pre-install gate, not a default hosted-CI step: it starts the real Codex app-server and requires a local `codex` executable plus `models_cache.json`. CI exposes it only through the opt-in `RUN_NATIVE_CONFIG_READ=true` repository variable; the test fails closed instead of skipping green. The Windows-native gateway tests run in the Windows CI job; no model request is made.

## Installation

### Standalone skill

Copy this folder to `~/.codex/skills/sol-luna-deepseek-router`, or install the root skill through your configured skill workflow. If that skill directory already exists, update it in place; do not add a second routing-skill copy.

### Plugin

Install from the repository marketplace:

```powershell
codex plugin marketplace add <repo-root>
codex plugin add sol-luna-deepseek-router@sol-luna
```

`.agents/plugins/marketplace.json` is portable: its plugin source is `./`, inside the marketplace root, so both a local checkout and a GitHub clone resolve without an absolute path. The plugin manifest is `.codex-plugin/plugin.json`; the MCP companion is `.mcp.json`; hooks are auto-discovered from `hooks/hooks.json`. No manifest `hooks` pointer is required, and the plugin contributes no skill. Keep the standalone root skill as the only routing skill.

After this initial plugin installation or a plugin update, reload plugins or restart Codex so the new MCP tools and hooks are discovered. Do not open a new chat merely to switch peak/valley routes; preserve the current conversation. Codex lists the hooks as untrusted until you review and approve them in `/hooks`.

### Native gateway

At a deliberate setup point, after reviewing the diff:

```powershell
node .\scripts\native-install.mjs install --dry-run
node .\scripts\native-config-validate.mjs --source-home $env:USERPROFILE\.codex
node .\scripts\native-install.mjs install --autostart
node .\scripts\native-gateway-manager.mjs status --json
node .\scripts\native-install.mjs rollback
```

The install command starts the hidden gateway before Codex's first request, writes the merged catalog and the `native_deepseek` compatibility role, and owns only the two root routing keys. It does not change the main model or provider. `--autostart` writes a hidden Windows Startup-folder launcher; do not run it in an environment where login startup is not authorized. The gateway state/identity/logs live under LocalAppData, never in this repository.

### DSH bridge

At a deliberate setup point, install the upstream bridge with the companion skill disabled:

```powershell
npx --yes dsh-subagent-mcp@0.7.0 setup --no-skill --service background
```

This registers the upstream MCP server and may prepare its managed background service/dependencies. Reload Codex once after this MCP configuration change so the server is discovered; do not open a new chat just to change the route. Do not run the upstream installer with its default skill installation when this router is active. On Windows, apply the optional console-hide patch only at a maintenance point if you need it.

## Privacy and state

- Route override state: `%LOCALAPPDATA%\sol-luna-deepseek-router\session-overrides`; hook state: `%LOCALAPPDATA%\sol-luna-deepseek-router\hook-state`; plugin state: `%LOCALAPPDATA%\sol-luna-deepseek-router\plugin`.
- Native gateway identity/state/logs: `%LOCALAPPDATA%\sol-luna-deepseek-router\native-gateway`. The stable token stays in the private identity file and is never printed.
- Raw session/thread IDs are not persisted in hook or plugin state; hashes are used.
- Never put API keys, DSH credentials, user paths, logs, local configuration backups, or trace tickets in this repository.
- Never print or copy API credentials. A selected executor failure is reported, never silently substituted.

The original Sol/Luna delegation skill drew on [madman8228/sol-luna-delivery](https://github.com/madman8228/sol-luna-delivery) and [dy0000/sol-plan-luna-execute](https://github.com/dy0000/sol-plan-luna-execute); this router preserves the Sol-led delegation pattern while adding an explicit schedule and DeepSeek execution route.

## Sources

- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [2026 State Council public holiday notice](https://zwfw.gansu.gov.cn/huixian/zczx/tzgg/art/2025/art_715c16a75e4d4c289c295e77772c7274.html)
- [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
- [Codex plugin packaging](https://developers.openai.com/plugins/build/plugins)
- [dsh-subagent-mcp 0.7.0](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp) and its [license](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp/blob/main/LICENSE)
