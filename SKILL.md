---
name: sol-luna-deepseek-router
description: Use when Sol keeps the main conversation while delegating repository coding or file work to native Luna, an isolated native DeepSeek child, or a user-configured OpenAI-compatible API profile under the peak/valley schedule.
metadata:
  short-description: Sol 主控 · 多模型峰谷子代理
---

# Sol 主控 · 多模型峰谷子代理

Sol remains the user-facing lead and owns the conversation context. Handle ordinary Q&A directly. Delegate project search, edits, debugging, and verification by the deterministic route below unless the user asks Sol to work directly. The main model, main provider, and current chat are never changed by this skill.

## One routing skill, optional plugin

The root `SKILL.md` is the canonical routing policy. Install it once as `sol-luna-deepseek-router` and keep exactly one enabled routing skill.

The optional Codex plugin adds guarded DSH compatibility tools, real DSH event access, and `dsh_trace`, plus local lifecycle hooks. The plugin has no `skills/` directory and does not add a second scheduler, agent loop, or bundled skill; it declares no `skills` manifest entry. Codex auto-discovers `hooks/hooks.json`; no manifest `hooks` pointer is required. Hooks remain untrusted until a human reviews them in `/hooks`; never assume or fabricate trusted status. Do not open a new chat merely to switch at a peak boundary; preserve the current conversation.

The root standalone skill is the only routing policy. The plugin's DSH/MCP path is explicit legacy compatibility, never an automatic fallback from native DeepSeek.

## Isolated native backend prerequisites

The formal native DeepSeek route uses the patched, versioned Codex CLI backend described in [the isolated CLI build note](docs/native-isolated-cli-build.md). It gives the `native_deepseek` child role its own `deepseek-native` provider and its own `sol-luna-native-models.json` catalog. The parent session and native Luna continue using their normal provider and live model catalog; do not set root `openai_base_url` or a global `model_catalog_json` for this route.

The formal gateway is started with `--deepseek-only`: it accepts DeepSeek models only, rejects GPT/unknown models and encrypted collaboration inputs, and disables GPT relay even when a caller supplies OpenAI authentication. Health and dispatch checks require `deepseek_only=true`, `relay_allowed=false`, and the owned Task Scheduler task in `Running` state. These source-level behaviors are covered by loopback and mock tests; those tests alone do not establish real API or desktop acceptance. Host-specific 0.10.5 API and desktop observations are separately recorded in [the desktop acceptance record](docs/native-desktop-acceptance-0.10.5-2026-10-18.md).

The source includes the installer orchestration entrypoints `native-isolated-install.mjs prepare`, `activate`, `rollback`, and `status`, documented in [the isolated installer guide](docs/native-isolated-install.md). They are a setup path only when the user explicitly asks to set up or activate the isolated backend; that request authorizes the documented steps without another approval prompt. Ordinary task routing must never run them, change global configuration or environment, install a runtime, or restart Codex. The host-specific installation and stable gateway source acceptance are recorded in [the installation record](docs/native-formal-install-2026-10-18.md) and [stable gateway acceptance](docs/native-stable-gateway-acceptance-2026-10-18.md). The later 0.10.5 full-restart and host-specific desktop evidence is in [the desktop acceptance record](docs/native-desktop-acceptance-0.10.5-2026-10-18.md); other hosts require local verification. Package/skill synchronization and publication status are tracked separately from the observed desktop behavior. The older `native-install.mjs` shared-root gateway path is retained for historical compatibility only; it is not the formal native DeepSeek setup path.

## Route a task

Run the bundled `scripts/route.mjs` before dispatching a new coding task. By default it selects native Luna during DeepSeek weekday peak windows and native DeepSeek during valley time. `Asia/Shanghai` is the default timezone. Peak intervals are 09:00–12:00 and 14:00–18:00 China time on weekdays, excluding official Chinese public holidays. Weekends remain valley even on China make-up workdays. The bundled calendar covers 2026; for other years, known valley hours use DeepSeek and candidate weekday peaks conservatively use Luna.

An explicit one-task choice (`--executor luna|deepseek|<profileId>|<alias>`) wins. A saved chat override outranks the automatic schedule. Set it with `--set-session-executor luna|deepseek|<profileId>|<alias>`, clear it with `--set-session-executor auto` or `--reset-session`, and pass `--session $env:CODEX_THREAD_ID` only when that stable chat ID is available. If the host exposes no stable ID, keep the preference in Sol's current-chat context and pass a one-task override; do not invent shared identity. An ordinary one-task API choice does not change the global fixed configuration.

```powershell
node .\scripts\route.mjs --json
node .\scripts\route.mjs --json --executor deepseek
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --set-session-executor luna
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --reset-session
```

For an API profile or alias, resolve and gate it explicitly:

```powershell
node .\scripts\route.mjs --json --executor <profileId-or-alias>
node .\scripts\native-agent.mjs --executor <profileId> --json
```

The gate must pass before spawn. The returned `native_spawn` supplies
`agent_type: native_api_<profileId>`, `provider_id: api-native-<profileId>`,
`fork_turns: "none"`, and the exact resolved model; omit `model` in
`spawn_agent`. If the gate fails because the runtime is the old 6ec build or
the profile is not installed, report that failure and stop. Do not replace it
with another executor or a hand-edited journal.

Pass only `task_name`, `agent_type`, `fork_turns: "none"`, and `message` to
`spawn_agent`; do not pass the whole `native_spawn` object. `provider_id`,
`profile_id`, and `resolved_model` are metadata for state recording, not
spawn-schema arguments:

```json
{
  "task_name": "bounded_api_task",
  "agent_type": "native_api_<24hex>",
  "fork_turns": "none",
  "message": "<task and acceptance checks>"
}
```

For native subagents, `task_name` must use only lowercase ASCII letters,
digits, and underscores. Do not use hyphens in `task_name`; profile IDs,
models, and aliases are separate fields and may retain their own valid syntax.

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

The selected role supplies backend, model, and reasoning configuration. This route fixes the native DeepSeek role at `high`; it does not inherit the Sol parent’s `xhigh` setting, so an `xhigh` parent request still runs this child at `high`. The current spawn path exposes no per-child effort control. Keep the language instruction in every child message as well, so progress and final output remain predictable across role loading and follow-up turns.

## If the route is a configured API profile

Use the immutable profile ID from the route/gate result, not a mutable label.
For a write-capable API child, reserve and bind the full executor identity:

```powershell
$taskNonce = [guid]::NewGuid().ToString()
node .\scripts\native-state.mjs reserve --workspace (Get-Location).Path --task-nonce $taskNonce --model <exact-model>
# spawn_agent with task_name, agent_type, fork_turns:none, message; omit model
node .\scripts\native-state.mjs bind --workspace (Get-Location).Path --task-nonce $taskNonce `
  --child CHILD_THREAD_ID --model <exact-model> --executor api `
  --profile-id <24hex> --role native_api_<24hex> --provider-id api-native-<24hex>
```

For a read-only API child, record the actual child without taking a writer
lease, then read the binding and complete only that task record:

```powershell
$taskNonce = [guid]::NewGuid().ToString()
node .\scripts\native-state.mjs record --workspace (Get-Location).Path --task-nonce $taskNonce `
  --child CHILD_THREAD_ID --model <exact-model> --executor api `
  --profile-id <24hex> --role native_api_<24hex> --provider-id api-native-<24hex>
node .\scripts\native-state.mjs binding --child CHILD_THREAD_ID
node .\scripts\native-state.mjs complete --child CHILD_THREAD_ID --status completed
```

`record` and `complete` use the trusted `CODEX_THREAD_ID`; they never acquire or
release the workspace writer lease. A different parent is rejected, and a
different model/profile cannot overwrite the original binding. For every
follow-up, read `binding`, rerun `native-agent.mjs --executor <profileId>
--json` against that original profile, and continue the same child with
`followup_task`. A global profile change affects only new children. Old
profiles cannot be removed by the settings schema; if the old profile gate
fails, report the failure and do not silently substitute the new profile.

Only when the user explicitly asks for a global fixed API configuration, update
`mode` and `fixedExecutor` in one CAS call:

```json
{
  "set": {"mode": "fixed", "fixedExecutor": "<24hex>"},
  "expectedSha256": "<snapshot revision>"
}
```

Use the MCP `router_settings_snapshot` revision and `router_settings_update`;
saving configuration is separate from an explicit Apply and a full Codex
restart. See [native API executors](docs/native-api-executors.md) and the
[router settings MCP panel](docs/router-settings-mcp.md).

## If the route is deepseek

Use native Codex collaboration, not DSH, for the formal task. Resolve the dedicated child role first:

```powershell
node .\scripts\native-agent.mjs --executor deepseek --json
```

Before emitting the native spawn parameters, this command reads `SOL_LUNA_NATIVE_INSTALL_JOURNAL` from the managed user environment and verifies activated config, environment, launcher and owned Task Scheduler task, then starts/checks the isolated gateway. A private experiment may explicitly pass `--install-journal <path>` to override that environment value; an explicit empty value fails closed. Rerun the same gate immediately before each DeepSeek `followup_task`; if it fails, do not send the follow-up. A missing or unhealthy installation fails closed: do not register a task, start a DSH session, directly spawn the gateway, replay old work, or switch executors. It returns `agent_type: "native_deepseek"`, `fork_turns: "none"`, and an informational `resolved_model: "deepseek/deepseek-flash"`. Call `spawn_agent` with the bounded `task_name`, `agent_type: "native_deepseek"`, and `fork_turns: "none"`; omit `model` so the child role selects its fixed DeepSeek model and `high` reasoning effort, regardless of the Sol parent’s effort setting. Keep the same child for corrections: use native `wait` for completion and `followup_task` for the same child; never spawn a replacement just because an observation window ended. The installer uses a current-user Task Scheduler task to keep the gateway independent of the DSH/Codex child process tree; DSH remains only an explicit legacy workflow and does not create native Codex child sessions. After activation, fully exit and restart Codex for future chats to inherit the new user environment; an already running app does not refresh it.

Apply the shared writer and child-message contract above before this spawn; it applies to both native executors.

The default is one writer per workspace. Different workspaces may run in parallel. Read-only research may skip the writer lease, but a child, task, model, and parent chat must never be reassigned across chats. The native state file stores a hashed parent owner and the child thread ID; `who` filters to the trusted `CODEX_THREAD_ID`. A reservation is not auto-stolen when a short CLI exits: only an explicit `finish`/`release` or a verified terminal task clears it. If a host cannot expose enough native child identity to enforce the lease, say so and keep the task read-only rather than inventing a second scheduler.

## If the route is luna

Use the native Luna subagent supported by the current Codex host. Resolve the model from the actual catalog:

```powershell
node .\scripts\native-agent.mjs --executor luna --main-model $mainModel --json
```

Pass the actual current Sol model in `$mainModel`. The resolver reads the current `CODEX_HOME/models_cache.json`, chooses a listed Luna model, and fails explicitly if none is available. It never invents a model ID or changes Sol's main model. Pass the resolved Luna `model` with `fork_turns: "none"`, wait natively, and continue the same child for fixes. The same reserve → spawn → bind → finish writer lifecycle applies to a write-capable Luna child.

## Active-chat peak/valley notices

The plugin hook runs `scripts/route-hook.mjs` on `UserPromptSubmit` and `PreToolUse` with the supported quoted command `node "${PLUGIN_ROOT}/scripts/route-hook.mjs"`. It evaluates the route locally and injects a short `additionalContext` notice. It makes no network call, starts no child process, and calls no model.

The notice is sent once on the first observation for a chat and only when the effective phase, executor, or override source changes. A manual choice wins, and a sticky chat override outranks the schedule. The hook does not create a new chat, wake an idle chat, poll in the background, or interrupt a running task; only a new task uses the new route. `additionalContext` is model-visible context, not a UI banner. Per-chat state lives under LocalAppData, uses hashed filenames, and fails silently if unavailable. Set `SOL_LUNA_ROUTE_HOOK_DEBUG=1` only for local debugging.

Fixed mode is reported as a fixed executor selection. It does not consult the holiday calendar, never claims an automatic schedule, and repeats only when the fixed API profile changes.

Hook payloads expose `session_id` and `model`, not a reliable main/subagent role. Native Luna and `deepseek/deepseek-flash` child turns are suppressed by model name. A main chat intentionally using those models is therefore also silent. Ownership-critical work uses the native task state and the trusted plugin `_meta.threadId` where available.

## Legacy DSH compatibility

The plugin's MCP tools (`dsh_start`, `dsh_wait`, `dsh_followup`, `dsh_events`, `dsh_trace`, and related tools) remain available only when the user explicitly chooses the external DSH workflow. They use the published `dsh-subagent-mcp@0.7.0` bridge, provider `deepseek-official`, model `deepseek-flash`, and the guarded per-chat ownership/writer leases. They are not the native DeepSeek route and must not silently replace it.

`dsh_trace` is a read-only snapshot of real DSH events, protected by a short-lived ticket and per-view HttpOnly cookie. It is not a live terminal or control channel, and DSH agents cannot appear as native Codex child panels. The browser labels, help, and errors are Simplified Chinese while commands and code stay unchanged.

The DSH helper requires Node.js 24+ and PowerShell 7.3+. Keep credentials out of prompts, logs, the repository, and tool arguments. If the external provider or model is unavailable, report the exact limitation; do not fall back to Luna or another provider silently.

## Completion and evidence

Use native `wait` and `thread/read` for the same child. A timeout means the task may still be running; retain the child handle and never start a duplicate. For DSH legacy work, `dsh_wait` is the reliable completion path. Sol reviews the returned diff, actual test commands and exit codes, and the evidence; do not claim desktop-panel acceptance from an isolated app-server test.

The historical native evidence is recorded in `docs/native-deepseek-acceptance-2026-10-17.md`; it used the earlier shared-provider call contract and does not verify the isolated-role route. The current source includes prepare/activate/rollback/status orchestration, with one host-specific installation in `docs/native-formal-install-2026-10-18.md`, a stable gateway source switch in `docs/native-stable-gateway-acceptance-2026-10-18.md`, and later 0.10.5 desktop observations in `docs/native-desktop-acceptance-0.10.5-2026-10-18.md`. Those observations describe tested host-specific behavior and limits; other hosts require local verification. Package/skill synchronization and publication status are tracked separately from desktop behavior. Do not treat a prepared/configured journal or its static `runtimeObserved=false` diagnostic as the latest runtime observation; consult the dated desktop evidence. Do not treat preparation or configuration alone as desktop acceptance.

The generic OpenAI-compatible API executor backend is described in `docs/native-api-executors.md`. The panel source and this product guidance are integrated; desktop acceptance and final runtime installation remain separate. The installed 0.10.5/6ec runtime predates the new API role patch; do not describe a generic API profile as ready until a matching runtime, restart, and real probe have separate evidence.

默认路径仍是高峰 Luna、低谷 DeepSeek。用户显式选择的 API 配置使用 fixed 模式且不判断时段；只有显式 scheduled 才在既有的 DeepSeek 峰谷日历上使用两个 API 选择器。一次性/粘性显式选择优先；选中的执行器失败时明确报告，不静默回退到 Luna、DeepSeek、另一个 API 或另一个账号。DSH 账号或本地 refs 的既有解析规则保留，失败不会试探其他账号或 provider。保存 JSON 只保存配置；“应用 API 配置”仍需兼容且已安装的 runtime，首次新增 role 后要完整重启 Codex。已有 child 继续使用其不可变 profile。首版所有 API child（Responses 与 Chat Completions）都禁用 Codex 内建 web_search，适配器也不声称强制 provider grammar。状态里的本地网关/凭据可用不等于认证或模型调用通过；旧 6ec runtime 为 `runtimeCompatible:false`，generic API 的真实 role 验收仍待最终 runtime。

官方 DeepSeek API profile（自动账号或手工 env/file）使用官方文档列出的 `none/low/high/max`；官方说明 `none` 会关闭 thinking。`xhigh` 在 API adapter 局部规范为 `high`，有效 `max` 保留；`none` 原样传递，不另造 `off`。非 DeepSeek API 保持其声明的档位，历史 DS 路由行为不变。这里只是官方 wire 规则依据，不代表真实 generic API role 已完成端到端验收。

保持唯一的 canonical skill：`sol-luna-deepseek-router`。后续正式打包的可见显示名统一为“Sol 主控 · 多模型峰谷子代理”；不要另建第二个 skill，不要物理删除旧 cache/backup，保持 registry ID 和目录稳定，避免出现两个 enabled skills。

## Price and calendar sources

- [DeepSeek API pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [2026 State Council public holiday notice](https://zwfw.gansu.gov.cn/huixian/zczx/tzgg/art/2025/art_715c16a75e4d4c289c295e77772c7274.html)
- [Codex hooks documentation](https://learn.chatgpt.com/docs/hooks)
- Legacy DSH executor: [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp), published 0.7.0 under the MIT license.
