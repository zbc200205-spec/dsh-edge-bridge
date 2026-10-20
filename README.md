# dsh-edge-bridge

让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）直接操作你正在用的 Microsoft Edge：
读页面内容、点按钮、填表单、滚动、截图。

不是无头浏览器，也不是另开一个假渲染器 —— 操作的就是**你眼前那个 Edge 窗口**。

- **零 npm 依赖**：只用 Node 内置模块，装完不需要 pnpm install
- **只监听回环**：`127.0.0.1:17373`，`/edge` 需要握手下发的随机 token
- **14 个 `edge_*` 工具**，注册进 DSH 的 `ctx.tools`

```
┌────────────── DSH 进程（Electron）──────────────┐
│  dsh-edge-bridge 插件                          │
│    · 本机服务 http://127.0.0.1:17373            │
│    · WebSocket 桥 /edge?token=…                │
│    · 14 个 edge_* 工具                          │
└───────────────▲────────────────────────────────┘
                │ JSON over WS
┌───────────────┴──────── Edge（你的浏览器）──────┐
│  DSH Edge Bridge 扩展（MV3）                    │
│    background.js  ── 桥客户端 / 18 条命令        │
│    inject/agent.js ── 快照、定位、DOM 点击/输入   │
│    lib/cdp.js      ── chrome.debugger：真实输入、 │
│                       整页截图、页面内执行 JS     │
└─────────────────────────────────────────────────┘
```

## 安装

### 从 GitHub 装（推荐尝鲜）

```powershell
dsh plugin --profile desktop add github:zbc200205-spec/dsh-edge-bridge
```

### 从 npm 装

```powershell
dsh plugin --profile desktop add dsh-edge-bridge
```

> `desktop` 换成你自己的 profile 名。装完通常**不用重启**：DSH 会在几秒内重新加载
> profile 里的插件（实测约 2 秒），拿 `edge_status` 看版本对得上即可；工具没出现再重启一次。
> 也可以直接在自己的 DSH 市场里搜 `dsh-edge-bridge`。

手工安装（没有 `dsh` 命令时）见 [AGENT-INSTALL.md](AGENT-INSTALL.md)。手工安装**必须**
补做其中第 2.5 步（用 DSH 自带的 pnpm 跑一次 `install`），否则下次 `pnpm install`
会把插件当成多余包清掉。

### 让 Edge 认识这个扩展

第一次用 `edge_launch` 时，插件会自己拉起一个**独立 profile** 的 Edge 并把扩展加载进去，
不影响你日常浏览器的登录状态和书签。

想让 DSH 操作你**日常那个** Edge 窗口，就手动装一次扩展：

1. `edge://extensions` → 开启「开发人员模式」
2. 「加载解压缩的扩展」→ 选 `<profile>\node_modules\dsh-edge-bridge\edge-extension`

## 用法

装好后在对话里直接说，例如：

> 打开 example.com，把页面上的链接列出来

典型流程：`edge_status → edge_launch → edge_snapshot → edge_click [ref] → edge_type → edge_screenshot`

### 工具一览（14 个）

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `edge_status` | 排查：桥在跑吗、扩展连上了吗、有几个标签页 | — |
| `edge_launch` | 拉起带扩展的 Edge（独立 profile） | `url` `profile` `headless` `windowSize` |
| `edge_tabs` | 标签页 list / open / activate / close | `action` `url` `tabId` |
| `edge_navigate` | 导航并等加载完成 | `url` `tabId` |
| `edge_snapshot` | **读页面**：标题、URL、视口、可见文本 + 带 `ref` 的可交互元素 | `maxElements` `includeText` |
| `edge_click` | 点击元素 | `ref` / `selector` / `text`、`trusted`、`clickCount` |
| `edge_type` | 输入文本（可回车提交） | `ref` `value` `clear` `submit` `trusted` |
| `edge_key` | 按键 / 快捷键 | `key` `ctrlKey`… |
| `edge_scroll` | 滚动页面或元素 | `dy` `to` |
| `edge_wait` | 等 selector / 文本 / URL / 表达式 | `selector` `text` `urlContains` `fn` |
| `edge_screenshot` | 视口或整页截图（落盘 + 图片附件） | `fullPage` `format` |
| `edge_eval` | 页面主世界执行 JS（可绕页面 CSP） | `code` `world` |
| `edge_highlight` | 高亮某个 `ref`，便于人工核对 | `ref` |
| `edge_open_bridge_tab` | 打开常驻桥接页（service worker 被回收也不掉线） | — |

**两种点击/输入模式**

- 默认：DOM 合成事件（`isTrusted=false`），不挂调试器，日常够用
- `trusted: true`：走 `chrome.debugger` 发真实鼠标/键盘事件（`isTrusted=true`），
  适合严格校验真实事件的站点；代价是该标签页会被挂上调试器，浏览器顶部出现提示条

## 权限与安全

扩展申请：`tabs` `scripting` `storage` `alarms` `debugger` `webNavigation` + `<all_urls>`。

- `debugger` 只在「真实事件输入（`trusted`）」「整页截图」「`edge_eval`」时用到
- 桥只监听 `127.0.0.1`，并校验来源必须是回环地址；局域网内其它机器连不上
- 插件跑在 DSH 进程里，除本机回环外不联网
- 说清楚一点：装上之后，你的 agent 能看到你浏览器里页面的内容。只在你信任这个 agent 的前提下装

## 配置（可选）

加载行由插件包自带的 `cordis.patch.yml`（`dsh.bundle.patch`）插入，所以配置写成**按 id 覆写**，
不要再写 `insert`（两份同 id 条目会得到 `duplicate loader entry id`）：

```yaml
- id: dsh-edge-bridge
  name: dsh-edge-bridge
  config:
    port: 17373          # 桥端口，扩展会自动在 17373–17380 探测
    host: 127.0.0.1
    edgePath: ''         # msedge.exe 路径，默认自动探测
    extensionDir: ''     # 扩展目录，默认用插件包内的 edge-extension
    userDataDir: ''      # edge_launch 的独立 profile 目录
```

## 常见问题

| 现象 | 处理 |
| --- | --- |
| 工具报「没有可用的 Edge 扩展连接」 | 先 `edge_status`；再 `edge_launch` 一次；确认 Edge 开着、扩展已启用 |
| 首行版本比装的低 / 行为像旧版 | DSH 加载的是 `node_modules\dsh-edge-bridge` 里的旧副本：重装一次，或重启 DSH |
| `edge_status` 报 `value is not lossless JSON` | 加载的是 0.1.x 旧副本（`lastError: undefined`）；装 0.2.0+ 并确认版本 |
| `edge_launch` 报「扩展目录无效：(未提供)」 | 装的是 0.1.0 旧包（扩展没打进包），换 0.2.0+ |
| 扩展显示「已禁用」/ 扩展页报 `ERR_BLOCKED_BY_CLIENT` | 在 `edge://extensions` 把「开发人员模式」关掉再打开；0.2.0 的 `edge_launch` 也会自动尝试恢复 |
| 截图是旧画面（已点击/输入，图里没变化） | Edge 窗口被遮挡时 `captureVisibleTab` 只能拿到最后一次合成的帧：用 `fullPage: true`（走 CDP 现取）或把窗口切到前台 |
| 自定义端口后扩展连不上 | 扩展只在 **17373–17380** 探测；端口必须落在这个区间 |
| 装完过一阵插件自己没了 | 手工安装漏了 `pnpm install`，lockfile 不认它；按 AGENT-INSTALL 第 2.5 步补做 |
| 连接偶尔断几秒 | service worker 被回收，扩展会自动重连；勾选「常驻桥接页」可避免 |
| 受保护页面点不动 | `edge://`、`chrome://`、PDF 页面不允许注入脚本，换普通 http(s) 页面 |

更多：`AGENT-INSTALL.md`（安装与回滚细节）、`HANDOVER.md`（把包交给别人时的说明）。

## 开发

本仓库发布的就是**可安装的包本体**（`lib/` `bin/` `edge-extension/` + 文档），没有构建步骤。
完整测试套件与打包脚本在作者工作区维护，不随仓库发布；克隆下来想快速自查，跑这两条足够：

```powershell
# 1) 包能正常 import、版本对不对
node -e "import('./lib/index.js').then(m => console.log(m.VERSION))"

# 2) 不装进 DSH 也能单跑：起桥 + 拉一个带扩展的 Edge
node bin/edge-bridge.mjs --launch-edge
curl http://127.0.0.1:17373/health
```

## 独立模式（不装插件也能用）

```powershell
node bin/edge-bridge.mjs --launch-edge --headless
curl http://127.0.0.1:17373/health
```

## License

MIT
