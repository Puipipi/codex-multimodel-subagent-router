# 隔离 CLI 安装编排

`native-isolated-install.mjs` 提供 `prepare`、`activate`、`rollback`、`status` 源码入口，并由 mock 测试覆盖。它将已验证的 CLI、child-only 配置、三项受管环境变量、独立网关目录、Task Scheduler 任务和旧受管 Startup VBS 作为一个可审计事务编排。一次正式安装已在单一主机通过，详见[主机安装记录](native-formal-install-2026-10-18.md)；其他主机仍须本地核验，桌面验收仍待完成。第三项 `SOL_LUNA_NATIVE_INSTALL_JOURNAL` 保存本事务 journal 的绝对路径，供之后新建的 DeepSeek child 使用。

`prepare` 要求显式路径、当前主模型/provider（provider 可为 `null`）和 root URL 预期（可为 `null`），并要求 `--gateway-script` 或 `--plugin-root` 指向正式安装位置。若旧 role/catalog 残留需纳入迁移，必须显式传入 `--legacy-manifest-path` 指向经验证的旧安装 manifest；工具不会自动发现或认领未知文件。它只准备私有网关身份，不启动服务；随后在临时 Codex home 上运行只读 app-server smoke。临时配置复用完整模型缓存并将 root catalog 指向临时缓存，正式配置仍保持用户主模型/provider/catalog。若迁移旧共享配置，smoke fixture 使用 legacy manifest 恢复旧 root 值。只有 smoke 返回 `status=passed` 才会写入 journal。

smoke 完成后，`prepare` 仅对路径校验通过的本次临时 fixture 删除执行有界 EBUSY 重试：最多 10 次、间隔参数 350 ms，Node 的线性退避总等待上限为 19.25 秒；这不是整个 `prepare` 的硬超时。最终删除仍失败时，`prepare` 保留安全诊断并阻止写入 journal。

`activate` 首先重验 runtime、文件、事务中的环境快照、旧受管 Startup VBS、任务快照和 launcher。之后按顺序写入隐藏同步 VBS launcher、注册或验证精确匹配的当前用户 Task Scheduler 任务、启动并检查独立 gateway，再删除旧受管 Startup VBS，最后应用 Codex 文件与环境变量。Task 使用当前交互用户、Limited 权限、IgnoreNew、隐藏运行且无执行时限；它调用正式安装目录的 `native-gateway.mjs --serve --deepseek-only`。严格模式只接受 DeepSeek 模型，拒绝 GPT/未知模型和加密协作输入，并强制关闭 GPT relay；它不会要求或伪造 GPT 登录成功。dispatch gate 还要求健康响应明确报告 `deepseek_only=true`、`relay_allowed=false`，且受管 Task 状态为 `Running`，因此旧的非严格网关不能满足正式路径。普通 direct/legacy 网关仍保留旧兼容行为。不创建 DSH 会话或工作区。激活失败会尝试按本事务快照恢复；若任何阶段恢复不确定，会将 journal 标为 `activation_recovery_failed` 并列出阶段。

`rollback` 先检查所有受管值仍等于本事务写入内容，再恢复文件、环境、Startup、任务和 launcher。它只会在网关由本事务启动且当前 PID、身份与健康检查仍匹配时停止网关；既有受管任务/网关会保留。用户后续修改会导致回滚拒绝覆盖。成功迁移时，journal 的 `autostart.retiredLegacy` 单独记录旧受管 Startup 是否已退役；因此即使 root config 已无旧 marker、但 manifest 证明存在旧 role/catalog 残留，成功 rollback 也不会重建旧 Startup。此标记不扩大 `files.legacyMigration`。激活失败发生在旧安装退役完成前，仍逐字恢复 prior Startup。旧 journal 未包含该标记时，rollback 仍按旧 `legacyMigration` 判断兼容行为。迁移事务还保留两种配置快照：激活失败时恢复原始字节；用户主动 rollback 时恢复经过 manifest 验证的 `prior_root` 干净配置并移除隔离配置。`prior_root` 若本来就是用户的 localhost 设置，则按原值保留。首次安装无 config 迁移时，config 文件仍逐字恢复 prior；已退役的受管 Startup 不恢复。缺少迁移卸载快照的旧 journal 会在更改状态前明确拒绝卸载。`status` 的 `configured=true`、`restartNeeded=true` 只表示配置已写入并需要重启；`runtimeObserved=false` 和 `desktopAccepted=false` 仍为真实桌面验收前的状态。需要桌面重启后单独验收，不能由 mock、配置 smoke 或 task health 推断 UI 接受。

配置合并只识别精确的三个受管 TOML 表；marker 范围内后来加入的 `[[skills.config]]` 表会按原文、顺序及相邻空行/注释保留。dispatch 与回滚仍严格验证受管 provider、role 等字段，真正的受管字段漂移或 marker 外变更不会被当作可合并修改。主动 rollback 仅在受管表仍匹配且 marker 外内容未变时，保留后来新增的 skill 表并移除本插件配置；这不表示其他后续配置改动都可合并。

本次已激活主机的 0.10.3 客户端升级不会重新注册或改指向当前受管 Task。该主机的当前 journal 仍指向 0.10.2 cache 中的 gateway 脚本；升级后须保留该旧 cache。对应 gateway 服务代码在 0.10.3 中未变，因此本次无需迁移 Task 或重新激活。已暂存的 runtime 文件和 Sol 的根配置连接也不变。

所有命令均要求显式路径；以下值是占位符，不含凭据。主模型/provider/URL 应填写当前实际值，不要将包含凭据的 URL 写入 shell 历史、journal 或任务参数。`--plugin-root` 应是正式安装目录，不能指向工作区源码目录。

```powershell
node .\scripts\native-runtime.mjs stage `
  --artifact-dir "<build-artifact-directory>" `
  --companion-dir "<stock-codex-bin-directory>" `
  --runtime-dir "<private-runtime-root>"

node .\scripts\native-isolated-install.mjs prepare `
  --version-dir "<staged-version-directory>" `
  --codex-home "<codex-home>" `
  --gateway-dir "<new-private-gateway-directory>" `
  --plugin-root "<installed-plugin-root>" `
  --startup-dir "<user-startup-directory>" `
  --journal-path "<private-journal-path>" `
  --expected-main-model "<current-main-model-slug>" `
  --expected-main-provider null `
  --expected-root-base-url null

# When old role/catalog files must be included, pass the verified manifest explicitly:
#   --legacy-manifest-path "<verified-old-install-manifest>"

node .\scripts\native-isolated-install.mjs status --journal-path "<private-journal-path>"
node .\scripts\native-isolated-install.mjs activate --journal-path "<private-journal-path>"
node .\scripts\native-agent.mjs --executor deepseek --json
```

第一阶段只暂存 CLI 和 companions。第二阶段准备隔离配置、smoke 与事务快照，不写正式配置、不改环境、不注册任务、不启动 gateway。第三阶段才应用配置并注册独立任务；成功后完全退出并重新启动 Codex，使后续新 chat 继承更新后的 HKCU 环境。已运行的 Codex 不会自动刷新该环境。每次 DeepSeek dispatch 前，`native-agent.mjs` 优先使用显式 `--install-journal`，否则读取 `SOL_LUNA_NATIVE_INSTALL_JOURNAL`，并用该 journal 验证任务、配置与 gateway health；缺失或异常时明确失败，不会扫描其他位置、自动注册、直启、调用 DSH 或重放任务。Luna 继续使用当前模型缓存解析模型，不经过此 gateway。

当前主路由的 ordinary task routing 不运行安装命令，也不会自行修改全局配置、环境变量、计划任务或重启桌面。用户明确要求 setup/activate 时，不重复要求授权。普通协作使用原生 Codex child；DSH MCP 仅供用户显式选择的 legacy 工作流，且不会创建原生 Codex child session。

如需撤销本事务且受管状态未被后续修改：

```powershell
node .\scripts\native-isolated-install.mjs rollback --journal-path "<private-journal-path>"
```

journal 使用 base64 保存原始 Buffer 快照；Windows 文件访问继承父目录 ACL，本模块不更改 ACL。准备/配置和桌面生效是不同阶段；其他主机须独立核验，且任何已配置状态都不等于桌面接受验收。
