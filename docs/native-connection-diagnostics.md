# 本地连接事件快照

模块 `scripts/native-connection-diagnostics.mjs` 提供显式只读采集函数和 `--collect --json` CLI。没有常驻 watcher，也没有挂接空闲会话的钩子；接入方只能在用户明确请求诊断、且功能启用时调用。`enabled: false` 在检查路径或打开 SQLite 之前直接返回。

采集器仅以只读方式打开 Codex Rust 日志库 `CODEX_HOME/logs_2.sqlite`，从 `logs` 表用 rowid 游标最多读取 500 行、最近 72 小时范围内的数据。它只在内存中检查 `target`、`feedback_log_body`（旧 schema 可用 `message`）和 `thread_id`，将命中事件映射为固定枚举；原始消息、请求/响应内容、headers、server reason、URL、密钥和对话正文不会写进快照或返回。快照写在调用者提供的插件专属 `stateDir`，通过同目录临时文件加 rename 原子替换，最多保留 128 个事件。SQLite 缺失、锁定或格式不符时返回 `available: false`，不打断主任务。

事件只含 UTC 时间、受限 target、事件枚举、有限 retry 序号、日志明确记载时的数值 close/status/byte 字段、thread/process 哈希及显式相关性。没有明确 thread ID 时标为 `other_or_unknown`；未配置的子代理也如此。`rootCause` 固定为 `uncertain`。HTTP fallback 事件只证明日志记录了 fallback 尝试，不能证明 fallback 请求成功；没有终态日志也不能推断恢复。

显式 CLI 调用示例（需由集成方提供其插件专属状态目录；命令不会启动模型 turn）：

```powershell
$env:CODEX_HOME = '<Codex home>'
$env:CODEX_CONNECTION_DIAGNOSTICS_STATE = '<plugin-owned state directory>'
node scripts/native-connection-diagnostics.mjs --collect --json
```

仅读取已有快照：

```powershell
$env:CODEX_CONNECTION_DIAGNOSTICS_STATE = '<plugin-owned state directory>'
node scripts/native-connection-diagnostics.mjs --json
```

## 历史事件的证据边界

之前对保留期内 Rust 日志的只读统计为 77 条 WebSocket 错误、112 条 sampling retry、12 条 HTTP fallback、0 条 HTTP 5xx、0 条 compaction retry、3 条 payload-too-large。该统计是当时的临时计数，并未保存在可核验事件快照中。10 月 23 日约 14:36（北京时间）的五次重试与 fallback 记录，发生在不同于父会话 ID 的日志行；当时事件关联线程在 fallback 后没有观察到终态，但无法据此判断请求是否最终成功。日志库之后轮转，incident 行及其 thread/process ID 已不可恢复。以上属于历史诊断记录，不是当前采集结果，也不能用于归因。
