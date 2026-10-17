---
name: sol-luna-deepseek-router
description: Use when Sol must keep the main conversation while delegating repository coding or file work to a native Luna subagent or a native DeepSeek child through the peak/valley schedule, the shared openai provider, and the managed loopback gateway.
metadata:
  short-description: Sol 主控 · 原生 Luna/DeepSeek 峰谷分工
---

# Sol 主控 · 原生 Luna/DeepSeek 峰谷分工

Sol remains the user-facing lead and owns the conversation context. Handle ordinary Q&A directly. Delegate project search, edits, debugging, and verification by the deterministic route below unless the user asks Sol to work directly. The main model, main provider, and current chat are never changed by this skill.

## One routing skill, optional plugin

The root `SKILL.md` is the canonical routing policy. Install it once as `sol-luna-deepseek-router` and keep exactly one enabled routing skill.

The optional Codex plugin adds guarded DSH compatibility tools, real DSH event access, and `dsh_trace`, plus local lifecycle hooks. The plugin has no `skills/` directory and does not add a second scheduler, agent loop, or bundled skill; it declares no `skills` manifest entry. Codex auto-discovers `hooks/hooks.json`; no manifest `hooks` pointer is required. Hooks remain untrusted until a human reviews them in `/hooks`; never assume or fabricate trusted status. Do not open a new chat merely to switch at a peak boundary; preserve the current conversation.

The root standalone skill is the only routing policy. The plugin's DSH/MCP path is explicit legacy compatibility, never an automatic fallback from native DeepSeek.

## Native gateway prerequisites

The native route needs one hidden, loopback-only gateway before Codex sends its first model request:

```powershell
node .\scripts\native-gateway-manager.mjs start
node .\scripts\native-gateway-manager.mjs status --json
node .\scripts\native-install.mjs install --dry-run
node .\scripts\native-config-validate.mjs --source-home $env:USERPROFILE\.codex
node .\scripts\native-gateway-manager.mjs stop
node .\scripts\native-autostart.mjs install
node .\scripts\native-autostart.mjs status
```

`native-install.mjs install --dry-run` shows the planned config/catalog/agent changes. A real install inserts the marker-owned `openai_base_url` and `model_catalog_json` keys at the TOML root, before the first table; it preserves the user's `model`, `model_provider`, last table, and every unrelated key. It also merges the existing Sol/Luna catalog and adds the exact `deepseek/deepseek-flash` entry; never hard-code a Sol version. `native-install.mjs rollback` removes only the managed block and restores only the prior values of its own two keys, preserving keys added after installation; it stops the owned gateway. Do not run a real install, change the global config, or restart the user's app as part of ordinary routing.

The gateway reads the existing DSH DeepSeek key in-process only. It never copies the key into the repo, catalog, logs, or tool output. GPT traffic keeps its incoming ChatGPT authorization and is relayed unchanged; unrecognized model names are always transparent GPT traffic. The gateway never takes a writer lease and never blocks ordinary GPT requests; native writer coordination applies only to a write-capable child task.

## Route a task

Run the bundled `scripts/route.mjs` before dispatching a new coding task. By default it selects native Luna during DeepSeek weekday peak windows and native DeepSeek during valley time. `Asia/Shanghai` is the default timezone. Peak intervals are 09:00–12:00 and 14:00–18:00 China time on weekdays, excluding official Chinese public holidays. Weekends remain valley even on China make-up workdays. The bundled calendar covers 2026; for other years, known valley hours use DeepSeek and candidate weekday peaks conservatively use Luna.

An explicit one-task choice (`--executor luna|deepseek`) wins. A saved chat override outranks the automatic schedule. Set it with `--set-session-executor luna|deepseek`, clear it with `--set-session-executor auto` or `--reset-session`, and pass `--session $env:CODEX_THREAD_ID` only when that stable chat ID is available. If the host exposes no stable ID, keep the preference in Sol's current-chat context and pass a one-task override; do not invent shared identity.

```powershell
node .\scripts\route.mjs --json
node .\scripts\route.mjs --json --executor deepseek
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --set-session-executor luna
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --reset-session
```

## Shared native writer and child-message contract

This contract applies equally to native Luna and native DeepSeek write tasks. Reserve before `spawn_agent`, bind the real child immediately after spawn, and release only at explicit finish/terminal. Ownership comes from trusted `CODEX_THREAD_ID`; `--parent` is rejected as a forgery path.

```powershell
$taskNonce = [guid]::NewGuid().ToString()
node .\scripts\native-state.mjs reserve --workspace (Get-Location).Path --task-nonce $taskNonce --model MODEL_SLUG
# spawn_agent now, then bind the real child
node .\scripts\native-state.mjs bind --workspace (Get-Location).Path --task-nonce $taskNonce --child CHILD_THREAD_ID --model MODEL_SLUG
node .\scripts\native-state.mjs finish --workspace (Get-Location).Path --task-nonce $taskNonce --child CHILD_THREAD_ID
```

Every `spawn_agent` and every `followup_task` message must end with exactly this instruction, appended once:

```text
用户可见的进度与最终报告必须使用简体中文；代码、命令和内部 GPT-DeepSeek 通信可保持原文。
```

Do not rely on the role file for this language instruction: the verified v2 spawn had `role=null`, so its Chinese developer instructions did not take effect. Pass the instruction in the child message itself.

## If the route is deepseek

Use native Codex collaboration, not DSH, for the formal task. Resolve the exact child configuration first:

```powershell
node .\scripts\native-agent.mjs --executor deepseek --json
```

It returns `model: "deepseek/deepseek-flash"` and `fork_turns: "none"`. Call `spawn_agent` with `task_name` naming the bounded task, that custom model slug, and `fork_turns: "none"`. Do not pass `agent_type`: the current v2 `spawn_agent` schema does not expose that parameter, and the real P3 role was null. The installer may still write a compatibility role file, but the verified native call uses `task_name`, `model`, and `fork_turns` only. Keep the same child for corrections: use native `wait` for completion and `followup_task` for the same child; never spawn a replacement just because an observation window ended.

Apply the shared writer and child-message contract above before this spawn; it applies to both native executors.

The default is one writer per workspace. Different workspaces may run in parallel. Read-only research may skip the writer lease, but a child, task, model, and parent chat must never be reassigned across chats. The native state file stores a hashed parent owner and the child thread ID; `who` filters to the trusted `CODEX_THREAD_ID`. A reservation is not auto-stolen when a short CLI exits: only an explicit `finish`/`release` or a verified terminal task clears it. If a host cannot expose enough native child identity to enforce the lease, say so and keep the task read-only rather than inventing a second scheduler.

## If the route is luna

Use the native Luna subagent supported by the current Codex host. Resolve the model from the actual catalog:

```powershell
node .\scripts\native-agent.mjs --executor luna --main-model gpt-6.1-sol --json
```

It prefers `gpt-6-luna` for `gpt-6.1-sol`/`gpt-6-sol`, `gpt-5.6-luna` for `gpt-5.6-sol`, and otherwise picks a catalog-supported Luna model. It never invents an ID and never changes Sol's main model. Use `fork_turns: "none"` for the scoped child, wait natively, and continue the same child for fixes. The same reserve → spawn → bind → finish writer lifecycle applies to a write-capable Luna child.

## Active-chat peak/valley notices

The plugin hook runs `scripts/route-hook.mjs` on `UserPromptSubmit` and `PreToolUse` with the supported quoted command `node "${PLUGIN_ROOT}/scripts/route-hook.mjs"`. It evaluates the route locally and injects a short `additionalContext` notice. It makes no network call, starts no child process, and calls no model.

The notice is sent once on the first observation for a chat and only when the effective phase, executor, or override source changes. A manual choice wins, and a sticky chat override outranks the schedule. The hook does not create a new chat, wake an idle chat, poll in the background, or interrupt a running task; only a new task uses the new route. `additionalContext` is model-visible context, not a UI banner. Per-chat state lives under LocalAppData, uses hashed filenames, and fails silently if unavailable. Set `SOL_LUNA_ROUTE_HOOK_DEBUG=1` only for local debugging.

Hook payloads expose `session_id` and `model`, not a reliable main/subagent role. Native Luna and `deepseek/deepseek-flash` child turns are suppressed by model name. A main chat intentionally using those models is therefore also silent. Ownership-critical work uses the native task state and the trusted plugin `_meta.threadId` where available.

## Legacy DSH compatibility

The plugin's MCP tools (`dsh_start`, `dsh_wait`, `dsh_followup`, `dsh_events`, `dsh_trace`, and related tools) remain available only when the user explicitly chooses the external DSH workflow. They use the published `dsh-subagent-mcp@0.7.0` bridge, provider `deepseek-official`, model `deepseek-flash`, and the guarded per-chat ownership/writer leases. They are not the native DeepSeek route and must not silently replace it.

`dsh_trace` is a read-only snapshot of real DSH events, protected by a short-lived ticket and per-view HttpOnly cookie. It is not a live terminal or control channel, and DSH agents cannot appear as native Codex child panels. The browser labels, help, and errors are Simplified Chinese while commands and code stay unchanged.

The DSH helper requires Node.js 24+ and PowerShell 7.3+. Keep credentials out of prompts, logs, the repository, and tool arguments. If the external provider or model is unavailable, report the exact limitation; do not fall back to Luna or another provider silently.

## Completion and evidence

Use native `wait` and `thread/read` for the same child. A timeout means the task may still be running; retain the child handle and never start a duplicate. For DSH legacy work, `dsh_wait` is the reliable completion path. Sol reviews the returned diff, actual test commands and exit codes, and the evidence; do not claim desktop-panel acceptance from an isolated app-server test.

The accepted native evidence for this repository is recorded in `docs/native-deepseek-acceptance-2026-10-17.md`: real child `01a149da-afc5-7451-ac60-a1d23514ea8f`, two turns, exact two-line proof, DeepSeek HTTP 200, and relay usage. The current desktop UI remains unverified because the local Node REPL ACL file lock blocks the intended interface check.

## Price and calendar sources

- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [2026 State Council public holiday notice](https://zwfw.gansu.gov.cn/huixian/zczx/tzgg/art/2025/art_715c16a75e4d4c289c295e77772c7274.html)
- [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
- Legacy DSH executor: [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp), published 0.7.0 under the MIT license.
