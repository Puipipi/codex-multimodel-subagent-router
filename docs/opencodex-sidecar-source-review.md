# opencodex 明文 v2 与 DeepSeek sidecar 源码审阅

**范围与证据级别**：仅静态审阅两份固定源码。两目录均无 `.git`，无法本地核对 commit，按给定值记录：opencodex `6936d9885d8a9bda9301737affcbaf1a4ff00e17`（package 2.88.0，MIT）、deepseek-sidecar `9b47d37f0c3259d016e81d6d2c6bf38ac85a156a`（Apache-2.0）。本机 `bun` 缺失、无 `node_modules`，未运行测试；以下均非 Codex 0.162 原生 UI 验收。

## 一、opencodex 明文 v2：机制

- 独立模块 `src/responses/plaintext-v2-agent-messages.ts`（911 行，零 import）。三个 alias：`spawn_agent→start_delegated_task`、`send_message→deliver_delegated_message`、`followup_task→continue_delegated_task`（14-22）；namespace `collaboration→collaboration-optimize`（1-6、349-376）；只删这三个工具上 `message.encrypted===true` 的标记（205-241），不动其它工具。
- 门控严格：显式 opt-in、inbound=responses、目标为 canonical ChatGPT、顶层或首个 developer `additional_tools` 中存在 v2 catalog（24-34、95-107；`src/server/responses/core-normalize.ts:193-198`；`src/adapters/openai-responses/passthrough.ts:398-405`）。其它 provider/网关不改写。
- 冲突保持原请求：预扫 catalog、`tool_choice`、历史调用、`tool_search_output`，任一命中即整包原样返回（455-486）。响应只改“身份位置”，arguments 与工具输出视为不透明（759-800）。

## 二、复用范围与界限

- 模块可单独拷入（MIT，无依赖），但**单文件不生效**，最少还需四处接线：门控、出站 prepare、两个 `ReadonlySet` 的请求→响应传递（`src/types/request.ts:128`、`src/server/responses/response-effects.ts:113-151`）、JSON/SSE/WS 三路 restore 与续接缓存（`src/server/responses/passthrough-delivery.ts:1314-1325`、851-855）。
- SSE 必须按完整 event block 包装（`src/server/sse-payload-rewrite.ts:28-35`），JSON 需整包解析；无 Content-Type 时只探测前 4096 字节（`passthrough-delivery.ts:160、238-260`）。身份上限 10000（模块 553、774）；超限 JSON 返回 502，流式返回 `response.failed`（tests/server/plaintext-v2-agent-messages-server.test.ts:701-725、781-823）。
- 关键澄清：`encrypted_function_args: []` **不是本模块生成**，只是原样保留上游字段。测试中的 `[]` 来自 fixture（tests/responses/plaintext-v2-agent-messages.test.ts:542、571；server 测试 201、233）；若 ChatGPT 不发，客户端也不会得到。模块从不解密、不改历史密文。
- 文档（`docs-site/src/content/docs/zh-cn/reference/configuration/agents.md:94-111`）称“取消应用层加密、保留 `[]`”，与代码一致；但依赖未公开 schema，且未在本机验证。

## 三、能否省额外 GPT relay

能，但仅限开启后**新产生**的 spawn/send/followup。`agentTaskRecovery` 确实另发一次 GPT 请求到 `https://chatgpt.com/backend-api/codex/responses`（`src/server/responses/agent-task-recovery.ts:19、480-486`），默认 `gpt-5.6-sol`、45s、0 重试（配置上限 2 次）（63-80、542-549），且只接受结构合法的单个 Fernet token（154-159）。明文 v2 不走该链路；代价是父轮仍必须走 ChatGPT，且无法处理旧密文。

## 四、DeepSeek sidecar

- `scripts/codex-deepseek-sidecar`（999 行 bash）：新会话 `codex exec --profile … --sandbox danger-full-access -C`，续接 `codex exec … resume <id>`（855-875），显式 `danger-full-access`、`--skip-git-repo-check`。
- 状态/日志：`~/.codex/state/deepseek-sidecar/sessions.txt` 与 `locks/<sid>/pid`（570-581、638-645、983-997）；Terminal 日志落 `/tmp/deepseek-sidecar-monitor.*`（884-890、912-914）。
- macOS 绑定：`osascript` 开 Terminal（918-934）、`launchctl`/PlistBuddy（343-357）、Keychain、python3、mkfifo、iconv。`--no-monitor` 只是跳过 AppleScript（96-99、911-943），并非 Windows 隐藏启动；该 sidecar 仓库无 Windows 隐藏启动源码。opencodex 的 `windowsHide` 只用于其派生子进程（如 `src/service-manager-probe.ts:158`），与 sidecar 无关。
- 不能注入原生 Subagents UI：它只是 skill/CLI `exec` 出去的独立 `codex exec` 进程（`scripts/codex-deepseek-subagent:7`、`agents/openai.yaml`），无 app-server/插件接口；其历史是 Codex 会话与 Terminal 日志，成不了“原生可点完整历史”。
- 无峰谷/Luna 路由：只有 profile→模型映射（267-274、466-513），全文件无 luna/peak 逻辑。

## 五、不能满足与下一步实验

不能满足：旧密文不可解；冲突请求不改写；依赖未公开 schema；无 UI；未在 0.162 实测。最有价值的隔离实验：用录制的真实 canonical ChatGPT SSE（含明文 spawn 调用）离线回放“仅本模块 + 最小 block 包装”，断言出站四名称改写、`message.encrypted` 消失、客户端恢复 `namespace=collaboration/name=spawn_agent` 且原样保留 `encrypted_function_args=[]`（输入含该字段时）、10001 身份时 502/`response.failed`。不调真实模型，也不宣称 UI 已验证。
