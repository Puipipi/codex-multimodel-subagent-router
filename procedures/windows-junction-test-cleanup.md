# Windows junction 测试清理

> **Scope**: project:sol-luna-deepseek-router
> **触发**：Windows Node 测试在 `finally` 递归删除包含 junction 的临时根时出现 `ENOTEMPTY`。
> **验证**：保留生产 plan 对 junction 的拒绝断言；测试结束时目标目录仍在、junction 已断开、临时根已删除，且测试退出码为 0。

## 首选

在测试 `finally` 中仅对本测试创建的链接路径执行 `lstat`；确认 `isSymbolicLink()` 后 `unlink(linkPath)`，再删除经过 `path.resolve` 与测试 `mkdtemp` 前缀核对的临时根。清理链接只把 `ENOENT` 视作已不存在，其他错误继续抛出。

## 被挡时

若创建 junction 失败，按实际创建状态清理已存在的测试根；不要猜路径或遍历链接目标。若 `lstat` 显示预期路径不是链接，立即报错并保留现场。

## 别再来

| 弯路 | 为什么不通 |
| --- | --- |
| 直接 `rm(root, { recursive: true, force: true })` | Windows 会尝试处理 junction 目录项，可能以 `ENOTEMPTY` 失败；`force` 不会让它安全地仅删除 reparse point。 |
| 捕获并忽略 `ENOTEMPTY`、`EPERM` 或其他清理错误 | 会把残留 fixture 误报成通过，也掩盖权限或路径问题。 |
| 跳过 junction 安全拒绝断言或放宽生产校验 | 修改了被测安全行为，不能修复测试 fixture 的清理顺序。 |

## 注意

- junction 和 target 都由同一个本次测试 `mkdtemp` 根创建；先确认并断开链接，验证 target 仍在，再递归删除根。
- 只可递归删除通过 `path.resolve`、临时目录父路径与专用前缀校验的本次测试根。

证据：`tests/native-isolated-files.test.mjs`，2026-10-18；`native-isolated-cli-integration-report-2026-10-18.md`。

<!-- 本卡只属于这个项目；项目 ID、哈希表、数据表、绝对路径可以留在这里，不要写进中心库。 -->
