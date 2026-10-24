# Native API 子代理真实运行验收

`tests/native-api-role-cli-smoke.mjs` 提供一个显式绑定二进制 SHA-256 的本地端到端验收。测试在临时 `CODEX_HOME` 和 workspace 启动隐藏的 app-server；父模型与 `native_api` 子代理模型都由测试进程中的固定 localhost Responses mock 回答。代理网关只允许访问精确的 loopback 地址、端口和路径，子进程的外网代理指向本地拒绝服务。

## 执行

先运行不启动 Codex 的 mock 协议自检：

```powershell
node tests/native-api-role-cli-smoke.mjs --mock-self-test
node tests/native-api-role-cli-smoke.mjs --failure-self-test
```

真实运行必须由调用者从已通过 CI 验证的独立 CLI artifact 提供绝对路径，以及从该 artifact 的构建 provenance 单独取得的 SHA-256：

```powershell
node tests/native-api-role-cli-smoke.mjs --binary 'C:\path\to\ci-validated\codex.exe' --sha256 '<CI-provenance SHA-256>'
```

脚本在启动服务前核对 hash；不查询、选择或安装当前系统 CLI，也不读取用户 Codex 配置或凭据。它使用合成 API key，所有固定模型响应均来自 loopback。若无法提供可信 CI provenance，不要用二进制自身计算的 hash 代替期望值。

`--failure-self-test` 在 localhost mock/gateway 已启动后注入初始化失败，并验证监听服务与测试自有子进程都已关闭；它不启动 Codex CLI。

## 验收范围

真实运行要求父模型收到原始任务并发出 `spawn_agent`，子代理以本机 `native_api` role 启动，收到带标记的任务；随后子代理通过真实 `exec_command` 工具调用 PowerShell 创建证明文件，工具结果返回给子代理，子代理和父任务都完成。脚本通过 `thread/list` 与 `thread/read` 核实父子关系、角色、工具调用/输出和最终消息，并核对证明文件字节及 SHA-256。输出只包含验收布尔值、请求计数和哈希，不包含提示词、响应正文、会话 ID、URL 或凭据。

这验证 CLI/app-server 的本地原生 API 子代理和工具调用链，不验证 Codex 桌面 UI、已安装插件或线上模型行为。`--mock-self-test` 只验证 mock/gateway 的本地协议，不代表真实 app-server 运行成功。native API profile 禁用 WebSocket 与重试；此测试也不声称验证 WS 重试或 HTTP fallback。WS close/retry 场景需要单独的窄测试。
