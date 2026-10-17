# 排查收件箱

## 2026-10-18：隔离网关与插件路由排查复发记录

- 网关生命周期：`detached`/`unref` 或登录 Startup VBS 不能证明进程在父 Job/进程树清理后仍存活。私有自建 Job + Task Scheduler + mock loopback probe 已 PASS，证明此测试 Job 关闭后 Task 启动的 mock gateway 存活；它没有关闭真实 DSH 树，也未验收正式安装 gateway/桌面 UI。见 `docs/native-gateway-lifecycle-2026-10-18.md`。正式安装与桌面验收仍待完成。
- Windows Node 启动：`Get-Command node.exe` 可能返回多个候选；把 `.Source` 数组拼接后传给 `CreateProcess` 会导致 Win32 错误 123。启动前选定并校验单一绝对 executable 路径。
- helper 状态字段：wrapper 向 `WaitReady` 传错 `state` 字段会造成假超时。诊断要同时核对实际退出码和 ready/state 证据，不凭等待超时推断服务未启动。
- 配置验证：DeepSeek dispatch 不能对整个 `config.toml` 做字节相等校验，否则用户更新 Sol 主模型会被误拦。只验证本模块拥有的配置区块及 gateway 身份，同时允许用户修改区块外主配置。
- 临时目录清理：精确临时目录删除若被策略阻止，应记录清理失败并保留证据，不得换用其他工具绕过策略；可能遗留空日志文件时只记录通用现象，不记录私人路径、token 或随机标识。
