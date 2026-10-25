# Sol 主控 · 原生 Luna/DeepSeek 峰谷分工

[English](README.md) / [简体中文](README_cn.md)

一个路由技能，加一个可选的 Codex 插件。Sol 保持当前对话，负责拆分任务、判断方案和审查结果；项目搜索、文件修改、调试和测试在峰时交给原生 Luna，谷时交给隔离的原生 DeepSeek 子代理。普通问答由 Sol 处理，用户也可以明确要求 Sol 直接执行。

## 状态

本页描述 **main / 插件 0.10.4**。独立的 **0.12.3 开发预览**位于 [PR #1](https://github.com/Puipipi/sol-luna-deepseek-router/pull/1)，包含 API 配置和设置相关开发；它尚未进入 main，也不代表验收完成。请使用与安装分支一致的文档。

## 组件

| 组件 | 用途 | 入口 |
| --- | --- | --- |
| 唯一路由技能 | Sol 主控分工与确定性峰谷选择 | [SKILL.md](SKILL.md) |
| 路由辅助脚本 | 时间表、单次选择、当前对话覆盖 | [scripts/route.mjs](scripts/route.mjs) |
| 可选插件 | MCP 包装、当前对话 hooks、DSH 追踪 | [PLUGIN.md](PLUGIN.md) |
| 隔离原生后端 | 定制 CLI、专用 DeepSeek 角色/提供方/目录、受管网关生命周期 | [安装指南](docs/native-isolated-install.md) |
| 旧 DSH 兼容路径 | 外部桥接器、对话归属隔离与工作区写入租约 | [DSH 客户端](scripts/dsh-mcp-client.mjs) |

正式原生 DeepSeek 路径使用隔离的 `native_deepseek` 角色、独立的 `deepseek-native` 提供方及模型目录。Sol 和原生 Luna 保持正常提供方与实时模型目录。原生后端与外部 DSH 桥接器是独立执行路径；DSH 不会成为自动回退选项。

## 文档与报告

报告是特定主机上的带日期证据。安装配置完成不代表另一台主机的桌面行为已通过验证；main 基线的完整桌面验收仍待完成。

| 文档 | 范围 |
| --- | --- |
| [插件指南](PLUGIN.md) | 打包、生命周期、独立技能同步 |
| [隔离原生安装](docs/native-isolated-install.md) | 显式 prepare、status、activate、rollback 流程 |
| [CLI 构建说明](docs/native-isolated-cli-build.md) | 配套定制 CLI 的前提与构建边界 |
| [正式安装记录](docs/native-formal-install-2026-10-18.md) | 一台主机上的安装观察 |
| [稳定网关验收](docs/native-stable-gateway-acceptance-2026-10-18.md) | 受管任务、来源切换与进程证据 |
| [部分桌面验收](docs/native-desktop-partial-acceptance-2026-10-18.md) | 已接受的观察与桌面遗留项 |
| [真实多对话验收](docs/native-real-multichat-acceptance-2026-10-18.md) | 两个主对话中的 Luna 分工及其结果 |
| [实时路由 hook 验收](docs/native-live-route-hook-acceptance-2026-10-18.md) | 当前对话路由提示证据 |
| [部分故障验收](docs/native-formal-fault-acceptance-2026-10-18.md) | 恢复场景及剩余限制 |
| [0.10.4 包更新记录](docs/native-plugin-update-0.10.4-2026-10-18.md) | 包更新证据 |

## 安装

Windows 辅助工具需要 **Node.js 24+**、npm 和 **PowerShell 7.3+**。

1. 将标准技能包安装至 `~/.codex/skills/sol-luna-deepseek-router`。保留 `SKILL.md`、`scripts/` 和引用的 `docs/`；仅复制技能文件并不完整。只保留一个路由技能。
2. 可选：从本地克隆安装插件：

```powershell
codex plugin marketplace add <repo-root>
codex plugin add sol-luna-deepseek-router@sol-luna
```

本地 marketplace 的源更新后，重新运行第二条命令。独立技能需要单独同步。安装或更新后重载插件或重启 Codex。插件不捆绑技能；自动发现 `hooks/hooks.json`，manifest 无需 `hooks` 指针。Hooks 初始未受信任，需要在 `/hooks` 中审查并批准。

3. 使用原生 DeepSeek 时，遵循[隔离安装指南](docs/native-isolated-install.md)。需要配套的定制 Codex CLI 和专用网关设置，仅安装技能或插件不足以启用。只在明确请求时执行设置，激活后完全重启 Codex。其他主机须独立核验。
4. 仅在明确需要旧 DSH 兼容路径时，安装固定版本的外部桥接器，并禁用它的配套技能：

```powershell
npx --yes dsh-subagent-mcp@0.7.0 setup --no-skill --service background
```

外部 [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp) 桥接器默认使用 `deepseek-official` / `deepseek-flash`。其服务与账号设置独立于原生 DeepSeek。

## 使用

在已安装技能目录或仓库根目录运行以下命令；它们只计算或更新路由状态，不调用模型：

```powershell
node .\scripts\route.mjs --json
node .\scripts\route.mjs --json --executor deepseek
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --set-session-executor luna
node .\scripts\route.mjs --json --session $env:CODEX_THREAD_ID --reset-session
```

内置 2026 规则编写时依据 [DeepSeek 定价时间表](https://api-docs.deepseek.com/quick_start/pricing/)和 [2026 节假日通知](https://zwfw.gansu.gov.cn/huixian/zczx/tzgg/art/2025/art_715c16a75e4d4c289c295e77772c7274.html)：工作日峰时为 UTC 01:00–04:00、06:00–10:00（中国时间 09:00–12:00、14:00–18:00），排除中国法定假日。周末调休工作日仍按谷时处理；未知日历年份的候选工作日峰时保守选择 Luna。单次手动选择优先于对话覆盖，对话覆盖优先于时间表。当前是否适用，请核对提供方的最新价格。

保留当前对话，不必为跨越峰谷边界新建对话。新任务使用当前路由，运行中的任务可以完成。执行器失败时明确报告，不静默替换后端。

## 检查

以下现有检查使用本地夹具或模拟后端，无需付费推理或运行中的 DSH 服务：

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

更多平台矩阵和原生测试见 [CI](.github/workflows/tests.yml)。按需启用的 `native-config-read.test.mjs` 需要本地 Codex 可执行文件和模型缓存，不是可移植的快速检查，也不证明桌面验收通过。

## 边界与约定

- Hook 使用 `node "${PLUGIN_ROOT}/scripts/route-hook.mjs"`，不新建对话、不唤醒空闲对话；它在受支持事件发生时注入模型可见上下文，不保证显示 UI 横幅。模型/角色识别及会话 ID 匹配存在主机相关限制。
- 插件 MCP 调用要求可信的 `_meta.threadId`，可写 DSH 任务持有工作区租约。`dsh_trace` 是真实事件的只读快照。外部代理不会变成 Codex 原生子代理或原生子代理面板。
- 正式网关在上游调用前拒绝 GPT/未知模型和加密协作输入，relay 上限强制为零。共享根提供方网关及透明 relay 资料属于历史兼容路径；正式路径见[安装指南](docs/native-isolated-install.md)。
- 不提交凭证、追踪票据、本地用户路径或私人日志。状态使用哈希后的对话身份，不输出 API 凭证。

## 贡献与来源

修改范围保持在路由、分工及兼容性。区分源码测试、安装证据和桌面实测行为，以带日期的证据说明限制。提交 PR 前运行与修改相关的检查。

Sol 主控模式参考 [madman8228/sol-luna-delivery](https://github.com/madman8228/sol-luna-delivery) 和 [dy0000/sol-plan-luna-execute](https://github.com/dy0000/sol-plan-luna-execute)。旧 DSH 路径使用外部 [dsh-subagent-mcp](https://github.com/dqtz5vpvj9-create/dsh-subagent-mcp) 项目。Codex 的 [hooks](https://learn.chatgpt.com/docs/hooks) 和[插件打包](https://developers.openai.com/plugins/build/plugins)仍是主机集成前提。

## 许可证

本仓库使用 [MIT](LICENSE)。上游项目保留各自许可证；定制 Codex CLI 基于采用 Apache-2.0 的上游 Codex。
