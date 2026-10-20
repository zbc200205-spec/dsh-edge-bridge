# DSH Edge Bridge（Edge 扩展）

一个 MV3 扩展，让 DeepSeek Harness（DSH）能够读取并操作真实 Edge 窗口：快照页面、点击、输入、按键、滚动、截图。

它自己主动连到本机桥（`ws://127.0.0.1:17373/edge`），**不需要**任何外部服务或账号。

## 安装（加载解压缩的扩展）

1. 打开 `edge://extensions`
2. 打开左下/右侧的 **开发人员模式**
3. 点 **加载解压缩的扩展**，选择本目录（含 `manifest.json` 的那一层）
4. 点扩展图标可看到桥的连接状态；默认端口 `17373`，会自动在 `17373–17380` 之间探测

> 用 DSH 插件里的 `edge_launch` 启动的 Edge 会自动带上本扩展（独立 profile），无需手动安装。

## 权限说明

| 权限 | 用途 |
| --- | --- |
| `tabs` / `scripting` / `webNavigation` | 读取标签页、注入页面脚本、等待页面加载 |
| `debugger` | 仅在 `trusted=true` 的真实输入/整页截图时使用 CDP |
| `storage` | 保存桥端口/令牌等设置 |
| `alarms` | service worker 被回收后自动重连 |
| `<all_urls>` | 注入页面操作脚本（点击/输入/快照） |

## 结构

```
manifest.json        MV3 清单
background.js        service worker 入口（连接 + 保活）
bridge-tab.html/js   可选“常驻桥接页”（页面级连接，不怕 SW 被回收）
popup.html/js        设置与状态
lib/bridge.js        桥客户端：发现端口、握手、重连、命令往返
lib/commands.js      命令实现表
lib/tabs.js          标签页解析/开关/导航/等待
lib/page.js          注入与调用页面侧 agent
lib/cdp.js           真实输入（CDP）与截图
inject/agent.js      注入页面的 DOM API：快照/定位/点击/输入/滚动
```

## 命令协议（桥 → 扩展）

```jsonc
// 桥 → 扩展
{ "type": "cmd", "id": "c1", "cmd": "click", "params": { "target": { "ref": "3" } }, "timeoutMs": 30000 }
// 扩展 → 桥
{ "type": "result", "id": "c1", "ok": true, "result": { "…": "…" } }
{ "type": "result", "id": "c1", "ok": false, "error": { "message": "…", "code": "…" } }
```

命令：`status`、`tabs.list`、`tabs.open`、`tabs.activate`、`tabs.close`、`navigate`、
`snapshot`、`click`、`type`、`key`、`scroll`、`wait`、`screenshot`、`eval`、`highlight`、`info`、`focus`、
`bridge.tab`、`debug.scripting`。

> `eval` 与 `wait` 的表达式条件走 CDP 的 `Runtime.evaluate`（页面主世界）。
> 原因：MV3 隔离世界禁止 `eval`/`new Function`（扩展 CSP 没有 `unsafe-eval`），
> 而且 `chrome.scripting.executeScript` 把这种失败放在 `frame.error` 里、`result` 为 undefined。

## 已知限制

- `edge://`、`chrome://`、扩展页、部分 PDF 查看器等受保护页面无法注入脚本。
- `file://` 页面需要在该扩展详情里打开“允许访问文件 URL”，否则请用 http 服务（桥自带 `/test-page`）。
- 默认的 DOM 合成点击/输入 `isTrusted=false`；对严格校验真实事件的站点请用 `trusted=true`（会挂调试器，标签页顶部会提示“正在调试此浏览器”）。
- service worker 空闲后可能被浏览器回收，重连可能延迟数秒；勾选“打开常驻桥接页”可避免。
