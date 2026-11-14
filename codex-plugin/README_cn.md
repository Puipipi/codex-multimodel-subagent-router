# Codex 主控 · 多模型峰谷子代理

0.13.0 候选的活跃 plugin、marketplace、MCP、skill 标识统一为 `codex-multimodel-subagent-router`。使用 `$codex-multimodel-subagent-router`；主智能体保持会话和模型，审阅子代理结果。

- [当前入口与五个不变量](SKILL.md)
- [按需执行契约](references/execution.md)
- [当前能力、实测与未验收边界](references/capabilities.md)
- [旧补丁、授权和验收资料索引](references/history/README.md)
- [安装身份迁移与回滚](docs/identity-migration.md)
- [打包与测试](README.md)

当前官方 CLI 基线为 0.167.0-alpha.4.1；不能用旧 0.164 补丁证明当前 API 能力。本轮原生 gpt-6.1-sol 读文件并回传、旧安装 MCP 枚举及静态资源读取有证据；真实 API/DeepSeek/DSH 调用、新候选实装及 GUI 交互尚未验收。用户路由开关和 API 兼容守卫原样保留。

只迁移安装/显示身份，旧 state 根、settings、profile ID、role、租约、可信归属、child 绑定与协议键保持原位，不复制或重算。只允许一个活跃插件和一个可发现 canonical skill，旧目录 scripts 和旧 cache 保留以兼容在途引用。普通任务不会触发 Apply、绕过 gate 启网关或切换后端。
