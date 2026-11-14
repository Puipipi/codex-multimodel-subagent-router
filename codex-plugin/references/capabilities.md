# 当前能力与证据边界

历史安装基线日期：2026-11-14；本次源码更新：2026-11-15，候选版本：0.13.1。证据分层，不把旧补丁记录当作当前运行能力。

| 层级 | 已有证据 | 结论与边界 |
| --- | --- | --- |
| 源码契约 | route、native-agent、native-state、plugin-state、API settings / runtime gate | 支持精确模型选择、可信归属、单 writer 租约、不可变 child/profile 绑定；native 与 API guard 分离。实现存在不等于主机已验收。 |
| 离线验证 | 仓库 tests 的 fixture / mock、分发包和身份迁移测试 | 只证明对应源码契约及隔离文件操作。检查命令见 [README](../README.md)，结果以运行输出为准。 |
| 当前主机 native | 2026-11-14 原生 gpt-6.1-sol 子代理实际读取文件并回传，主控获得返回 | 证明该原生模型的本次读文件与回传；不推及所有模型、API 或 GUI。 |
| 当前主机旧安装 | 官方 app-server initialize 返回 0.167.0-alpha.4.1；0.12.8 两个 hooks 为 enabled/trusted；旧缓存 MCP initialize/tools/list 得到 21 个工具，resources/read 读取 ui://router/settings 静态 HTML 成功 | 证明旧安装的枚举、静态资源和 hook trust；没有 tools/call、浏览器交互或新 0.13.0 安装验收。 |
| 候选隔离安装 | 官方 0.167.0-alpha.4.1 在独立 home 按预注册 marketplace → prepare → begin → 官方 plugin add → activate 完成安装/身份切换；随后真实 rollback 通过 | 仅新插件 enabled、唯一新 canonical SKILL；旧 scripts/cache 保留，隔离 settings/tasks/leases/guard hash 不变。回滚后仅旧插件 enabled，新 config 表移除，未发生默认双启用。 |
| 候选隔离 MCP/hook | 新实际 cache 的 stdio MCP initialize、21 个工具及 86417 bytes 静态设置 HTML 读取成功；官方 hooks/list 只列新 2 项 enabled/untrusted | 证明隔离协议枚举与静态资源，不是 tools/call、真实 GUI 或外模型成功；新 hook 未获人工授信。 |
| 当前 API 兼容状态 | 只读 guard 为 disabled，理由为兼容补丁尚未通过当前 Codex 版本验证 | API/DeepSeek 不据此派发。状态字段并非实时连接测试；未改 guard、settings 或用户开关。 |
| 历史切换前基线（2026-11-14） | 当时日常真实安装仍为 0.12.8，0.13.0 尚未在该主机切换；该轮没有真实 GUI、DeepSeek/API/DSH 外部调用，未执行 Apply、启网关或构建/patch CLI | 仅描述当时证据；后续安装状态见下一行，不能据此声称 GUI、认证、推理或外部工具执行通过。 |
| 当前只读安装核对（2026-11-15） | 主控在当前 0.169 宿主只读确认：0.13.0 新版 enabled、旧版 disabled；hooks/list 两项 hook 均 trusted | 仅安装/授信状态核对；本次 0.13.1 尚未验收，待安装与宿主检查，不是 GUI、分工提示送达、native/API 或电脑操作验收。 |

旧 0.10/0.11 和 CLI 0.164 的补丁、授权、安装与验收记录仅为 [按需历史资料](history/README.md)。2026-11-14 的 CLI 基线为 0.167.0-alpha.4.1；2026-11-15 当前宿主 0.169.0-alpha.11.1 已只读核对 UserPromptSubmit/PreToolUse 的 `turn_id` 同源及 ThreadSpawn 的 `agent_id` 子身份契约，该检查不是 native/API/GUI 验收。旧 hash、receipt、角色发现和成功/失败记录不能替代当前兼容校验。配置/凭据存在、catalog 可读、MCP 资源可读均不等于外部调用成功。

当前日常主机基线与候选隔离官方安装/回滚证据均由主控独立核验，不在发布包内存放本机路径、原始配置、身份 ID 或日志。日常主机后续切换、hook trust 与 GUI/外部调用结果以对应日期的本机 receipt 按需读取；本表不是永久状态声明。

## 本次提示与电脑模型设置

源码与隔离测试覆盖：每个新宿主 turn 的短分工上下文、同 turn 事件/并发去重、路由变化独立提示、旧 state 补提醒、无 turn_id 保守兼容、agent_id/default/同模型 child 抑制及 off 优先。只保留最近 turn 的去重记录；任意乱序旧事件不承诺 exactly-once。上下文是软约束，不会自动 spawn，不能保证主智能体每次委派；持久写入至 stdout 之间仍有终止窗口，写入不代表模型已收到。

`computerUseExecutor` 默认 `inherit`，可保存当前目录的精确原生模型；电脑任务使用 `route --task-kind computer-use`，off 和一次性显式选择优先，之后才是专用模型与普通继承路由。API/gateway 及缺失模型明确不可用，不静默换模型；目录可选不代表已验证电脑操作能力。设置 read/update/save、UI 中英文本和收集路径已由隔离测试覆盖；本轮未做真实电脑操作、宿主分工送达或新版本 GUI 验收。
