# Native 重启审计记录（2026-10-17）

## 环境与改动

- **已确认：** 桌面版本为 `OpenAI.Codex_26.1013.4894.0`，CLI 为 `0.163.0-alpha.10.2`；主模型仍是 GPT 6.1 Sol。
- **已修复并通过：** manager 现在校验 health 返回的真实 PID，并区分 state PID 与 live PID。旧 PID 误报问题的修复在本工作树，manager 35、gateway 29、autostart 8、install 27 项断言全部通过，共 99 项。
- **未验证：** 修复尚未同步到 installed 文件，生产 gateway 尚未重启。

## 子代理实测

- **通过（首轮）：** 普通 `deepseek/deepseek-flash` native child `01a14a57-87fa-74b3-9a4a-35539f681a09` 返回了中文最终答复；真实桌面子智能体完成列表中出现该 child。
- **失败（第二轮）：** 同一子代理第二轮执行失败，错误为 `missing reasoning_text`。之后 child 从列表消失，点击原卡片显示空白面板；普通 DeepSeek 完整 UI 往返未通过。
- **失败（特殊角色）：** `native_deepseek` 两次遇到 remote compaction 错误，不能据此验收该角色。
- **通过（Luna）：** `01a14a55-6c17-77a2-8747-36f83e64231e` 可打开独立面板，包含工具执行和消息；完成后继续同一 child 有效。重启前四条旧 Luna 历史仍在。

## 未完成项

- **未实现：** Sol/Luna 直连原 OpenAI 服务、仅 DeepSeek 执行路径使用网关的隔离方案尚未实现。
- **未验收：** 普通 DeepSeek child 的完整桌面列表、打开、继续及 compaction 流程；特殊 `native_deepseek` 角色。
- 整体 goal 仍为 active。
