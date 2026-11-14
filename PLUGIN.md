# Codex 主控 · 多模型峰谷子代理

0.13.0 候选。安装身份统一为 `codex-multimodel-subagent-router`；持久存储及协议仍沿用旧身份，详见 [迁移说明](docs/identity-migration.md)。

The plugin does not bundle a second scheduling skill. Install the standalone skill separately from the plugin and any custom Codex CLI. There is no automatic release-integration script that synchronizes them. The generated `codex-plugin/` projection is the marketplace source; canonical skill copies exclude this subtree.

Hooks are auto-discovered and installation does not mark them trusted. Review them through `/hooks`. The settings MCP exposes configuration/status and static resources; saving is distinct from explicit Apply. API guard failure does not block native models, while user-off blocks new automatic delegation. API/DeepSeek dispatch requires the approved current running runtime; ordinary task routing never installs or starts one.

Legacy DSH tools require trusted `_meta.threadId`, preserve ownership and writer leases, and are explicit compatibility only. They are never an automatic native fallback. Trace uses a single-use exchange ticket and per-view HttpOnly cookie; it is a snapshot, not a native Codex child panel.

Read [current capabilities](references/capabilities.md) before making availability claims. The 0.13.0 candidate separately passed official 0.167 isolated installation, identity cutover and rollback, plus MCP enumeration/static HTML. Candidate hooks remained enabled/untrusted. Daily-host cutover, real GUI and external API calls remained unverified at the recorded baseline; read later local receipts for host status. Historical 0.10/0.11 patch, authorization and acceptance narratives are accessed through the [history index](references/history/README.md), not loaded into every task.

Package and isolated fixture tests verify source contracts and file operations only. The separate official isolated installation/protocol evidence has the precise scope above; neither establishes real GUI or external-model acceptance.
