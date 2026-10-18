# 原生子代理文件能力验收（2026-10-18）

本记录补充 staged65 Windows CLI 的本地验收：以 loopback mock provider 执行一个只读命令和一次临时 workspace 文件写入。它不是 DeepSeek API 调用、正式安装或桌面 UI 验收；没有修改生产安全设置，也没有激活构建产物。

构建身份与已发布的 [staged65 runtime 记录](native-plaintext-runtime-2026-10-18.md)一致：Codex `0.163.0-alpha.10.2`、源码提交 `4ebc485ca321243727539187169425fcf972f2c4`、patch SHA-256 `65add65b454f29e9c16726b27993f58176a99b0bd6bb73355fc72a32836774ae`、binary SHA-256 `b311c3c365d1a9a5c19a6040428e02d49b10d7bdd766a859f0b842d42c3e3963`、provenance SHA-256 `644c27784e4b0de3b17f354c0592f53980ffefa1f03a9ffa52ea765a9c1cd356`。

只读 case 通过：parent 与 DeepSeek child 均完成，真实 rollout 的 session ID 与 `permission_profile` 已验证；两者 profile enum 均为 `disabled`。child 的 `commandExecution` 恰有一项，状态 completed、exit code 0。mock 收到 1 个 function call、0 个 custom call；配对输出匹配且无错误。主路由和 DeepSeek loopback mock 各收到 2 个请求，清理成功。该结果证明这次只读命令执行完成，不涉及文件写入。

独立的 `authorized-file-proof` case 也通过严格 gate。临时 workspace 中的 `proof.txt` 为 60 字节，精确内容匹配，UTF-8 无 BOM、LF 行尾，SHA-256 为 `b762573c11f2d4ed74bd34824d995ef3314691ab3ee14d4cd6bf9c945cb93be5`。真实 rollout 的 parent 与 child session ID、`permission_profile` 均验证通过，profile enum 均为 `disabled`；`commandExecution` 恰有一项且 completed、exit code 0，mock function/custom 调用数为 1/0，配对输出无错误，清理成功。case 先检查了 `config/read` 的 `danger-full-access` 与 `never`，并在 `thread/start` 显式请求 full access。

过程中的两次无效证据不作为运行失败：首次只读 fixture 在 mock 响应顺序错误时提前返回 assistant final，没有发出 FunctionCall；随后一次 wrapper 因 PowerShell 单字符串索引错误而丢弃安全 stdout。直接捕获结果后，只读严格 gate 通过。更早的三次真实 API 文件验收仍保持失败；旧 workspace-write 配置与本次 full-access harness 是已知设置差异，但旧运行实际 profile 或失败根因未知，不能据此认定因果。相关历史见 [runtime 记录](native-plaintext-runtime-2026-10-18.md)。

脱敏回执 SHA-256：只读 case `5D7D93BC599B13BB496C231F4DC17940FAF96B5C4048340DDF36580F3C8D71F4`；文件写入 case `CA9C1CC74EA3C9C50970CE5AC33ADA4B90B321E52F79906D3550E94569DD59B8`。结构化投影见 [JSON 证据](native-authorized-file-proof-2026-10-18.json)。
