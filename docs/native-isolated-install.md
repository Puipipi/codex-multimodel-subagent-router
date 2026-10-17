# 隔离 CLI 安装编排

`native-isolated-install.mjs` 连接已验证 runtime、隔离文件事务、两项用户环境变量和登录自启动。`prepare` 要求调用方传入所有路径以及当前主模型、主 provider（可为 `null`）和 root URL 预期（可为 `null`），验证 staged runtime，并为隔离 gateway 目录运行只读 app-server smoke。Smoke 使用临时 Codex home；从用户缓存复制完整模型列表，只在临时配置中把 root catalog 指向这份本地缓存，并确认当前主模型/provider、root URL、DeepSeek 独立 loopback、role 路径及 compaction capability。迁移旧共享配置时，临时配置也使用对应 legacy manifest 恢复 prior root 值。Smoke 返回 `status=passed` 后，才会将真实文件/环境/自启动计划快照写入以 `0600` 请求创建的 journal。Windows 上文件权限由父目录 ACL 继承；模块不更改 ACL，调用方应把 journal 放在受保护目录。本模块尚未完成正式安装，也不会自动选择用户 HOME。

`activate` 按顺序写入 Codex 文件、`CODEX_CLI_PATH` 与 plaintext alias，再将自启动指向新的 gateway 目录。失败时按条件恢复已完成阶段，并在 journal 中记录失败阶段。若阶段自身的部分恢复失败，状态会是 `activation_recovery_failed`，并列出不确定阶段，不能误当成干净回滚。成功只表示配置已写入；状态返回 `configured`、`restartNeeded`，并明确 `runtimeObserved=false`、`desktopAccepted=false`。桌面应用重启后是否接受此隔离 CLI 仍需单独验收。直接用 stock CLI 启动的会话不会自动获得此补丁支持。

`rollback` 不依赖 runtime 仍存在；只在三类受管状态仍等于本事务写入值时撤销，用户后续修改会被保留并使回滚明确失败。`status` 只显示阶段和路径，不显示配置正文、gateway token 或运行态对象。journal 的 Buffer 快照使用 base64 编码。

`native-autostart.mjs` 的 `--gateway-dir` 是可选参数；省略时保留原有行为。自动启动仍使用隐藏、非阻塞的 VBS 启动器。本次只添加编排与测试，没有调用真实环境 setter、启动/停止生产 gateway、重启桌面应用或切换已安装 CLI。真实启用和桌面端接受状态仍未验证。

## 显式安装命令

以下命令只是路径占位示例。`expected-main-model` 和 provider 必须对应当前主会话配置；`null` 只用于当前 provider 未设置时。`expected-root-base-url null` 只用于当前 root 没有 base URL 覆盖时。若实际 root URL/provider 不同，请传入实际值；不要把含凭据的 URL 写进命令历史、日志或任务文本。普通路由不运行这些命令；用户明确要求设置或启用时，按该请求执行即可，无需重复询问授权。

```powershell
node .\scripts\native-runtime.mjs stage `
  --artifact-dir "<build-artifact-directory>" `
  --companion-dir "<stock-codex-bin-directory>" `
  --runtime-dir "<private-runtime-root>"

node .\scripts\native-isolated-install.mjs prepare `
  --version-dir "<staged-version-directory-returned-above>" `
  --codex-home "<codex-home>" `
  --gateway-dir "<new-private-gateway-directory>" `
  --startup-dir "<user-startup-directory>" `
  --journal-path "<private-journal-path>" `
  --expected-main-model "<current-main-model-slug>" `
  --expected-main-provider null `
  --expected-root-base-url null

node .\scripts\native-isolated-install.mjs status --journal-path "<private-journal-path>"
node .\scripts\native-isolated-install.mjs activate --journal-path "<private-journal-path>"
```

第一阶段只生成并暂存已校验的版本目录。第二阶段 `prepare` 会在独立 gateway 目录运行 smoke，并写下受管文件、两项环境值和自启动的快照 journal；它不写正式 Codex 配置、不改环境或自启动。第三阶段 `activate` 才应用这些配置；返回 `configured=true`、`restartNeeded=true`，不代表桌面已采用新 CLI。之后需要单独重启 Codex 并验收桌面子代理；`status` 会继续显示 `runtimeObserved=false` 和 `desktopAccepted=false`，直到另行加入运行态证据。

如需撤销本事务且受管文件、环境和自启动仍保持本次写入值：

```powershell
node .\scripts\native-isolated-install.mjs rollback --journal-path "<private-journal-path>"
```

回滚保留用户之后的编辑；若阶段出现部分恢复失败，journal 会标记不确定阶段，不能据此断言已恢复干净。以上命令尚未在真实用户配置或环境上执行；桌面端接受状态仍待验收。
