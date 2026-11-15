# Codex 主控 · 多模型峰谷子代理

0.13.1 的活跃 plugin、marketplace、MCP、skill 标识统一为 `codex-multimodel-subagent-router`。使用 `$codex-multimodel-subagent-router`；主智能体保持会话和模型，审阅子代理结果。

- [当前入口与五个不变量](SKILL.md)
- [按需执行契约](references/execution.md)
- [当前能力、实测与未验收边界](references/capabilities.md)
- [旧补丁、授权和验收资料索引](references/history/README.md)
- [安装身份迁移与回滚](docs/identity-migration.md)
- [打包与测试](README.md)

历史 2026-11-14 官方 CLI 基线为 0.167.0-alpha.4.1；2026-11-15 的隔离 ZIP 安装验证使用官方 0.169.0-alpha.11.1。不能用旧 0.164 补丁证明当前 API 能力。本轮原生 gpt-6.1-sol 读文件并回传、旧安装 MCP 枚举及静态资源读取有证据；新候选已完成官方 0.167 隔离安装、身份切换、回滚及 MCP 枚举/静态资源验证，新 hooks 为 enabled/untrusted，未推定人工授信。日常真实安装在该基线仍为 0.12.8；真实主机切换、GUI 与 API/DeepSeek/DSH 外部调用需分别验收，后续本机状态以对应 receipt 按需读取。用户路由开关和 API 兼容守卫原样保留。

## 下载与安装

下载 [最新 ZIP](https://github.com/Puipipi/codex-multimodel-subagent-router/releases/latest/download/codex-multimodel-subagent-router.zip) 和 [SHA256SUMS.txt](https://github.com/Puipipi/codex-multimodel-subagent-router/releases/latest/download/SHA256SUMS.txt)，核对哈希后解压到长期保留的目录。根目录和 `codex-plugin/` 内的插件清单都应为新标识、版本 0.13.1；安装来源是根目录市场条目指向的 `./codex-plugin`。

**首次安装，且没有启用旧插件时：**

```powershell
codex plugin marketplace add <解压根目录>
codex plugin add codex-multimodel-subagent-router@codex-multimodel-subagent-router
codex plugin list --json
```

**从旧 0.12.8 / sol-luna 身份升级：**先按[迁移指南](docs/identity-migration.md)禁旧、安装新插件、切换唯一 Skill；不能直接套用首次安装命令，否则旧插件不会自动关闭。旧目录和缓存保留。

**已经是新标识，只更新版本：**优先保留原注册解压路径，替换为核验后的新 ZIP 内容，再执行上述 `plugin add`。如要改到另一个解压目录，先执行 `codex plugin marketplace remove codex-multimodel-subagent-router`，再用新根目录执行上面两条安装命令。官方 0.169 隔离实测该 marketplace remove 不删除插件缓存，也不重新启用旧插件；不要误用 `plugin remove` 或重新添加旧标识。

安装后 `plugin list --json` 应显示新标识 0.13.1 enabled，旧标识不存在或 disabled。新 hook 需走官方 `/hooks` 审阅，不自动授信。此处安装/枚举验证不代表电脑操作、付费 API 或自动派发已验收。

只迁移安装/显示身份，旧 state 根、settings、profile ID、role、租约、可信归属、child 绑定与协议键保持原位，不复制或重算。只允许一个活跃插件和一个可发现 canonical skill，旧目录 scripts 和旧 cache 保留以兼容在途引用。普通任务不会触发 Apply、绕过 gate 启网关或切换后端。
