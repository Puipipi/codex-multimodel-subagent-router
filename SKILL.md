---
name: codex-multimodel-subagent-router
description: Use when Codex leads the current conversation and delegates project file work to an explicitly resolved native model or guarded API executor under the configured peak/valley policy.
metadata:
  short-description: Codex 主控 · 多模型峰谷子代理
---

# Codex 主控 · 多模型峰谷子代理

主智能体保持当前会话、模型和 provider，负责拆任务、判断方案及审阅 diff 与证据。普通无文件问答直接处理。项目搜索、修改、调试和验证按当前配置路由；用户最新指令优先，子代理不得递归委派。

先运行安装目录中的 `node scripts/route.mjs --json`，按返回的有效执行器和状态决定是否派发。一次性选择优先于会话选择，会话选择优先于配置日历；fixed/scheduled、`luna`、`same`、`native:<slug>` 与不可变 API profile 均保留原有解析。默认日历为 2026 年 Asia/Shanghai 工作日峰谷规则，日历与价格规则不是实时价格查询。

## 五个不变量

1. **模型选择**：原生 Luna 从当前 catalog 解析；`same` 使用当前会话精确模型；`native:<slug>` 必须存在。API 使用不可变 profile ID。不可用就报告，不猜模型、不静默切换 backend、账号或 provider；DSH 仅显式 legacy。
2. **可信归属**：native 归属来自 `CODEX_THREAD_ID` / `CODEX_SESSION_ID`，MCP 只信 `_meta.threadId`；不伪造 parent，不跨会话重绑。每个 child 保持原 nonce、模型、role、provider 和 profile，后续修改复用该 child。
3. **租约**：写任务 reserve → spawn → bind → finish，冲突拒绝；不凭超时偷租约。结果不确定时保留 reservation；只读 gateway child 也要 gate → record，终态 complete。
4. **兼容校验**：先解析执行器，再应用对应 guard。用户关闭则不创建或自动续问子代理；在途任务可收尾；API/DeepSeek 要求当前运行 CLI 与批准 receipt 的 hash 匹配。原生执行器独立于 API guard。普通路由不安装、Apply、独立启网关或改全局配置；仅已批准 runtime 的 gate 按既有受管生命周期检查/启动服务，不得绕过 gate；保存设置与显式 Apply 分开。
5. **身份兼容**：活跃 plugin/marketplace/MCP/skill 名为 `codex-multimodel-subagent-router`；旧 `sol-luna-deepseek-router` state 根、schema、租约、绑定、managed markers、任务名与 env/header keys 不迁移、不复制、不重算。只发现一个 canonical skill，插件无 `skills/` 目录或 manifest `skills` 字段。

## 按需读取

- 派发、回传、writer 生命周期、native/API gate 和 legacy DSH：先读 [execution.md](references/execution.md)，再执行其中对应分支。
- 判断“现在可用吗”：读 [capabilities.md](references/capabilities.md)，区分源码契约、离线验证、当前主机实测和未验收。
- 排查旧补丁、授权或验收问题：读 [历史索引](references/history/README.md)，按需打开原位 dated docs，不将旧 0.164 补丁当作当前 CLI 能力。
- 安装身份切换与回滚：读 [迁移说明](docs/identity-migration.md)；canonical 复制排除 `codex-plugin/`，旧目录保留 scripts 以兼容在途引用。

每次 spawn/followup 消息末尾追加一次：用户可见的进度与最终报告必须使用简体中文；代码、命令和内部 GPT-DeepSeek 通信可保持原文。

子代理不主动发送用户进度；向父智能体提供一次简短内部交接，包含改动、测试、证据和限制。主智能体审阅实际结果，不把 mock、包哈希或 agent 报告当作 GUI/外部调用验收。
