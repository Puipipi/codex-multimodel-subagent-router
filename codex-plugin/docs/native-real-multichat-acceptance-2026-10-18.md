# 真实多聊天原生 Luna 部分验收（2026-10-18）

本次由两个真实、不同的 Codex 主聊天 A/B 与各自启动的原生 Luna child 完成。为保护聊天身份，记录不包含主聊天或 child UUID。两个 child 均为 `gpt-6-luna`、`fork_turns: none`；B 的真实 rollout 元数据与父主聊天的原生 child 事件关联，不以 child 自述或任务名称推断身份。此次未派发 DeepSeek child，也未使用 DSH 会话。

A 在 workspace A 持有真实 active writer lease 时，B 对同一 workspace 的 reserve 以 `workspace_already_reserved` 拒绝，命令退出码为 1。B 随后在独立 workspace 成功 reserve/bind；B 的读取确认其 lease active 且 child 匹配，A 随后的读取也确认自己的 lease 仍 active 且 child 匹配。这证明两个不同 workspace 的写入租约可共存；没有测量模型请求或文件写入是否在墙钟时间上重叠。

ownership 查询中，A 只看到自己的 child，B 只看到自己的 child；各自 team 列表不含对方任务，A 的 root 列表也不含 B 子代理的 `agentPath`。A 使用自己的可信身份尝试 finish B 的 child，被原生 CLI 以跨 owner 拒绝、退出码 1。外层 wrapper 为安全捕获结果返回 0；该 wrapper 码不是拒绝失败。随后 B 的读取确认自己的 task 登记仍为 running、lease 仍 active，且记录的 child 匹配。该 child 的实际执行已 completed；当时父审计尚未 finish，不能把 task 登记状态误称为 child 仍在运行。验收结束时 A、B 都以 `released=true` finish，自身记录进入 completed；B 的 lease 查询返回 null，owner 查询仍仅返回自己的历史记录。

两个真实 session 的路由偏好也彼此隔离：A 的 session 使用 `source=session_override`、`executor=luna`；B 的 session 使用 `source=schedule`、`executor=deepseek`、`phase=valley`。B 仅读取自己的路由结果，没有派发 DeepSeek child 或改变模型。这证明偏好按真实 session 区分，不证明 DeepSeek 双聊天执行。

两个 child 分别在各自 workspace 创建 UTF-8 无 BOM、单行 LF 文件，并由父聊天独立回读精确核验：

| 聊天 | 文件内容 | 字节数 | SHA-256 |
| --- | --- | ---: | --- |
| A | `主聊天 A 的原生 Luna 写入成功` + LF | 40 | `965bd86e96e06e32c9d687c06debbb1adebb129bdf8a37a893451fa7bf66a10b` |
| B | `主聊天 B 的原生 Luna 写入成功` + LF | 40 | `23fa616d545575d14725e10227203586db2ad5d7b3cbd0a93c09c393e16b1a6f` |

B 的测试主聊天已通过官方归档操作归档；其文件和历史保留，且没有活跃 child task。

取证过程中，B 首次依据缺少 model 字段的只读结果误判为无法验证，child 当时只作文字自述、没有写文件。随后改用父聊天原生 `subAgentActivity.agentThreadId` 关联真实 child rollout，确认模型后在同一唯一 child 中继续完成，没有换模型或重复 spawn。此处记录的是正确的身份核验方法，不声称修复了平台问题。

本记录只证明这两个真实主聊天之间的原生 Luna ownership 隔离、同 workspace 写租约冲突拒绝、不同 workspace 租约共存、session 路由偏好隔离，以及两次各自文件写入。模型请求或文件写入的墙钟重叠未测量；没有进行双聊天 DeepSeek、完整冷启动、历史 UI 可点击性、失败状态 UI 或公网断网测试。整体桌面验收仍为部分完成。
