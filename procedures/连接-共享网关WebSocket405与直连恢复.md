# 连接-共享网关WebSocket405与直连恢复

> **Scope**: project:sol-luna-deepseek-router
> **触发**：Sol/Luna 请求旧共享网关时出现 WebSocket 握手 405、响应提示 `POST only`，客户端持续重试；主配置 root `openai_base_url` 指向旧 HTTP gateway。
> **验证**：TOML 可解析；两个旧 gateway root 键及孤立 marker 已消失；主模型与修复前相同（本次为 `gpt-6.1-sol`）；与私有快照逐字比较后，差异仅为经证明的两条键行和孤立 begin 行；listener 仍在运行。一次受控重启后，新请求不再走旧 gateway，才算确认当前客户端已直连。

## 首选
先核验 manifest、root 键、marker、provider 和当前配置字节。marker 完整时使用唯一 begin/end 的常规去块流程；事故 marker 残缺时必须限定到获批的完整源 SHA 和逐条证明的 root 行，只删除已批准的精确范围。写前重读并比较目标 bytes，私有保存原配置快照，原子写入并记录 before/after SHA。回滚只允许在当前配置仍精确匹配 after SHA 时恢复快照；若用户之后修改过，拒绝覆盖。

本次私有事故工具已验证，但未随仓库分发；后续现场恢复应先按上述字节、范围和备份原则制定并审阅方案，不要把私有工具路径当成仓库命令。

## 被挡时
- marker 完整时，只移除验证通过的受管块，并按 manifest 恢复 prior_root。
- marker 缺失/残缺、哈希不符、键重复、provider 不符或 manifest 值不匹配时停止；先取得对应现场的可信来源证明和明确授权，不扩大删除范围。

## 别再来
| 弯路 | 为什么不通 |
| --- | --- |
| marker 缺 end 时从 begin 删除到 EOF，或补造 end 后假装块完整 | 会吞掉其后的用户配置；孤立 marker 不是范围证明。 |
| 用旧 `native-install` rollback 处理 root 两键 | `scripts/native-install.mjs` 的 rollback 会先尝试 stop gateway，再删 role/catalog/manifest 和 Startup；这超出只恢复连接配置的范围。 |
| 对 PID、端口或日志名不明的旧 listener 执行 stop/kill | listener 可能不归本插件拥有；`scripts/native-gateway-manager.mjs` 只在进程身份可核验时才允许 stop。保留它，直到 ownership 已证明。 |
| 让 Sol 与 Luna 再次共用 DeepSeek gateway | 两个主会话的 provider/client 会继续指向共享 HTTP-only 路径，扩大故障面；DeepSeek 子任务必须留在独立 provider 路由。 |
| 只改配置后依赖 runtime refresh，或把当前已运行进程当成新配置已生效 | `codex-rs/core/src/session/session.rs` 按 session configuration 创建 `ModelClient`；`codex-rs/core/src/config/runtime_refresh.rs` 与 `codex-rs/core/src/session/config_refresh.rs` 更新允许热刷新的配置，并不会重建现有客户端。安排一次受控重启，再用新请求验证。 |

## 注意
- `scripts/native-gateway.mjs` 的 Responses handler 对非 POST 方法返回 HTTP 405 `POST only`；客户端 WebSocket 握手不是 POST，所以 HTTP-only handler 会在模型请求处理前拒绝并触发重试。
- 本次事故只在获批源 SHA `de0710635155dd5aa900c8080081cf04c4fea5e71e35ad1ccd8e46ee63be9ae5` 下移除 `openai_base_url`、与 manifest 匹配的 `model_catalog_json` 和孤立 begin marker；before/after SHA 分别为 `de0710635155dd5aa900c8080081cf04c4fea5e71e35ad1ccd8e46ee63be9ae5`、`40458bcb9772f8e3bcfc310facc5a906a554fe86b153179b3aaa9ee0cbec9787`。哈希变化或其他配置字节变化都应拒绝。
- 配置写入不负责停止、重启或接管 listener、Startup、Task 或其他进程；这些对象保持原状。旧进程 ownership 未验证前不可清理。

证据：`scripts/native-gateway.mjs`、`scripts/native-install.mjs`、`scripts/native-gateway-manager.mjs`、pinned upstream commit `4ebc485ca321243727539187169425fcf972f2c4` 的 `codex-rs/core/src/session/session.rs`、`codex-rs/core/src/config/runtime_refresh.rs`、`codex-rs/core/src/session/config_refresh.rs`。
