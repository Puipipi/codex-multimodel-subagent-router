# 原生 Luna/DeepSeek 集成实施计划

> 已批准设计；执行者按任务顺序落地，不安装全局配置，不重复付费 P3。

**Goal:** 在 `outputs/sol-luna-deepseek-router` 增加共享 openai provider 的原生 DeepSeek 网关与唯一 skill 路由，保留现有 DSH 工具作为显式 legacy。

**Architecture:** Codex 仍使用 `openai` provider；`openai_base_url` 仅指向隐藏的本机网关。网关按精确模型 slug 分流：未识别模型 raw 透传 ChatGPT，`deepseek/deepseek-flash` 转 DeepSeek Responses；原生 collaboration 密文经已登录 GPT relay 解密并按账号+密文缓存。skill 只调用原生 `spawn_agent`/wait/followup；插件元数据与 DSH trace 保留但不自动 fallback。

**Tech Stack:** Node.js 24 ESM、Node http/zlib/stream、Codex app-server JSONL/WS、现有 plugin-state 锁与 atomic write。

**Spec:** 本轮已批准设计；原生实证摘要见 `docs/native-deepseek-acceptance-2026-10-17.md`。

## Global Constraints

- 不改真实 `~/.codex`，不安装/启动/停止用户桌面或 `node_repl`。
- 正式代码不含绝对用户路径、凭据、private trace、测试 20/2 cap。
- 默认 main model/provider 原样保留；DS slug 精确为 `deepseek/deepseek-flash`。
- 只保留一个 routing skill；不新增调度系统或 agent loop。

---

### Task 1: 正式 routing/relay/gateway 模块

**Files:**
- Create: `scripts/native-routing.mjs`, `scripts/native-relay.mjs`, `scripts/native-usage.mjs`, `scripts/native-credentials.mjs`, `scripts/native-gateway.mjs`
- Test: `tests/native-gateway.test.mjs`

**Interfaces:**
- Produces: `routeForModel(model)`, `normalizeRoutedAgentInput(input,{relay})`, `normalizeNativeAgentInput(input)`, `buildDeepSeekBody(body)`, `createNativeGateway(options)`.

- [ ] 写 fixture：NEW_TASK 不变 assistant、non-native plaintext 不 relay、DS reasoning_text 保留、GPT 密文推理不动。
- [ ] 实现 raw GPT 透传、DS header 隔离、zstd/gzip、stream usage、relay cache/coalescing。
- [ ] 跑定向测试。

### Task 2: 隐藏单实例 gateway 与 catalog/install

**Files:**
- Create: `scripts/native-catalog.mjs`, `scripts/native-gateway-manager.mjs`, `scripts/native-install.mjs`
- Test: `tests/native-catalog.test.mjs`, `tests/native-manager.test.mjs`

**Interfaces:**
- Produces: `ensureGateway()`, `stopGateway()`, `gatewayStatus()`, `mergeCatalog()`, `install({dryRun})`, `rollback()`, `uninstall()`.

- [ ] 测试 catalog 保留现有 Sol/Luna 条目并追加 DS。
- [ ] 测试 start/status/stop、PID/token 校验、隐藏 spawn 参数、config 备份/rollback。
- [ ] 实现最小单实例状态与 marker-owned config 块；暂不运行 install。

### Task 3: 原生 task/writer 状态与 agent 解析

**Files:**
- Create: `scripts/native-state.mjs`, `scripts/native-agent.mjs`
- Test: `tests/native-state.test.mjs`, `tests/native-agent.test.mjs`

**Interfaces:**
- Produces: `NativeTasks.begin/finish/owned/assertOwner`, `NativeWriterLease.acquire/release`, `resolveNativeAgent({executor,mainModel,models})`.

- [ ] 测试两个父 chat 不能读取/结束对方 child。
- [ ] 测试同一 workspace 默认只允许一个 writer，不同 workspace 可并行。
- [ ] Luna 从实际 catalog 选 supported Luna；不硬编码 Sol 版本；DeepSeek 固定 exact slug + `fork_turns:"none"`.

### Task 4: 唯一 skill 与文档

**Files:**
- Modify: `SKILL.md`, `agents/openai.yaml`, `.codex-plugin/plugin.json`, `README.md`, `PLUGIN.md`
- Create: `docs/native-deepseek-acceptance-2026-10-17.md`

**Interfaces:**
- Skill route deepseek -> native spawn; DSH MCP/trace remains explicit legacy, no silent fallback.

- [ ] 更新用户可见名称与 route 指令。
- [ ] 更新安装/回滚/测试命令、真实 P3 证据、桌面 UI 未验声明。
- [ ] 运行 docs/manifest 测试。

### Task 5: 回归与报告

- [ ] 运行新增定向测试。
- [ ] 运行现有整套回归一次；失败只定向修。
- [ ] 返回 changed files、命令/退出码、安装命令、待验事项。
