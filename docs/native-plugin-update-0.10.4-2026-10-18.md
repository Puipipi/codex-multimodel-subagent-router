# 0.10.4 插件包更新记录（2026-10-18）

本记录覆盖一个主机的插件包安装与 standalone skill 同步，不代表所有主机状态。来源为已发布 commit `2b2100b9f828e22828ca8c54f99ec472ff380c1e`，CI run `39108853950` 成功。官方 marketplace 更新流程三步均退出码 0；插件 `sol-luna-deepseek-router` 已启用版本 `0.10.4`。干净包与插件缓存 123 个文件逐项匹配，唯一 router skill 的 66 个 canonical 文件也逐项匹配。

安装时快照中，root model 为 `gpt-6-astra`，属于已知模型目录；root provider、base URL 和 catalog 均 absent。用户级三项受管环境变量 3/3 匹配，安装进程环境为 0/3。native DeepSeek readiness gate 退出码 0，Task 为 Running，严格 DeepSeek-only 健康检查通过；该安装步骤没有发起模型 API 请求，relay 调用数为 0。

安装时 config.toml 的整体 SHA 从 `b6e93b…` 变为 `56c169…`。上述 root 四项保持不变，但安装前没有非 root 配置摘要，因此无法细分其余差异，也不声称其他配置全部未变。没有回滚未知配置变化。前后快照没有保存健康状态中的 PID，所以不能证明进程 PID 连续或据此声称 PID 未变；回执将这两项标为未知。

这份安装时快照记录 `runtimeObserved=false`、`desktopAccepted=false` 和需要重启。用户随后已完整重启；重启后的运行器与 DeepSeek 桌面验收另行记录，本页不把安装时 readiness 结果当作该次重启的桌面验收。

完整安全字段见[结构化回执](native-plugin-update-0.10.4-2026-10-18.json)。此前的正式安装、稳定网关和部分故障记录保持独立，分别见[正式安装记录](native-formal-install-2026-10-18.md)、[稳定网关验收](native-stable-gateway-acceptance-2026-10-18.md)和[部分故障验收](native-formal-fault-acceptance-2026-10-18.md)。
