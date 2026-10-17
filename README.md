# Sol 主控 · Luna/DeepSeek 峰谷分工

This Codex skill keeps Sol in charge of the current conversation, then routes repository file search and reading, code or document edits, debugging, and tests to native Luna during DeepSeek's official weekday peak windows or to a persistent DSH/DeepSeek executor during valley hours. A deterministic Node.js helper evaluates the schedule; Sol interprets user intent and does not send ordinary Q&A through the router. Sol stays responsible for decisions and review. Users can explicitly ask Sol to work directly.

The schedule follows the [official DeepSeek pricing page](https://api-docs.deepseek.com/quick_start/pricing/): peak windows are UTC 01:00–04:00 and 06:00–10:00 on weekdays, excluding Chinese public holidays. In China time this is 09:00–12:00 and 14:00–18:00. Weekend make-up workdays remain valley. The bundled 2026 holiday dates follow the [State Council notice](https://zwfw.gansu.gov.cn/huixian/zczx/tzgg/art/2025/art_715c16a75e4d4c289c295e77772c7274.html). Unknown calendar years conservatively route candidate weekday peak hours to Luna; known valley hours remain DeepSeek.

The route helper supports one-task executor overrides and chat-scoped sticky overrides. One-task choice outranks a chat override, which outranks the schedule. It stores only a hashed session ID and the selected executor in the current user's LocalAppData. Use Codex's `CODEX_THREAD_ID` as the session key when available; without it, keep a persistent preference in the current Sol chat and pass it as a one-task override instead of creating shared disk state.

The DeepSeek executor is the external [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp) project, pinned to published version 0.7.0 and distributed under [MIT](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp/blob/main/LICENSE). The Windows helper is a thin MCP stdio client over its tools; it does not implement an LLM or coding-tool loop. The bridge defaults to provider `deepseek-official` and model `deepseek-flash`. The published DeepSeek price schedule may not apply to third-party compatible endpoints. Desktop completion callback support is not guaranteed; use `dsh_wait` when needed.

## Use

Run the route script from the skill directory:

```powershell
node .\scripts\route.mjs --json
node .\scripts\route.mjs --json --executor deepseek
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --set-session-executor luna
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --reset-session
```

When Codex has not loaded the DSH MCP tools, the PowerShell 7.3+ wrapper calls the published bridge MCP stdio tools directly. Start returns an agent ID; use the same ID to wait or continue the persisted DSH conversation:

```powershell
& .\scripts\dsh-agent.ps1 start --task "Implement the accepted task and run focused tests." --cwd (Get-Location).Path --permission workspace-write
& .\scripts\dsh-agent.ps1 wait AGENT_ID
& .\scripts\dsh-agent.ps1 followup AGENT_ID --task "Fix the reported test failure and rerun that test."
```

If a wait times out or the caller disconnects, retain the returned agent ID and continue waiting or read the result. Do not dispatch a duplicate task merely because its result was delayed. The route is evaluated when each new task is dispatched; it does not gate every model request. A running task can finish after a peak boundary. A selected executor failure is reported; it is never silently substituted.

## Validate

```powershell
node .\tests\route.test.mjs
pwsh -NoProfile -File .\tests\dsh-agent-helper.test.ps1
```

## Installation

Copy this folder to `~/.codex/skills/sol-luna-deepseek-router`. To use DSH tools, install the upstream bridge at a deliberate setup point with the companion skill disabled:

```powershell
npx --yes dsh-subagent-mcp@0.7.0 setup --no-skill --service background
```

This registers the upstream MCP server and may prepare its managed background service/dependencies. Open a fresh Codex session after MCP configuration changes. Do not run the upstream installer with its default skill installation when this router is active.

Do not put API keys, DSH credentials, user paths, logs, or local configuration backups in this repository.

The original Sol/Luna delegation skill drew on [madman8228/sol-luna-delivery](https://github.com/madman8228/sol-luna-delivery) and [dy0000/sol-plan-luna-execute](https://github.com/dy0000/sol-plan-luna-execute); this router preserves the Sol-led delegation pattern while adding an explicit schedule and DeepSeek execution route.
