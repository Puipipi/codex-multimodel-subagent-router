---
name: sol-luna-deepseek-router
description: Use when Sol needs to delegate repository coding or file work between its native Luna subagent and a DeepSeek DSH executor according to DeepSeek's official peak and valley price schedule.
metadata:
  short-description: Sol 主控 · Luna/DeepSeek 峰谷分工
---

# Sol 主控 · Luna/DeepSeek 峰谷分工

Keep Sol as the user-facing lead and owner of the conversation context. By default, delegate project file search and reading, code or document changes, debugging, and verification using the deterministic route below. Follow a user's explicit request for Sol to work directly. Handle ordinary Q&A directly; do not call the route script for it.

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

If the route is `luna`, use the native Luna subagent supported by the current Codex host. Preserve Sol's context by giving Luna a scoped brief and reviewing its changes and test evidence. Prefer these known mappings when the tool supports them: `gpt-6.1-sol` or `gpt-6-sol` to `gpt-6-luna`, and `gpt-5.6-sol` to `gpt-5.6-luna`, with medium reasoning effort. Check the tool's supported model IDs first. If Sol uses a newer or unmapped model, choose a Luna model the tool actually supports, preferring the user's stated choice or the only available Luna; never invent an ID or change Sol's main model. If several Luna models are available and no safe preference is clear, report the choice needed.

If the route is `deepseek`, use the upstream DSH bridge when its MCP tools are available. The bridge's documented default is provider `deepseek-official`, model `deepseek-flash`; pass those explicitly when the MCP tool accepts them. If a different DeepSeek model is requested, pass its exact model only through an interface that supports it. The Windows shell helper calls the published 0.7.0 MCP tools over stdio, uses the same DeepSeek defaults, and does not implement a separate agent loop.

```powershell
& .\scripts\dsh-agent.ps1 start --task "Implement the accepted task and run its focused tests." --cwd (Get-Location).Path --permission workspace-write
& .\scripts\dsh-agent.ps1 wait AGENT_ID
& .\scripts\dsh-agent.ps1 wait AGENT_ID
& .\scripts\dsh-agent.ps1 followup AGENT_ID --task "Fix the reported test failure and rerun that test."
```

Prefer the standard DSH MCP tools in a fresh Codex session. DSH work has its own conversation and filesystem execution; send it the relevant goal, repository location, constraints, and acceptance evidence without forwarding unrelated Sol history. Continue the same DSH agent for follow-up fixes on that task; start a new agent for unrelated work. If `dsh_start` returns an agent ID, retain it. A timeout or lost connection is not proof that work stopped: wait or read the result by the same ID, and never start a duplicate just because waiting timed out. A started task may finish after a peak window; do not kill it solely because the schedule changed. Re-evaluate the next new task.

Before claiming valley-price routing, verify that the configured DSH provider is `deepseek-official` and that the selected model is a DeepSeek model. The public schedule applies to DeepSeek's official endpoint; a third-party compatible endpoint may charge differently. Never print or copy API credentials. If DSH is missing credentials, has a different provider, or cannot run the requested model, report the exact limitation and wait for direction. Do not silently reroute a selected DeepSeek task to Luna or another provider.

Completion callbacks depend on Codex App Server integration and are not assumed to work in every Codex Desktop build. Use `dsh_wait` or the helper's `wait` command as the reliable fallback when the callback does not arrive. Sol remains responsible for reviewing the returned result, checking the working tree, and reporting what was actually validated.

## Delegation contract

Use one executor by default. Split work only when tasks are independent, and assign each changed file to one writer. Give the executor the exact scope, constraints, and acceptance checks; it must not invoke this router recursively or silently hand the task to another model. Preserve the user's authorization boundaries and do not commit, push, or deploy unless that action is explicitly authorized. Ask the executor to return a concise status, absolute changed-file paths and key diff, actual test commands and exit codes, and anything still unverified; keep detailed logs at their source. Sol audits the relevant diff and evidence without rescanning the whole repository.

## Price and calendar sources

- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [2026 State Council public holiday notice](https://zwfw.gansu.gov.cn/huixian/zczx/tzgg/art/2025/art_715c16a75e4d4c289c295e77772c7274.html)
- DSH executor: [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp), published version 0.7.0. It is an unmodified MIT-licensed dependency; see its [license](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp/blob/main/LICENSE).
