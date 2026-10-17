# 原生网关生命周期测试回执

2026-10-18，模块提交 `ec850f2c81d86f34c5702bd5a75b5998ce3f1136` 在 Windows PowerShell 7 下通过一次私有临时生命周期 probe，退出码为 0。测试使用自建 Windows Job、Task Scheduler 和 mock loopback 服务，不发模型/API 请求。

结果显示 detached/hidden 直接 helper 与 gateway 在关闭测试 Job 后都退出；Task Scheduler 启动的 gateway 在 Job 关闭后仍运行。两次启动只留下一个 launcher 进程，测试窗口计数均为 0。本回执保存了 [脱敏 JSON 输出](native-gateway-lifecycle-2026-10-18.json)。

测试驱动位于私有 work tree：`work/native-gateway-lifecycle-probe/windows-job-lifecycle.ps1`，未打包进仓库，因此本仓库没有可公开复现该实测的脚本入口。测试没有关闭真实 DSH 树，没有使用正式安装的 gateway，也没有验收桌面 native child UI。正式安装和桌面接受状态仍待完成。

本轮测试拥有的临时 task、进程和目录均已清理。早先另一次尝试的临时目录仍有两个空日志文件，删除操作被策略阻止；该遗留与本次成功 probe 的清理结果分开记录。
