# 当前能力与证据边界

基线日期：2026-11-14；候选版本：0.13.0。证据分层，不把旧补丁记录当作当前运行能力。

| 层级 | 已有证据 | 结论与边界 |
| --- | --- | --- |
| 源码契约 | route、native-agent、native-state、plugin-state、API settings / runtime gate | 支持精确模型选择、可信归属、单 writer 租约、不可变 child/profile 绑定；native 与 API guard 分离。实现存在不等于主机已验收。 |
| 离线验证 | 仓库 tests 的 fixture / mock、分发包和身份迁移测试 | 只证明对应源码契约及隔离文件操作。检查命令见 [README](../README.md)，结果以运行输出为准。 |
| 当前主机 native | 2026-11-14 原生 gpt-6.1-sol 子代理实际读取文件并回传，主控获得返回 | 证明该原生模型的本次读文件与回传；不推及所有模型、API 或 GUI。 |
| 当前主机旧安装 | 官方 app-server initialize 返回 0.167.0-alpha.4.1；0.12.8 两个 hooks 为 enabled/trusted；旧缓存 MCP initialize/tools/list 得到 21 个工具，resources/read 读取 ui://router/settings 静态 HTML 成功 | 证明旧安装的枚举、静态资源和 hook trust；没有 tools/call、浏览器交互或新 0.13.0 安装验收。 |
| 当前 API 兼容状态 | 只读 guard 为 disabled，理由为兼容补丁尚未通过当前 Codex 版本验证 | API/DeepSeek 不据此派发。状态字段并非实时连接测试；未改 guard、settings 或用户开关。 |
| 未验收 | 本轮没有真实 DeepSeek/API/DSH 外部调用；未执行 Apply、启网关、构建/patch CLI | 不声称认证、推理、工具执行或新插件 GUI 已通过。 |

旧 0.10/0.11 和 CLI 0.164 的补丁、授权、安装与验收记录仅为 [按需历史资料](history/README.md)。当前 CLI 是 0.167.0-alpha.4.1；旧 hash、receipt、角色发现和成功/失败记录不能替代当前兼容校验。配置/凭据存在、catalog 可读、MCP 资源可读均不等于外部调用成功。

当前主机基线由主控独立只读核验，不在发布包内存放本机路径、原始配置、身份 ID 或日志。候选 0.13.0 的实装与真实 GUI 结果须另行补充明确日期和范围。
