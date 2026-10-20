# 交接说明：dsh-edge-bridge 0.2.1

这是一个给 DeepSeek Harness（DSH）用的插件，装好后你的 agent 可以直接操作你正在用的
Microsoft Edge：读页面内容、点按钮、填表单、滚动、截图（14 个 `edge_*` 工具）。

**你不用敲命令。** 安装工作由你的 agent 完成，你只需要把下面那句话说给它。

---

## 一、怎么装（三步）

**第 1 步**：把这个压缩包解压到任意目录（不要在 zip 里直接运行，先解压）。

**第 2 步**：在 DSH 里对你的 agent 说：

> 解压目录里的 `AGENT-INSTALL.md` 是给你的安装任务，照它把插件装好并自检，
> 装完告诉我结果和下一步。

路径改成你实际解压的位置。你的 agent 会自己找到 DSH 的 profile 目录。

**第 3 步**：agent 装完会自己自检，看到 **扩展已连上桥 ✔** 就是装好了。

要不要重启 DSH？**多数情况不用**：DSH 会自己发现 profile 变了，几秒内重新加载插件。
agent 会通过自检查版本确认；只有工具没出现或版本还是旧的，才需要重启一次。

---

## 二、你的 agent 会改什么（先说清楚，免得意外）

| 它做的事 | 说明 |
| --- | --- |
| 往 DSH 的 profile 目录里放一个插件包 | `node_modules/dsh-edge-bridge`，以及 `vendor/dsh-edge-bridge-0.2.1.tgz` |
| 在 profile 的 `package.json` 里加两条登记 | 一个依赖项 + 一个 `dsh.profile.bundles` 条目；**改动前会备份** |
| 用 DSH 自带的 pnpm 跑一次 `install` | 让登记进 `pnpm-lock.yaml`。**不做这步，下次 pnpm 装任何插件都可能把它挤掉** |
| 一般不重启；必要时请重启一次 | agent 自己不能重启（它跑在 DSH 里面），所以重启要你动手 |

它**不会**做这些：不动你的浏览器设置、不动 profile 里的其它插件、不联网装依赖
（这个插件是零依赖的，只用 Node 自带模块）。

---

## 三、装完之后是什么体验

- 第一次让它打开网页时，会**另外开一个 Edge 窗口**。那是独立 profile，不影响你日常
  浏览器的书签、登录状态和历史。
- 想让它操作你**日常那个** Edge 窗口，需要你自己去 `edge://extensions` 开启「开发人员模式」
  →「加载解压缩的扩展」→ 选 `<profile>\node_modules\dsh-edge-bridge\edge-extension`。
  这一步会碰你浏览器里的真实数据，所以留给你自己决定，agent 不会替你开。

---

## 四、安全与隐私（建议先读这一段）

- 插件在 DSH 内部起一个**只监听本机回环** `127.0.0.1:17373` 的桥，连接需要握手下发的随机 token，
  局域网里其它机器连不上。
- Edge 扩展申请的权限里包含 `debugger`：只在「真实事件点击/输入」「整页截图」「页面内执行 JS」
  这三种操作时使用，用的时候浏览器顶部会出现「正在调试此浏览器」的提示条，属正常现象。
- 换句话说：**装上之后，你的 agent 能看到你浏览器里页面的内容。** 只在你信任这个 agent 的
  前提下装；不确定就先别装。

---

## 五、出问题怎么办

一句话交给 agent：

> 按 `AGENT-INSTALL.md` 的「失败对照表」排查这次的问题。

那张表覆盖了实际遇到过的全部情况：工具不存在、`duplicate loader entry id`、
`edge_status` 报 lossless JSON、加载的是旧副本、扩展没连上、扩展被禁用、截图拿到旧画面、
端口探测范围、以及漏了 `pnpm install` 导致插件被挤掉。每一条都写了原因和下一步。

---

## 六、卸载

一句话交给 agent：

> 按 `AGENT-INSTALL.md` 的「回滚」一节卸载，然后告诉我需要重启。

卸载会删掉插件目录、`vendor` 里的安装包，以及 `package.json` 里那两条登记。
如果你之前把扩展装进了自己日常的 Edge，那需要你在 `edge://extensions` 里手动移除。

---

## 七、包里有什么

| 文件 | 作用 |
| --- | --- |
| `AGENT-INSTALL.md` | **给你的 agent 的执行说明**（目标、步骤、自检、失败对照表、回滚） |
| `dsh-edge-bridge/` | 插件源码，内含 Edge 扩展 `edge-extension/` |
| `dsh-edge-bridge-0.2.1.tgz` | 与上面同一份内容的安装包；agent 若走 `dsh plugin add` 就用它 |
| `HANDOVER.md` / `README.txt` | 就是本文（两份内容相同，`.txt` 双击即可用记事本打开） |
| `CHANGELOG.md` | 这个版本改了什么 |

版本 0.2.1 · 未在除 Windows + Edge 之外的平台验证过
