# Codex 多模型子代理路由

[English](README.md) / [简体中文](README_cn.md)

标准技能：`$sol-luna-deepseek-router`。

一个路由技能，加一个可选的 Codex 插件。Sol 保持当前对话，负责拆分任务、判断方案和审查结果；项目搜索、文件修改、调试和测试可选择实时模型目录中的原生执行器或不可变自定义 API profile。默认的峰时 Luna / 谷时 DeepSeek 是一种方案，也支持固定执行器或峰谷分别自选。普通问答由 Sol 处理，用户也可以明确要求 Sol 直接执行。

## 状态

**本分支源码版本为 0.12.5**。维护中的本地部署已安装并可用，路由、设置界面和原生分工已有明确范围内的验证。报告中的历史版本保留各自日期与验收范围；本地可用不代表所有自定义 API 提供方均已通过端到端验收。

## 下载

0.12.5 修复 API 兼容守卫误拦原生模型；用户关闭开关仍阻止所有自动分工。设置面板区分模型目录检查、本地连接日志诊断与真实调用；前两项不代表实时连接成功。

[下载插件 ZIP](https://github.com/Puipipi/codex-multimodel-subagent-router/releases/latest/download/codex-multimodel-subagent-router.zip) · [SHA-256 校验值](https://github.com/Puipipi/codex-multimodel-subagent-router/releases/latest/download/SHA256SUMS.txt) · [源码 ZIP](https://github.com/Puipipi/codex-multimodel-subagent-router/archive/refs/heads/main.zip)

Release ZIP 包含插件、独立技能、中英文说明和 bootstrap。解压后按下方本地 marketplace 命令安装。API 执行器需要的完整定制 Codex CLI 是独立前提；下载插件不会自动安装或激活该 runtime。安装 ID 保持 `sol-luna-deepseek-router@sol-luna`，兼容已有安装。

设置面板跟随 Codex 宿主语言，提供中文和英文，并响应运行中的语言切换。宿主未提供语言时使用浏览器语言，其他语言回退到英文。用户填写的值和上游诊断原文保持不变。

## 组件

| 组件 | 用途 | 入口 |
| --- | --- | --- |
| 唯一路由技能 | Sol 主控分工与确定性峰谷选择 | [SKILL.md](SKILL.md) |
| 路由辅助脚本 | 时间表、单次选择、当前对话覆盖 | [scripts/route.mjs](scripts/route.mjs) |
| 可选插件 | MCP 包装、当前对话 hooks、DSH 追踪 | [PLUGIN.md](PLUGIN.md) |
| 隔离原生后端 | 定制 CLI、专用 DeepSeek 角色/提供方/目录、受管网关生命周期 | [安装指南](docs/native-isolated-install.md) |
| 自定义 API 执行器 | 不可变 profiles、Responses/Chat Completions、独立生命周期 | [API 指南](docs/native-api-executors.md) |
| 旧 DSH 兼容路径 | 外部桥接器、对话归属隔离与工作区写入租约 | [DSH 客户端](scripts/dsh-mcp-client.mjs) |

正式原生 DeepSeek 路径使用隔离的 `native_deepseek` 角色、独立的 `deepseek-native` 提供方及模型目录。Sol 和原生 Luna 保持正常提供方与实时模型目录。原生后端与外部 DSH 桥接器是独立执行路径；DSH 不会成为自动回退选项。


设置面板支持开关、固定执行器及峰谷分别选择。`off` 关闭自动分工，Sol 直接执行；`same` 仍创建隔离子代理，使用当前主对话的确切模型。`native:<slug>` 只能选择当前 `CODEX_HOME/models_cache.json` 中的模型，不可用时明确失败。原生 Luna 也从实时目录解析。

自定义 API profile 使用不可变 ID，支持 Responses 与 Chat Completions；编辑会创建新 ID，已有子代理继续绑定旧 profile。可使用官方 DeepSeek/DSH 账号解析或手动环境变量、文件凭证引用，不在配置内嵌密钥，也不尝试其他账号或提供方。固定模式不看时钟，显式峰谷模式分别选择执行器。保存设置、应用 API 配置、完全重启以及实际调用验证是独立步骤。API 子代理禁用内建 web_search；本地夹具通过不代表所有 API 已验收。

## 文档与报告

报告是特定主机上的带日期证据，各有独立验收范围；旧版本记录不是当前发布状态。

| 文档 | 范围 |
| --- | --- |
| [设置面板与 off/same](docs/router-settings-mcp.md) | 设置面板与 off/same |
| [不可变 API profiles 与生命周期](docs/native-api-executors.md) | 不可变 API profiles 与生命周期 |
| [0.11.2 角色注册记录](docs/native-api-role-registration-0.11.2-2026-10-19.md) | 0.11.2 角色注册记录 |
| [0.11.3 目录修复与验收限制](docs/native-api-catalog-instructions-0.11.3-2026-10-19.md) | 0.11.3 目录修复与验收限制 |
| [0.11.4 wire 修复与真实调用限制](docs/native-api-agent-message-0.11.4-2026-10-19.md) | 0.11.4 wire 修复与真实调用限制 |
| [历史桌面行为证据](docs/native-desktop-acceptance-0.10.5-2026-10-18.md) | 历史桌面行为证据 |
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
自定义 API 先在[设置面板](docs/router-settings-mcp.md)保存 profile，再显式应用已批准的兼容 runtime，完全退出并重启 Codex 后核验角色与实际调用。普通路由不会安装或激活 runtime；不要将“凭证可用”当作认证或推理通过。

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
node .\tests\plugin-router-settings.test.mjs
node .\tests\plugin-mcp-env.test.mjs
node .\tests\plugin-distribution.test.mjs
node .\tests\native-api-settings.test.mjs
node .\tests\native-api-routing.test.mjs
node .\tests\native-api-protocol.test.mjs
node .\tests\native-api-artifacts.test.mjs
node .\tests\native-api-install.test.mjs
node .\tests\native-api-lifecycle.test.mjs
node .\tests\native-api-origin.test.mjs
node .\tests\native-api-manager.test.mjs
node .\tests\native-current-model.test.mjs
node .\tests\native-execution-lifecycle.test.mjs
node .\tests\native-connection-diagnostics.test.mjs
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
