# 当前能力与证据边界

基线日期：2026-11-14；候选版本：0.13.0。证据分层，不把旧补丁记录当作当前运行能力。

| 层级 | 已有证据 | 结论与边界 |
| --- | --- | --- |
| 源码契约 | route、native-agent、native-state、plugin-state、API settings / runtime gate | 支持精确模型选择、可信归属、单 writer 租约、不可变 child/profile 绑定；native 与 API guard 分离。实现存在不等于主机已验收。 |
| 离线验证 | 仓库 tests 的 fixture / mock、分发包和身份迁移测试 | 只证明对应源码契约及隔离文件操作。检查命令见 [README](../README.md)，结果以运行输出为准。 |
| 当前主机 native | 2026-11-14 原生 gpt-6.1-sol 子代理实际读取文件并回传，主控获得返回 | 证明该原生模型的本次读文件与回传；不推及所有模型、API 或 GUI。 |
| 当前主机旧安装 | 官方 app-server initialize 返回 0.167.0-alpha.4.1；0.12.8 两个 hooks 为 enabled/trusted；旧缓存 MCP initialize/tools/list 得到 21 个工具，resources/read 读取 ui://router/settings 静态 HTML 成功 | 证明旧安装的枚举、静态资源和 hook trust；没有 tools/call、浏览器交互或新 0.13.0 安装验收。 |
| 候选隔离安装 | 官方 0.167.0-alpha.4.1 在独立 home 按预注册 marketplace → prepare → begin → 官方 plugin add → activate 完成安装/身份切换；随后真实 rollback 通过 | 仅新插件 enabled、唯一新 canonical SKILL；旧 scripts/cache 保留，隔离 settings/tasks/leases/guard hash 不变。回滚后仅旧插件 enabled，新 config 表移除，未发生默认双启用。 |
| 候选隔离 MCP/hook | 新实际 cache 的 stdio MCP initialize、21 个工具及 86417 bytes 静态设置 HTML 读取成功；官方 hooks/list 只列新 2 项 enabled/untrusted | 证明隔离协议枚举与静态资源，不是 tools/call、真实 GUI 或外模型成功；新 hook 未获人工授信。 |
| 当前 API 兼容状态 | 只读 guard 为 disabled，理由为兼容补丁尚未通过当前 Codex 版本验证 | API/DeepSeek 不据此派发。状态字段并非实时连接测试；未改 guard、settings 或用户开关。 |
| 未验收 | 日常真实安装仍为 0.12.8，新版本尚未在该主机切换；本轮没有真实 GUI、DeepSeek/API/DSH 外部调用，未执行 Apply、启网关或构建/patch CLI | 不声称新版本日常安装、GUI、认证、推理或外部工具执行已通过；本机后续状态以当次 receipt 按需读取。 |

旧 0.10/0.11 和 CLI 0.164 的补丁、授权、安装与验收记录仅为 [按需历史资料](history/README.md)。当前 CLI 是 0.167.0-alpha.4.1；旧 hash、receipt、角色发现和成功/失败记录不能替代当前兼容校验。配置/凭据存在、catalog 可读、MCP 资源可读均不等于外部调用成功。

当前日常主机基线与候选隔离官方安装/回滚证据均由主控独立核验，不在发布包内存放本机路径、原始配置、身份 ID 或日志。日常主机后续切换、hook trust 与 GUI/外部调用结果以对应日期的本机 receipt 按需读取；本表不是永久状态声明。
