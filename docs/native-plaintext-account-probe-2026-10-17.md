# 原生明文子代理隔离验证证据报告

## 范围与版本
仅固定版本、单次协议验证，不构成未来兼容性或桌面 UI 验收。账号修复 `sol-luna-deepseek-router` 0.9.1 已发布，HEAD `9ae0eced28df43f97e72e1dda9cd696455cb2066`，CI `39037323908` passed。生产网关优先 DSH account grant 的官方 `x-dsh-auth-token`，旧 key 非当前认证；production tiny `/responses` 返回 200、45 tokens、0 relay，仅连通性。生产仍保留既有 GPT 解密 relay，明文方案尚未安装启用。

明文模块取自 OpenCodex `6936d9885d8a9bda9301737affcbaf1a4ff00e17`（MIT），standalone 引入 `work/native-plaintext-account-probe`，仅改 canonical ChatGPT Responses v2 新工具消息。native DeepSeek 是非 DSH 外部 trace，由 isolated Codex 0.162 app-server 的 native spawn+followup 创建，仍不是桌面 UI 验收。

## 历史记录（保留）
首跑 `20261017134942-a9f96678` raw pass=false：同 child 两轮、精确 proof、6 次 DeepSeek 200、0 relay 成立；失败因探针强制上游 `[]` 与 close 未等 exit。父查原进程已退出、auth 副本已清理，原结果未改。

第二跑 `20261017135401-83e44f43` raw exit 0/pass=true/failures=[]，但被父审计推翻，不是正式通过：12 请求为 prepare 5（openai 4 + DeepSeek 7 + `/models` 1），第 5 个正常 parent 汇报被 hard-cap 429 挡住；parent rollout task_complete 带 429/cap error、last_agent_message 为 null。`turn/completed` 只是终止事件；其功能数据保留供比较，不作通过证据。

## 第三次正式有效证据
`20261017135940-20314131` exit 0、pass=true、failures=[]，13 请求小于 16 cap。parent `01a14a29-448b-7281-93e1-9af4bffdff8b`，child `01a14a29-908f-7561-9e3e-ec27c0ae729a`（native DeepSeekFlash DSH account auth）；parent 模型保持 gpt-6.1-sol。RPC parent event 为 completed/error 空；thread/read 最后 parent turn 为 completed/error 空且有最终 assistant；child 两 turn 均 completed/error 空。父独立审计 rollout：parent 1 个 completed、0 error、final 非空；child 2 个 completed、0 error、final 非空。实际 commandExecution+fileChange、proof 两行精确、同 child 追问、真实 native 父子关系。6 次 DeepSeek 官方 Responses 全 200，6 次正常 Sol 主控请求，GPT relay 0/denied 0。6 prepared、18 markers removed、5 restored calls、0 restore failures；`encrypted_function_args` 省略 seen 0，不合成，不影响 native 执行。main input 95214/cached 69760/output 586/total 95800；DS input 497791/cached 494720/output 2196/total 499987；relay 0。均为 raw token，不能折算 Codex 额度百分比，也不声称全体 GPT 用量为 0。auth_cleaned true、owned_app_server_exited true；父查原进程已退出，保留常驻 production gateway 服务（账号）供其它会话，未关闭 DSH Desktop。

## 结论与局限
免费 mock 累计 29 组通过（21 + close 4 + turn-outcome 4），无真实 API；第三 run 真实由父执行。结论仅：isolated Codex 0.162 原生协议链路通过，不是 DSH 外部 trace 伪装。生产 0.9.1 已安装发布，正式生产路径仍保留旧 GPT relay，明文优化仅在实验目录未启用；未验证 Luna 经明文、多聊天或真实桌面 UI。当前原始聊天 native custom model 仍 Unknown model、NodeRepl 工具 sandbox init 失败，整个 goal 未完成。下步正常重载 Codex 回同一聊天，验证当前主流量/模型注册、真实 native 子代理可点历史和多聊天，再决定接入明文。

## 路径
最新结果 `work/native-plaintext-account-probe/redacted-result.json`；代码同目录；三次 run 记录在相对 `private/` 下，本报告未读取、未复制日志/转写/密钥/auth。
