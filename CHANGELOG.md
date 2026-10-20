# 更新记录

## 0.2.0

**布局变更（重要）**：`edge-extension/` 从「插件包的兄弟目录」挪进插件包内部，仓库根 = 插件包根。
这样从 GitHub 源装、从 npm 装、从 tgz 装拿到的是同一份东西，
`dsh plugin add github:<owner>/dsh-edge-bridge` 也能直接用到包内扩展。

分享前修掉的两个问题（都会让「别人装上却用不了」）：

- **扩展没打进包**：仓库里 `edge-extension/` 与 `dsh-plugin-edge-bridge/` 是兄弟目录，
  直接 `npm pack` 出来的 tgz 里没有扩展，装到别人机器上 `edge_launch` 会报
  「扩展目录无效：(未提供)」。现在用 `scripts/pack.mjs` 打包，扩展会被复制进包内并做解包自检；
  `resolveExtensionDir` 也新增了「插件包同级目录」的候选，开发态直接 `file:` 指源码目录同样能用。
- **`edge_status` 一调就报错**：返回值里 `lastError: undefined` 过不了 DSH 的 lossless-JSON 校验，
  工具直接失败（`value is not lossless JSON`）。改为空字符串，并给 `extensionVersion` 兜底。

新增：

- `edge_launch` 在扩展装上了但仍处于「已禁用」时（Edge 155 + CDP 安装会遇到，症状是
  `chrome-extension://` 打开报 `ERR_BLOCKED_BY_CLIENT`、service worker 不启动），
  会自动打开 `chrome://extensions` 重新下发一次开发人员模式并重试连接。
- `HANDOVER.md`：给「拿到压缩包的人」的交接说明（怎么交给自己的 agent、agent 会改什么、安全须知、卸载）。
- `AGENT-INSTALL.md`：给**对方的 agent** 照做的安装任务书（目标、两条安装路径、自检、失败对照表、回滚、禁止事项）。
- `scripts/pack.mjs`：一键打出可分享的 tgz（含解包自检）。
- `scripts/pack-zip.mjs`：一键打出交给别人 agent 安装的 zip（源码 + tgz + 两份文档，不含任何安装脚本）。
- `tests/verify-dist.mjs`、`tests/verify-zip.mjs`、`tests/recover-extension.mjs`：分发包验收、zip 按 agent 手册安装的回放、扩展恢复自检。

## 0.1.0

首个版本：本机 WebSocket 桥 + MV3 扩展，14 个 `edge_*` 工具。
