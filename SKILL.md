---
name: sol-luna-deepseek-router
description: Use when Sol needs to delegate repository coding or file work between its native Luna subagent and a DeepSeek DSH executor according to DeepSeek's official peak and valley price schedule, and when the optional Codex plugin is loaded for guarded DSH ownership, traces, or active-chat peak/valley notices.
metadata:
  short-description: Sol 主控 · Luna/DeepSeek 峰谷分工
---

# Sol 主控 · Luna/DeepSeek 峰谷分工

Keep Sol as the user-facing lead and owner of the conversation context. By default, delegate project file search and reading, code or document changes, debugging, and verification using the deterministic route below. Follow a user's explicit request for Sol to work directly. Handle ordinary Q&A directly; do not call the route script for it.

## One routing skill, optional plugin

The root `SKILL.md` is the canonical routing policy. Install it once as `sol-luna-deepseek-router` and keep exactly one enabled routing skill.

The optional Codex plugin adds the guarded MCP wrapper, real DSH event access, `dsh_trace`, and local lifecycle hooks. It does not add a second scheduler, agent loop, or bundled skill: the plugin package has no `skills/` directory and no `skills` manifest entry. Codex plugin packaging auto-discovers `hooks/hooks.json`; no manifest `hooks` pointer is required. Those hooks remain untrusted until a human reviews and approves them in `/hooks`; never assume or fabricate trusted status. The root standalone skill is the only routing policy.

After the initial plugin installation or a plugin update, Codex may need a plugin reload or app restart to discover MCP tools and hooks. Do not open a new chat merely to switch between Luna and DeepSeek at a peak/valley boundary; keep the current conversation, and let the next new task use the current route.

When the plugin MCP tools are loaded, prefer them. Use the PowerShell shell helper only when the plugin tools are unavailable, and only for the current old chat.

## Route a task

Sol first identifies the user's intent and chooses whether the request is suitable for delegation. Do not pass natural-language prompts to the route script for interpretation: it only evaluates the published schedule and explicit executor preferences.

Use the bundled `scripts/route.mjs` before dispatching a new coding task. By default it selects native Luna during DeepSeek's weekday peak windows and DSH/DeepSeek during valley time. `Asia/Shanghai` is the default timezone. Peak intervals are 09:00–12:00 and 14:00–18:00 China time on weekdays, excluding official Chinese public holidays. Weekends remain valley even when China schedules a make-up workday. The bundled calendar covers 2026. For other years the script selects DeepSeek in known valley hours; during a weekday candidate peak it conservatively selects Luna because the holiday calendar is missing.

Honor an explicit one-task user choice with `--executor luna` or `--executor deepseek`; it outranks a saved chat override. A saved override outranks the automatic schedule. Set one with `--set-session-executor luna|deepseek`, clear it with `--set-session-executor auto` or `--reset-session`, and use `--session $env:CODEX_THREAD_ID` for this Codex chat. If the host does not expose `CODEX_THREAD_ID` and the user wants an ongoing preference, keep it in Sol's current-chat context and pass `--executor deepseek` or `--executor luna` for each relevant task; do not invent a shared label or claim a disk-persistent preference. State is stored per user under LocalAppData with only a hash of the session ID, the executor choice, and a timestamp.

Examples (run from the skill directory; add `--session` only when a stable chat ID is available):

```powershell
node .\scripts\route.mjs --json
node .\scripts\route.mjs --json --executor deepseek
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --set-session-executor luna
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --reset-session
```

## Active-chat peak/valley notices

The plugin hook runs `scripts/route-hook.mjs` on `UserPromptSubmit` and `PreToolUse` with the supported quoted command `node "${PLUGIN_ROOT}/scripts/route-hook.mjs"`. The hook evaluates `scripts/route.mjs` locally and injects a short `additionalContext` notice. It makes no network call, starts no child process, and calls no model.

The notice is sent once on the first observation for a chat and then only when the effective phase, executor, or override source changes. It does not repeat for the same phase across prompt and tool events. A manual one-task choice or sticky chat override wins, and the notice reports the effective executor and source. The hook does not create a new chat, start an idle turn, poll in the background, or interrupt an executing task. An idle chat receives nothing until its next prompt or tool call; only a new task should use the new route, and a running task may finish after a peak boundary. `additionalContext` is model-visible context, not a UI banner.

Per-chat state lives under `%LOCALAPPDATA%\sol-luna-deepseek-router\hook-state`; filenames are hashes, updates are atomic, and a short-lived lock deduplicates concurrent hooks. If state is unavailable, the hook stays silent and does not block the turn. Set `SOL_LUNA_ROUTE_HOOK_DEBUG=1` to see hook errors on stderr.

Identity limits matter. Hook payloads expose `session_id` and `model`, not a reliable main/subagent role. The hook suppresses model names containing `luna`, so native Luna child turns are ignored; a main chat intentionally running Luna is also silent, and a child with an unrecognized model name could receive a notice. Notification state stays keyed by the hook `session_id`. Manual override lookup prefers an inherited `CODEX_THREAD_ID` and falls back to `session_id`; those IDs are not proven identical on every build. Ownership-critical work should use the plugin MCP path with trusted request `_meta.threadId`.

The notice does not verify the DSH provider or model. Before claiming valley pricing, verify provider `deepseek-official` and a DeepSeek model.

## If the route is luna

Use the native Luna subagent supported by the current Codex host. Preserve Sol's context by giving Luna a scoped brief and reviewing its changes and test evidence. Prefer these known mappings when the tool supports them: `gpt-6.1-sol` or `gpt-6-sol` to `gpt-6-luna`, and `gpt-5.6-sol` to `gpt-5.6-luna`, with medium reasoning effort. Check the tool's supported model IDs first. If Sol uses a newer or unmapped model, choose a Luna model the tool actually supports, preferring the user's stated choice or the only available Luna; never invent an ID or change Sol's main model. If several Luna models are available and no safe preference is clear, report the choice needed.

## If the route is deepseek

Prefer the plugin wrapper tools when they are loaded: `dsh_start`, `dsh_status`, `dsh_wait`, `dsh_followup`, `dsh_list`, `dsh_interrupt`, `dsh_close`, `dsh_rename`, `dsh_events`, and `dsh_trace`. Every call must carry Codex's trusted request `_meta.threadId`; missing identity fails before DSH, and identity values in tool arguments are rejected. A write-capable start or follow-up holds a same-workspace writer lease; read-only agents may run in parallel. `dsh_list` is already filtered to the current chat.

`dsh_trace` returns a clickable loopback URL to a read-only snapshot of real DSH events, protected by a short-lived ticket. Each exchange creates a per-view path (`/trace/view/<view-id>/`) and a per-view HttpOnly cookie, so multiple trace tabs for different agents coexist and cross-session detail links are denied. Detail links are clickable (`查看详情`); browser labels, help, and errors are Simplified Chinese while commands and code stay unchanged. It is not a live terminal, control channel, or native Codex child panel. DSH agents run in an external runtime and cannot appear as native Codex children. Call `dsh_trace` again for a fresh snapshot if the ticket expires; never put credentials or tickets in the repository.

Every `dsh_start` and every `dsh_followup` message receives exactly one appended instruction: `用户可见的进度与最终报告必须使用简体中文；代码、命令和内部 GPT-DeepSeek 通信可保持原文。` The original task stays a verbatim prefix. Follow-ups to agents created before this contract also receive the marker once, so do not restart a conversation merely to change output language. Do not append the marker twice.

The client prefers an exact, verified `dsh-subagent-mcp@0.7.0` entrypoint from an explicit package-root override, an npm global location, or the trusted npm npx cache; it never searches the current directory or its `node_modules` and never executes an implicit local package. It falls back to the pinned npx command. Do not change the backend version, provider, model, or reasoning effort silently, and never retry a mutating call automatically. Measured warm `dsh_status` is about 280–290 ms after the npx removal (versus about 1.3 s before); the plugin ownership hook adds about 5 ms. The remaining cost is fresh CLI/MCP startup; the 2–5 ms bridge floor is not used because persistent reuse would introduce unsafe replay/lifecycle risk.

If the plugin tools are not loaded, use the upstream DSH bridge through the PowerShell 7.3+ shell helper for the current old chat. The bridge's documented default is provider `deepseek-official`, model `deepseek-flash`; pass those explicitly when the MCP tool accepts them. If a different DeepSeek model is requested, pass its exact model only through an interface that supports it. The helper calls the published 0.7.0 MCP tools over stdio, uses the same DeepSeek defaults, and does not implement a separate agent loop. It requires PowerShell 7.3+, Node.js 24+, and npm.

```powershell
& .\scripts\dsh-agent.ps1 start --task "Implement the accepted task and run its focused tests." --cwd (Get-Location).Path --permission workspace-write
& .\scripts\dsh-agent.ps1 wait AGENT_ID
& .\scripts\dsh-agent.ps1 followup AGENT_ID --task "Fix the reported test failure and rerun that test."
```

DSH work has its own conversation and filesystem execution; send it the relevant goal, repository location, constraints, and acceptance evidence without forwarding unrelated Sol history. Continue the same DSH agent for follow-up fixes on that task; start a new agent for unrelated work. If `dsh_start` returns an agent ID, retain it. A timeout or lost connection is not proof that work stopped: wait or read the result by the same ID, and never start a duplicate just because waiting timed out. A started task may finish after a peak window; do not kill it solely because the schedule changed. Re-evaluate the next new task.

Never print or copy API credentials. If DSH is missing credentials, has a different provider, or cannot run the requested model, report the exact limitation and wait for direction. Do not silently reroute a selected DeepSeek task to Luna or another provider. A reference workflow suggests native Responses global routing may be an alternative, but native DeepSeek spawning on Windows is unverified; do not install that reference or change the global model, provider, or base URL as part of this router.

## Completion

Use `dsh_wait` as the reliable completion path. Native Codex completion callbacks are not assumed to work in every host build. `dsh_trace` is a read-only snapshot for inspection, not a completion signal or control channel. Sol remains responsible for reviewing the returned result, checking the working tree, and reporting what was actually validated.

## Delegation contract

Use one executor by default. Split work only when tasks are independent, and assign each changed file to one writer. Give the executor the exact scope, constraints, and acceptance checks; it must not invoke this router recursively or silently hand the task to another model. Preserve the user's authorization boundaries and do not commit, push, or deploy unless that action is explicitly authorized. Ask the executor to return a concise status, absolute changed-file paths and key diff, actual test commands and exit codes, and anything still unverified; keep detailed logs at their source. Sol audits the relevant diff and evidence without rescanning the whole repository.

## Price and calendar sources

- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [2026 State Council public holiday notice](https://zwfw.gansu.gov.cn/huixian/zczx/tzgg/art/2025/art_715c16a75e4d4c289c295e77772c7274.html)
- [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
- DSH executor: [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp), published version 0.7.0 under the [MIT license](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp/blob/main/LICENSE). The repository also carries an optional idempotent Windows `windowsHide` patch for the managed 0.7.0 install, `scripts/patch-backend-windows.mjs`; when applied, the managed runtime contains a local change beyond upstream. The patch does not alter the agent loop, service lifecycle, `package.json`, or license.
