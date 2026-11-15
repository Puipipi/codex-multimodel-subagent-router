# 安装身份迁移与回滚（0.13.1）

仅本插件的安装与显示身份改为 `codex-multimodel-subagent-router` / “Codex 主控 · 多模型峰谷子代理”。registry、插件 key、MCP key 和 canonical skill 目录一致。旧 `sol-luna-deepseek-router` 是持久存储/协议兼容身份，不是待清理的数据目录。

保留所有旧 state 路径、settings、profile IDs/roles、ownership/租约、child/model/provider 绑定、nonce、schemas、managed markers、scheduler task、env/header keys。不复制或双写 state，不重新计算任何身份，不修改模型选择、API guard、用户开关、凭据或 runtime。旧 cache 不删除，旧 skill 目录和 scripts 保留；只把旧 SKILL.md 改为 SKILL.legacy-disabled.md。

## 选择安装路径

首次安装且没有启用旧标识时，按 [README](../README_cn.md) 的新标识命令安装。旧 `sol-luna-deepseek-router@sol-luna` 已启用时必须按下文先禁旧、再安装新插件；单独 `plugin add` 不会自动禁旧。下文迁移 helper 同时切换旧独立 Skill，要求旧 `<codex-home>/skills/sol-luna-deepseek-router/SKILL.md` 存在；若只有旧插件而无旧独立 Skill，不要伪造 Skill 或运行 helper。先在实际 Codex home 的 `config.toml` 中仅把 `[plugins."sol-luna-deepseek-router@sol-luna"]` 下的 `enabled = true` 改成 `enabled = false`，保留其余内容与旧 cache；用 `codex plugin list --json` 读回旧标识 disabled 后，再使用首次安装路径。当前官方 CLI 没有 `plugin disable` 子命令；不要误用旧标识的 add。

已使用新标识但更换解压路径时，先用官方 `codex plugin marketplace remove codex-multimodel-subagent-router` 移除旧来源注册，再 `marketplace add <新解压根目录>`、`plugin add codex-multimodel-subagent-router@codex-multimodel-subagent-router`。官方 0.169 隔离实测该操作保留旧/新缓存和旧插件 disabled 状态；不是卸载插件。若继续原目录，可直接更新该目录后 add，无需换来源。迁移 begin/activate 期间不要变更来源；所有来源变更必须先于 prepare 的 config hash 快照。

## 工具边界

`scripts/migrate-router-identity.mjs` 只进行本地文件迁移；不会启动网关、Apply API、调用模型、构建/patch CLI 或写 auth。prepare 从生成的 plugin bundle 准备新 canonical 文件，入口暂存为 SKILL.pending.md；拒绝覆盖既有目录、符号链接/reparse point 和重复 codex-plugin/skills 子树。journal 仅保存路径、文件 hash、两个 owned plugin 表及 config hash，不保存其余 config、auth、profile 或凭据。

先用官方 CLI 注册新 marketplace 来源，再读 config revision 并 prepare；marketplace add 只注册来源，不启用 plugin，但会写入 marketplaces 表，必须在 foreign hash 快照之前完成。begin 以 config 字节 SHA-256 比较后将旧 plugin 设为 disabled。官方 CLI 随后负责新 plugin/cache 安装：0.167 的 plugin add 会启用新 plugin，且没有 --disabled / plugin disable；所以必须先 begin，不能先 add 再禁旧。始终至多一个 enabled plugin。activate 只接受调用者明确读回的当前 config hash、无外部字段变化的两个 owned 表，以及与准备 bundle 逐文件一致的实际安装 cache；先让两个 plugin disabled，切换唯一 SKILL 发现入口，再启用新 plugin（继承原旧插件开关）。新 hook trust 不继承为已验收。

rollback 在已记录的 config revision 上禁用两个 plugin，恢复旧 SKILL 和旧 owned 表；新文件变回 pending，cache/脚本原样保留。若官方安装后尚未 activate，rollback 需传当前明确读回 hash，工具还会校验非 owned 字段没有变化。未知并发改动会拒绝覆盖；先人工核对，再恢复，不提供强制覆盖选项。部分失败保留 journal，按同一 rollback 恢复；不自动重试安装或后端。

## 可审查命令

下列是迁移操作，不属于普通路由。先准备最终同步且已检查的 bundle；所有路径必须为实际规范绝对路径，journal 位于本机私有位置，勿提交。

```powershell
$cfg = Join-Path $env:CODEX_HOME 'config.toml'
# 未设置 CODEX_HOME 时，显式指定实际 Codex home 下的 config.toml。
# 先注册来源：此命令写 marketplaces 表，不启用新 plugin。
codex plugin marketplace add <repo-root>
# 确认成功后再冻结 config revision；不能把 marketplace add 放到 prepare/begin 之后。
$revision = (Get-FileHash -LiteralPath $cfg -Algorithm SHA256).Hash.ToLowerInvariant()
node scripts/migrate-router-identity.mjs prepare --bundle <repo-root>/codex-plugin --skills-root <codex-home>/skills --config $cfg --journal <private-dir>/identity.json --expected-config-sha256 $revision
node scripts/migrate-router-identity.mjs begin --journal <private-dir>/identity.json
# 读回旧 plugin 已 disabled；有错误就停并 rollback。
codex plugin add codex-multimodel-subagent-router@codex-multimodel-subagent-router
# 有界等待 CLI 完成，观察退出码并定位其真实新 cache，不能手工伪造 cache 注册。
$installedRevision = (Get-FileHash -LiteralPath $cfg -Algorithm SHA256).Hash.ToLowerInvariant()
node scripts/migrate-router-identity.mjs activate --journal <private-dir>/identity.json --installed-plugin <actual-new-plugin-cache> --expected-config-sha256 $installedRevision
```

begin 已禁旧后再进行官方安装，若该命令失败，原位核对 config/hash 后执行 rollback。安装命令超时不等于失败，先确认进程/安装结果，不能盲目重复 add。工具的 byte CAS 在本插件迁移锁内做写前复核，但该锁不是宿主共享锁，最后读取与 rename 之间仍有外部写入窗口，不能保证跨进程原子 compare-and-swap。官方 CLI 或其他编辑器必须在阶段间串行操作；迁移期间暂停其他 config 写入。

```powershell
# 正常 activate 后，或工具内部部分失败后：
node scripts/migrate-router-identity.mjs rollback --journal <private-dir>/identity.json
# CLI add 后但 activate 前，需显式当前读回 revision：
node scripts/migrate-router-identity.mjs rollback --journal <private-dir>/identity.json --expected-config-sha256 $installedRevision
```

切换后独立验收：manifest/MCP identity、唯一 skill、hook trust、settings/guard/state hash、租约竞争、MCP initialize/tools/resources 与真实 GUI。不能把隔离迁移 fixture、静态资源或包 hash 当成实装成功。当前证据见 [capabilities](../references/capabilities.md)；新候选主机部署由主控单独执行。

## 离线证明

`node tests/router-identity-migration.test.mjs` 在独立临时目录验证：marketplace 来源已注册且新 plugin 尚未注册时准备、保留 marketplaces 表、先禁旧后注册新、唯一 SKILL、旧 scripts/state 保持、原开关继承、CAS/目标/cache 冲突、三个中途失败和回滚。它模拟官方 CLI 的本地 config 注册结果，不是官方安装或外部调用验收。
