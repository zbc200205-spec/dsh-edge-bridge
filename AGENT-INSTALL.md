# AGENT-INSTALL：把本包装进本机 DSH

> 这份文档是写给**另一个 DSH agent** 执行的任务说明。人类不用看它，把 zip 路径和这句话交给 agent 即可：
> 「解压这个包，按里面的 AGENT-INSTALL.md 装好并自检」。

本文对应 **dsh-edge-bridge 0.2.1**（0.2.1 相对 0.2.0 只有文档与安装说明修正，代码未变）。

## 目标

把 `dsh-edge-bridge` 装进本机 DSH 的 profile，使 agent 能调用 14 个 `edge_*` 工具
（读页面、点击、输入、滚动、截图），操作本机 Microsoft Edge。

- 包**零 npm 依赖**：`package.json` 里没有 `dependencies`，只用 Node 内置模块。**不要**为它跑 `pnpm install --prod` 之类的东西。
- 包**自带 Edge 扩展**：`edge-extension/` 就在包内，不需要另外找扩展目录。

## 第 0 步：确认三件事

1. 平台：Windows（扩展要装进 Microsoft Edge / Chromium ≥ 116）。其它系统本包未验证，如实告诉用户。
2. 找到 profile 目录——它就是**含有 `package.json` 的那个目录**，按顺序试：
   - `$env:DSH_PROFILE_DIR`
   - `$env:DSH_HOME\profiles\desktop`
   - `%USERPROFILE%\.dsh\profiles\desktop`
   - `%USERPROFILE%\.dsh\profiles\web`
3. 确认该目录里同时有 `package.json`（没有就不是 profile，继续找，别硬装）。

记下 `PROFILE=<绝对路径>`，后面命令都用它。

> 如果找不到 profile：停下来问用户「DSH 的 profile 在哪个目录」，不要猜着往别处装。

## 第 1 步：安装（两条路，优先 A）

### A. 有 `dsh` 命令时（首选，官方路径）

```powershell
dsh plugin --profile desktop add file:<解压目录>\dsh-edge-bridge-0.2.0.tgz
```

`desktop` 换成实际 profile 名（就是 profile 目录的最后一级）。它会自己登记依赖与 `dsh.profile.bundles`。

命令不存在或报错 → 走 B，不要反复试 A。

### B. 没有 `dsh` 命令时（等价的手工安装）

```powershell
# 1) 插件目录放进 profile 的 node_modules
$PROFILE = "C:\Users\你\.dsh\profiles\desktop"
New-Item -ItemType Directory -Force "$PROFILE\node_modules" | Out-Null
if (Test-Path "$PROFILE\node_modules\dsh-edge-bridge") { Remove-Item "$PROFILE\node_modules\dsh-edge-bridge" -Recurse -Force }
Copy-Item "<解压目录>\dsh-edge-bridge" "$PROFILE\node_modules\dsh-edge-bridge" -Recurse -Force

# 2) 把安装包放进 vendor（让 pnpm 以后能重装，而不是把它当多余包删掉）
New-Item -ItemType Directory -Force "$PROFILE\vendor" | Out-Null
Copy-Item "<解压目录>\dsh-edge-bridge-0.2.0.tgz" "$PROFILE\vendor\" -Force
```

3) 改 `$PROFILE\package.json`（**先备份**）。需要加两处：

```jsonc
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "dsh-edge-bridge": "file:./vendor/dsh-edge-bridge-0.2.0.tgz"   // ← 加这条
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dsh-edge-bridge"                                            // ← 加这条
      ]
    }
  }
}
```

改 JSON 的三个硬性要求：

- **必须 UTF-8 无 BOM**。带 BOM 的 `package.json` 会让 DSH 读不到 profile（症状是启动后插件全没了）。
  用 Node 写：`fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n', 'utf8')`（默认无 BOM）。
- **只加这两处**，profile 里其它依赖和字段一律不动，顺序无所谓。
- 写完用 `JSON.parse` 读一遍确认合法；失败就用备份还原。

4) **不要**往 `$PROFILE\cordis.patch.yml` 里写 `insert`。插件包自带
`cordis.patch.yml`（`dsh.bundle.patch`），打包时由 DSH 自动应用；再写一份同 id 的
加载行会得到 `duplicate loader entry id "dsh-edge-bridge"`，DSH 会拒绝启动这一层，
而且市场之后会拒绝一切插件更新。

## 第 2 步：等 DSH 热加载；必要时才让用户重启

**你无法自己重启**（你正跑在它里面，重启会中断当前会话）。

实测（DSH desktop，2026-10）：改完 profile 的 `package.json` 后，DSH 会在几秒内
**自己卸掉旧插件、加载新插件**，不需要重启：

- 删掉依赖时，旧桥当场 `stopped`；
- 加回依赖约 2 秒后，日志出现 `registered tools: edge_status, …` 并在 17373 上 `listening`。

**注意边界**：热加载只对「依赖的增删（bundle 集合变化）」可靠。实测把已登记的依赖从
`…-0.2.0.tgz` 换成 `…-0.2.1.tgz`（键没变、只有版本值变）**并没有触发重载**，
运行中的 DSH 仍是旧版本，这时必须重启。所以判断依据只能是第 3 步自检的版本号，别靠猜。

所以顺序是：

1. 改完 `package.json` 后**等 10 秒**，直接做第 3 步自检。
2. 只有自检发现「工具不存在」或「版本还是旧的」，才请用户重启一次 DSH。
3. 两种情况都要如实说：不用重装依赖、不改 Edge 设置。

热加载是否发生取决于 DSH 版本与改动类型，**不要向用户承诺「一定不用重启」**；以第 3 步自检为准。

## 第 2.5 步：让这次安装真正持久（最容易漏掉）

第 1 步只做到「现在能跑」。profile 是个 pnpm workspace，`pnpm-lock.yaml` 和
`node_modules\.modules.yaml` 里还记着**旧路径**。下次谁跑一次 `pnpm install`，
这插件就解析失败、或被当成多余包清掉。所以装完要让 pnpm 认知它。

用 DSH 自带的 pnpm（不需要全局安装），在 profile 目录里跑一次：

```powershell
$PROFILE2 = "C:\Users\你\.dsh\profiles\desktop"
$RUNTIME  = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies"
Copy-Item "$PROFILE2\pnpm-lock.yaml" "$PROFILE2\pnpm-lock.yaml.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Force
Push-Location $PROFILE2
& "$RUNTIME\node\node.exe" "$RUNTIME\pnpm\bin\pnpm.mjs" install
Pop-Location
```

成功的判据（三个都要看）：

1. `pnpm-lock.yaml` 里该依赖的 `specifier` 是 `file:./vendor/dsh-edge-bridge-<版本>.tgz`；
2. `node_modules\.modules.yaml` 里不再出现已被删掉的旧路径；
3. `node_modules\dsh-edge-bridge` 仍是同一份代码（pnpm 会从 vendor 的 tgz 重新铺一遍）。

失败（离线 / registry 不通）：**先把 `package.json` 和 `pnpm-lock.yaml` 还原**，再按
第 1 步的手工方式重做，并明确告诉用户：「现在能跑，但下次 `pnpm install` 前要重装一次」。

走路线 A（`dsh plugin add`）的话这一步它已经做掉了，不用手工补。

## 第 3 步：自检（改完 `package.json` 约 10 秒后，或重启后立刻做）

按顺序调用，任何一步不符合就对照下面的表：

1. `edge_status`
   → 首行应是 `桥: http://127.0.0.1:17373  版本 0.2.1 …`，`扩展连接: 无`（还没拉起 Edge，正常）。
   → **版本比装的低**（出现 0.1.0 / 0.2.0）说明 DSH 加载的是旧副本，见失败对照表。
2. `edge_launch`，`url: https://example.com`
   → 应看到 `扩展已连上桥 ✔`。这一步会拉起一个**独立 profile** 的 Edge（不影响用户日常浏览器）。
3. `edge_snapshot`
   → 应能读到 example.com 的元素列表。
4. `edge_screenshot`（可选）
   → 能出图即完全正常。

想操作用户**日常那个** Edge 窗口：让用户在 `edge://extensions` 开启「开发人员模式」→
「加载解压缩的扩展」→ 选 `<PROFILE>\node_modules\dsh-edge-bridge\edge-extension`。
本包不做这件事，交给用户决定。

## 失败对照表

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 重启后 `edge_*` 工具根本不存在 | 插件没被加载：bundles 没加、或 JSON 带 BOM 读不到、或 `node_modules` 里没有该目录 | 逐项核对第 1 步；用备份还原后重做；`node -e "JSON.parse(require('fs').readFileSync('<PROFILE>/package.json','utf8'))"` 验证无 BOM |
| DSH 启动报 `duplicate loader entry id "dsh-edge-bridge"` | `cordis.patch.yml` 里多写了一份 insert | 删掉那一份（第 1 步 4 已说明不要写） |
| `edge_status` 报 `value is not lossless JSON` | DSH 加载的是 **0.1.x 旧副本**（`status()` 里 `lastError: undefined` 过不了无损 JSON 校验） | 装 0.2.0+，并按下面一行确认加载的确实是新副本 |
| `edge_status` 首行的版本比装的低，或行为与仓库对不上 | `node_modules\dsh-edge-bridge` 里是**旧副本**：换过 vendor 的 tgz 但没重装，或手工拷贝没覆盖干净 | 对比 `node_modules\dsh-edge-bridge\package.json` 的 `version` 与目标版本；不一致就重做第 1 步 3）+ 第 2.5 步；仍不一致再请用户重启 |
| `edge_launch` 报「扩展目录无效：(未提供)」 | 装的是 0.1.0 旧包（扩展没打进包） | 换 0.2.0+（当前 0.2.1） |
| 截图内容和当前页面不符（已点击/输入，图里是旧状态） | Edge 窗口被遮挡或最小化时，`captureVisibleTab` 只能拿最后一次合成的旧帧 | 用 `fullPage: true`（走 CDP 现取），或把窗口切到前台再截 |
| 扩展怎么都不连上，但端口没冲突 | 扩展只在 **17373–17380** 探测桥端口；把 `config.port` 改到范围外就永远连不上 | 端口改回该区间，或直接用默认 `edge_launch` |
| 跑过 `pnpm install` 后插件消失 / `--frozen-lockfile` 报错 | 没做第 2.5 步，lockfile 还指着已被删掉的旧路径 | 按第 2.5 步重做一次 install |
| `edge_tabs` 报「没有可用的 Edge 扩展连接」 | Edge 没开或扩展没启用 | 调 `edge_launch`；仍不行让用户检查 `edge://extensions` 里扩展是否「已启用」 |
| 扩展显示「已禁用」，或 `chrome-extension://` 打开报 `ERR_BLOCKED_BY_CLIENT` | Edge 155 上 CDP 装出来的扩展可能停在禁用态 | 让用户把「开发人员模式」关掉再打开；0.2.0 的 `edge_launch` 也会自动尝试恢复 |
| 端口 17373 被占用 | 端口冲突 | 扩展会自动在 17373–17380 探测；一般不用管 |

## 回滚

```powershell
$PROFILE2 = "C:\Users\你\.dsh\profiles\desktop"
Remove-Item "$PROFILE2\node_modules\dsh-edge-bridge" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$PROFILE2\vendor\dsh-edge-bridge-*.tgz" -Force -ErrorAction SilentlyContinue
# 从 package.json 的 dependencies 和 dsh.profile.bundles 里删掉 "dsh-edge-bridge"
# 再按第 2.5 步跑一次 pnpm install，让 lockfile 同步（否则以后 install 会报错）
```

删完 DSH 会在几秒内把插件卸掉（桥日志出现 `stopped`），不用重启；要重启也行。

## 不要做的事

- 不要把 `edge-extension/` 复制到包外再手工管理（包内那份才是权威，复制出去会漂移）。
- 不要为了「保险」升级 profile 里的其它插件。第 2.5 步的 `pnpm install` 只应让 lockfile
  认知新依赖；如果它开始改别的插件版本，停下来把 `pnpm-lock.yaml` 还原并问用户。
- 不要用 `robocopy` / `Copy-Item` 覆盖 `node_modules` 里的副本后跳过第 2.5 步——那份副本
  一旦和 vendor 的 tgz 不一致，下次 `pnpm install` 就会把它换掉，症状是「版本突然回去了」。
- 不要再把 `edge-extension/` 之外的东西塞进包（`files` 白名单在 `package.json` 里）。
- 不要替用户决定把扩展装进他日常的浏览器（涉及隐私预期），让用户自己选。
- 不要声称「已经能用了」——必须做完第 3 步自检再汇报。
