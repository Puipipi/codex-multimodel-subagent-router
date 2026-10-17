# 原生网关生命周期测试回执

2026-10-18，模块提交 `ec850f2c81d86f34c5702bd5a75b5998ce3f1136` 在 Windows PowerShell 7 下通过一次私有临时生命周期 probe，退出码为 0。测试使用自建 Windows Job、Task Scheduler 和 mock loopback 服务，不发模型/API 请求。

结果显示 detached/hidden 直接 helper 与 gateway 在关闭测试 Job 后都退出；Task Scheduler 启动的 gateway 在 Job 关闭后仍运行。两次启动只留下一个 launcher 进程，测试窗口计数均为 0。本回执保存了 [脱敏 JSON 输出](native-gateway-lifecycle-2026-10-18.json)。

测试驱动位于私有 work tree：`work/native-gateway-lifecycle-probe/windows-job-lifecycle.ps1`，未打包进仓库，因此本仓库没有可公开复现该实测的脚本入口。测试没有关闭真实 DSH 树，没有使用正式安装的 gateway，也没有验收桌面 native child UI。正式安装和桌面接受状态仍待完成。

本轮测试拥有的临时 task、进程和目录均已清理。早先另一次尝试的临时目录仍有两个空日志文件，删除操作被策略阻止；该遗留与本次成功 probe 的清理结果分开记录。

同日另一个私有 mock 生命周期 probe 以 exit 0 通过，覆盖 gateway 崩溃后的 Task Scheduler 恢复，以及端口冲突下的有界启动超时和释放端口后的显式恢复。超时返回 `NATIVE_GATEWAY_START_TIMEOUT` / `operation_timeout`；manager 的 900ms deadline 仅约束健康等待，不是整个 Task Scheduler 操作时限；整段操作实测 4206ms，包含 Scheduler 开销。没有 direct-spawn fallback 或自动重试。清理断言通过，临时任务和进程已清理。脱敏字段已合并进 [本回执 JSON](native-gateway-lifecycle-2026-10-18.json)，不含进程 ID、端口、用户路径或随机运行标识。详细原始脱敏报告保存在私有 work tree 的 `port-conflict-full-pass-2026-10-18.{md,json}`，没有将 probe 脚本打包进仓库。

这两次证据都使用自有临时 Task/Job 与 mock 服务，没有发送模型或上游请求，也没有触碰 production gateway；它们不证明旧失败的根因已知，也不等同于正式安装 gateway、DSH 真实进程树或桌面 native child 的验收。
