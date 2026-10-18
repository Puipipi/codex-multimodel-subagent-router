# 0.10.5 bounded retry 候选（2026-10-18）

此文档记录源码候选，不是发布或安装回执。插件 manifest 候选版本为 `0.10.5`；portable marketplace 只定位本地仓库源，没有独立版本字段，沿用现有格式。

该候选仅让专用 `native_deepseek` role 设置 `unbounded_connection_retries = false`。Rust role allowlist 现在接受该 feature 的禁用项，并保留 `!enabled` 限制，不能由 role 启用此 feature。Sol/root 的 feature 默认值及其他角色配置保持不变。历史 `0.10.4` 安装/验收证据不因候选号变更而重述或升级。

GitHub Actions run `39113348109` 的新 Rust role regression 已观察到预期 RED：前序 Core DeepSeek tests 和该测试的编译均成功；targeted step 确认 `running 1 test`，`apply_role_can_disable_unbounded_connection_retries_without_changing_parent` 因 `parent_enabled=true, role_enabled=false` 时仍得到 `true` 而失败（0 passed、1 failed、2659 filtered out）。RED patch 的SHA为 `7689ca21cf42c9b9e29a7956b515f58651bae5a9f8a4e38c30790982b78a6925`。增加 disable-only role allowlist 的完整候选 patch SHA为 `7a5c127a24c2c2b80d3933ad9590c4766fb7a1a99b4a917bc607eedde1f734d8`；它尚未通过 GREEN build，尚未形成可发布 runtime，也没有执行安装、激活或桌面重启。
