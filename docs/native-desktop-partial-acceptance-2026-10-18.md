# 原生 DeepSeek 桌面部分验收（2026-10-18）

本记录只覆盖一次主机上的有限桌面观察，不代表完整验收或整体目标完成。用户重启后，两个实际 Codex 进程的可执行文件均与插件 0.10.4 所配置的运行器 SHA256 `b311c3c365d1a9a5c19a6040428e02d49b10d7bdd766a859f0b842d42c3e3963` 匹配；运行器本身未升级。正式 native-agent readiness gate 三次均退出码 0。三项受管环境变量在用户级与本次 native child 进程中均为 3/3 匹配；该进程审计不代表对桌面进程环境的直接读取。

同一个原生 DeepSeek child 使用 `fork_turns: none`，前三轮均 completed 且 `error=null`。首轮耗时 35,465 ms，验证写入 UTF-8 文件；父指令误指向包清单文件名后，child 找到 canonical plugin manifest 并完成多次读取，因此该耗时不代表启动延迟。第二轮耗时 11,888 ms，child 基于同一上下文回忆并追加第三行。最终文件为 97 bytes、3 行，精确内容核验通过，SHA256 为 `3529f73b057d19ba92f07cecf17734f60dc66ff77572f56f0071dcfc74b768fe`。

第三轮是用户要求的纯只读重复提交，thread/read 记录耗时 7,094 ms，状态为 completed、error 为 null，包含 3 条 agent 消息和 2 条 command execution。child 先后输出进度、读取文件、输出进度并计算 SHA；用户确认进度和结果自动显示。本次观察证明这一轮的实时更新可见；用户报告曾打开同一面板但未看到第二轮更新，原因没有复现或解决，不能据此宣称稳定性问题已修复。该耗时是整个只读任务时长，不是启动延迟。

rollout 记录的模型是 `deepseek/deepseek-flash`，fork 策略为 `none`。rollout 本身没有 provider 字段；`deepseek-native` 来自正式 role 配置的独立观察，不能伪称为 rollout 字段。仅前两轮的 gateway 记录包含 10 次请求，HTTP 200 为 10/10，relay 为 0；对应 usage 记录与 10 条 gateway 记录匹配：input 1,936,151、output 5,885、total 1,942,036、cached input 1,746,944 tokens。这些计数仅覆盖前两轮，不包括第三轮、审计、主控或历史运行，也不表示 Codex 配额百分比或全目标零用量。

仍待验收：新建子代理入口的及时发现、全部历史记录可点击、完整冷启动恢复、多主聊天隔离及 hooks 通知。整体目标未完成。本记录不证明故障矩阵已通过，也不将此前观察过的面板更新问题描述为已修复。
