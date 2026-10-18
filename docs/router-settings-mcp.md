# 路由设置 MCP 面板

该面板把 `native-api-settings` 的路由 JSON 暴露为可点击的 MCP App，并在插件设置页提供结构化设置。它只修改固定位置的路由设置文件；默认不安装角色、不启动服务或模型，也不发起真实 API 请求。安装/应用能力必须由显式注入的生命周期接口提供。

## 入口与元数据

入口工具是 `router_settings_open`，只接受 `{}`。它声明：

```json
{
  "_meta": {
    "ui": {"resourceUri": "ui://router/settings"},
    "openai/ui": {"entrypoints": [{"type": "global"}, {"type": "thread"}]}
  }
}
```

`resources/list` 暴露 `ui://router/settings`，`resources/read` 返回 `text/html;profile=mcp-app` 的自包含 HTML。页面没有远程脚本、样式、字体或网络请求。

入口结果只返回 `resourceProvided: true` 和资源 URI，表示服务器提供了 UI 资源。它不返回 `opened`，也不证明宿主实际显示了面板或侧栏；实际显示必须在目标宿主中验收。

`initialize` 在 MCP `2025-11-25` 上声明 `tools`、`resources` 与：

```json
{
  "experimental": {
    "openai/settings": {
      "readTool": "router_settings_read",
      "updateTool": "router_settings_update"
    }
  }
}
```

`router_settings_read` 只接受 `{}`，返回 `SettingsReadResult` 形状的 `schema`、`values`、`layout`。每个 schema 属性都有当前值或默认值。`router_settings_update` 接收 `{set}`；原生设置页只提交发生变化的原始字段。

## 工具

| 工具 | 用途 |
| :--- | :--- |
| `router_settings_open` | 提供面板资源；接受 `{}`，不唤醒聊天或模型，不声称宿主已显示。 |
| `router_settings_read` | 读取结构化设置 schema、值和布局；只读。 |
| `router_settings_update` | 更新模式/固定执行器/峰谷选择；保存时使用 revision CAS。 |
| `router_settings_snapshot` | 读取完整嵌套配置、选择器和精确 revision，供面板渲染。 |
| `router_settings_save` | 用 `{settings, expectedSha256}` 保存完整配置；stale revision 被拒绝。 |
| `router_settings_save_profile` | 新增或编辑 API 配置；编辑生成新不可变版本，旧版本保留。 |
| `router_settings_check_credential` | 只检查本地 env/file/DSH 账号引用是否可用；返回 boolean，不返回密钥。 |
| `router_settings_executor_status` | 调用注入的只读生命周期状态；默认全部未知，不启动服务或模型。 |
| `router_settings_apply` | 仅在用户点击后调用注入的应用接口；默认明确 unsupported/not installed。 |

所有设置工具都不接受文件路径参数。生产路径由 `defaultRouterSettingsPath()` 固定为本机 `LocalAppData` 下的 `sol-luna-deepseek-router/native-api/router.json`；测试通过隔离的 `LOCALAPPDATA` 注入临时目录。

## 面板行为

- 模式：自动峰谷、固定执行器、自定义峰谷。固定模式不使用峰谷选择；自定义峰谷只读取一组成对的高峰/低谷选择器。
- API 配置：名称、Base URL、Responses 或 Chat Completions、精确模型名、推理支持/默认值/参数名、凭据引用。
- 凭据来源：DSH 自动账号、环境变量名、绝对文件路径。界面没有 API key 输入框，也不会把 key 文件内容送到页面。
- 环境变量凭据只检查当前 MCP 进程可见的环境。若宿主使用 `env_vars` 白名单启动插件，需要确认所选变量已被转发；面板不会读取或显示变量值。
- 编辑配置：以原配置为基准生成新 profile ID；旧 profile 保留给已运行的 child 续问。当前生效的固定/峰谷选择器会迁移到新 profile ID。
- 同名 alias：只能从被编辑的旧版本安全迁移；若 alias 已被另一配置占用，保存失败且不写入。
- 选择器：面板可使用 alias，但写入设置时统一解析为不可变 profile ID。仅修改标签/别名且 API 定义未变时，不会声称新增了角色。
- 保存：使用 `sha256` revision CAS。发生并发修改时提示重新载入，不覆盖其他窗口的写入。
- 连接检测：本地检查只说明“凭据引用可用”，不请求 API，不声称认证、余额或计费已验证。

## 上下文预算

API 编辑表单的“高级”区提供可选的“上下文预算（tokens）”数字输入：

- 取值范围是 1024–2000000 的正整数。
- 显式存在时作为 profile 定义的一部分参与 profile hash；缺失时保持旧 profile 的 hash 不变。
- 新配置默认填 128000。用户应按所选模型的上下文上限设置；这是工作预算，不是对模型真实上限的探测或声明。
- 编辑缺少该字段的旧 profile 时输入保持为空；留空表示不写入该字段。

当前 worktree 的 `native-api-settings` 校验器尚未合并 `contextWindow` 字段。UI、MCP 输入 schema、范围校验和测试接口已经预埋；在字段 commit 集成前，保存带该字段的 profile 会明确返回“当前设置核心尚未支持 contextWindow；配置未保存”，不会静默丢弃。集成后同一路径会原样传递该字段。

`router_settings_snapshot` 的 `capabilities.contextWindow` 会报告当前核心是否支持该字段；面板据此显示内联提示，避免用户把失败误解为保存成功。

安装、重启、网关健康和 API 验证是独立状态。面板显示“已保存”“角色已安装”“需重启”“本地网关”“API 调用”。默认未注入生命周期时安装、重启和网关未知，API 调用未验证；注入 `getExecutorStatus` 后显示真实只读结果。写入 JSON 不会被说成已安装或可调用。

## 生命周期状态注入

`createRouterSettingsService` 和 `createPluginMcp` 接受两个异步 seam：

```js
getExecutorStatus({settings, profileId?})
applyApiConfiguration({settings, expectedSha256?})
```

- `getExecutorStatus` 默认返回 `installed/runtimeCompatible/restartRequired/gatewayRunning/localHealthy/credentialAvailable = "unknown"`、`apiVerified = false`，并说明状态未接入。它不启动服务或模型。
- 注入结果可返回上述字段的 boolean 或 `"unknown"`。`apiVerified` 在本阶段强制为 `false`；本地网关健康或凭据可用不会被当作模型/认证已验证。
- `applyApiConfiguration` 默认返回 `applied:false, supported:false`，并明确说明当前 runtime 未提供应用接口。只有注入函数明确返回 `applied:true` 才显示已应用。
- `createPluginMcp` 将 options 原样透传给 `createRouterSettingsService`；后续由 root 接入 production lifecycle module。

状态工具是只读的，且不会因本地健康推断 API 验证。状态详情会做常见凭据模式脱敏。

## 应用 API 配置

面板的“应用 API 配置”按钮是显式用户动作，工具为 app-visible 的 `router_settings_apply`：

- 未注入应用接口时，快照的 `capabilities.applyApiConfiguration` 为 `false`，按钮默认禁用，并显示“当前 runtime 未提供 API 配置应用接口”。
- 点击后使用当前保存的 `sha256` revision；stale revision 在调用注入接口前被拒绝，提示重新载入。
- 同一服务内并发应用只允许一个请求进入生命周期接口；重复点击显示正在进行，不会双重应用。UI 在请求期间禁用按钮。
- 当前代码不执行安装、下载、启动或重启。它只把 `{settings, expectedSha256}` 交给注入接口。

未来在已安装且兼容的 runtime 下，lifecycle 的 apply 只应应用 owned API profile roles/catalog/provider/Task；不得自动下载或安装 runtime，不得关闭或重启 Codex，也不得调用模型。新增角色需要提示完整重启 Codex 后生效。

## UI bridge

页面用原生 `postMessage` 实现 MCP Apps 标准流程：

1. 发送 `ui/initialize`，携带 `appInfo`、`appCapabilities` 和 `protocolVersion`。
2. 读取宿主返回的 `hostCapabilities`、`hostContext`，应用主题变量。
3. 发送 `ui/notifications/initialized`。
4. 通过 `tools/call` 调用设置工具，并处理 `ui/notifications/tool-result`。

如果 `hostCapabilities.serverTools` 缺失，页面显示“宿主未提供 tools/call 代理能力”，禁用读写并停止。它不会伪造成功状态。

## 验证

```powershell
node .\tests\plugin-router-settings.test.mjs
node .\tests\plugin-mcp.test.mjs
```

测试使用真实 stdio MCP 子进程完成 `initialize`、`tools/list`、`resources/list`、`resources/read`、设置读取/更新/重读、CAS 冲突、非法 profile、alias 迁移、`resourceProvided`、默认未知状态、默认 unsupported apply 与旧 DSH 工具 ownership guard。另用注入 mock 覆盖 installed/healthy 状态、`apiVerified` 强制 false、状态详情脱敏、并发 apply 锁和 stale apply CAS。

宿主实际是否把入口显示为永久侧栏或线程侧面板，仍需要在目标桌面版本中人工验收；静态测试和模拟宿主不能证明该显示行为。
