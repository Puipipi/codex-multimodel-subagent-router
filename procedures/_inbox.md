# 排查收件箱

## 2026-10-18：隔离网关与插件路由排查复发记录

- 网关生命周期：`detached`/`unref` 或登录 Startup VBS 不能证明进程在父 Job/进程树清理后仍存活。私有自建 Job + Task Scheduler + mock loopback probe 已 PASS，证明此测试 Job 关闭后 Task 启动的 mock gateway 存活；它没有关闭真实 DSH 树，也未验收正式安装 gateway/桌面 UI。见 `docs/native-gateway-lifecycle-2026-10-18.md`。正式安装与桌面验收仍待完成。
- Windows Node 启动：`Get-Command node.exe` 可能返回多个候选；把 `.Source` 数组拼接后传给 `CreateProcess` 会导致 Win32 错误 123。启动前选定并校验单一绝对 executable 路径。
- helper 状态字段：wrapper 向 `WaitReady` 传错 `state` 字段会造成假超时。诊断要同时核对实际退出码和 ready/state 证据，不凭等待超时推断服务未启动。
- 配置验证：DeepSeek dispatch 不能对整个 `config.toml` 做字节相等校验，否则用户更新 Sol 主模型会被误拦。只验证本模块拥有的配置区块及 gateway 身份，同时允许用户修改区块外主配置。
- 临时目录清理：精确临时目录删除若被策略阻止，应记录清理失败并保留证据，不得换用其他工具绕过策略；可能遗留空日志文件时只记录通用现象，不记录私人路径、token 或随机标识。
- DeepSeek 直连计费隔离：正式 Task 的 `--serve` 旧默认仍启用 GPT relay（`maxRelayCalls=Infinity`），因此不能仅凭 DeepSeek provider 配置声称已消除 GPT 桥接。原因是 strict flag 未进入正式 serve command/constructor；修复方向为显式 `--deepseek-only`，仅接受已知 DeepSeek 模型、封锁加密 GPT relay 输入并将 relay cap 设为 0。尚未真实触发 GPT relay 或产生计费；只用 loopback/fake-fetch 验证。
- 多工作目录：临时 probe 目录不是 Git 仓库；Git 审计、提交与推送必须显式指定实际源码仓库的 workdir，避免把 not-a-repository 当成仓库故障。
- Release 构建缓存：workflow 若只缓存 `target/debug`，即使 Cargo 依赖缓存命中，后续 `--release` 仍需完整重编译；恢复和保存路径都应包含 `target/release`，并记录旧缓存缺少 release 产物这一限制。
- Actions 缓存路径迁移：`path` 元数据参与 cache version；给四路径布局增加 `target/release` 后，相同 key/restore-prefix 也不能命中旧三路径版本。先尝试新布局，未匹配时才用同一 restore action 做旧三路径只读回退；它只能复用依赖和 debug 产物，首轮 release 仍需完整编译。

- 旧共享网关迁移卸载：原始文件快照含受管 localhost 区块，主动 rollback 若直接恢复会复活已退役地址；安装失败仍恢复原快照，成功迁移后的卸载应恢复验证过的 prior_root 干净配置，并保留后续编辑冲突检查。

## 2026-10-18：native child dispatch 诊断证据边界

- mock Responses 发出 `function_call` 的计数只证明 fixture 返回了工具调用项，不证明 app-server 已成功 dispatch 或创建子线程；必须保存匹配 call_id 的 `function_call_output`、检查 `thread/started` 以及子线程父链，再判断失败阶段。
- `FunctionCallOutputBody` 在线格式可为纯字符串或 content-item 数组；提取器不能仅假设字符串 JSON/object，诊断 fixture 应保留有界的实际 output 形态与安全错误信息。
- 本次 app-server 临时目录只有空子目录，Windows 返回 EPERM 且ACL继承显式拒绝删除；保留目录与证据，不通过其他命令、ACL修改或替代工具绕过拒绝。

## 2026-10-18：native child agent_name 格式校验

- 正式 CLI 的本地 mock probe 实测拒绝了 `native-isolation-deepseek-child`，错误为 `agent_name must use only lowercase letters, digits, and underscores`；native/Luna/测试 task name 及由 nonce 生成的后缀必须规范化为小写字母、数字和下划线。修复 harness 名称后再验证 child dispatch，不能把 tool call 已发出当成 child 已创建。
- 组合 patch：公共 patch 是无 `diff --git` header 的 unified diff；追加 portable patch 时要按字节拼接并保持 LF，PowerShell `Add-Content`/`Set-Content` 可能写 CRLF。用 .NET `WriteAllBytes`，再以 `git -c core.autocrlf=false apply --check` 和落盘 SHA 验证；只替换当前 runtime 常量/断言/文档 SHA，历史 run/binary SHA 保持原样。
