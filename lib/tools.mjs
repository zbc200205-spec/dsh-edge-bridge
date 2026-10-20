/**
 * 暴露给 DSH 的 edge_* 工具定义。
 * 这里不使用 @deepseek-ai/dsh-tools 的 defineTool（插件零依赖），
 * 直接构造注册表接受的原始定义：name / description / parameters(原始 JSON Schema) /
 * output { schema, render } / execute(args, exec)。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launchEdgeWithExtension } from './edge-launcher.mjs'
import { defaultUserDataDir, findEdgePath, launchEdge } from './edge-launcher.mjs'

const S = (description, extra = {}) => ({ type: 'string', description, ...extra })
const N = (description) => ({ type: 'number', description })
const B = (description) => ({ type: 'boolean', description })

const OUT = { type: 'object', additionalProperties: true }

const TARGET_PROPS = {
  ref: S('元素编号，来自 edge_snapshot 输出里的 [n]（首选，最稳）'),
  selector: S('CSS 选择器（ref 失效时的备选）'),
  text: S('按可见文本/无障碍名称匹配元素（不知道选择器时用）'),
}

const TAB_PROP = N('目标标签页 id；省略则操作当前活动标签页')

function json(value) {
  return JSON.stringify(value, null, 2)
}

function fmtTab(tab) {
  if (!tab) return '(标签页已关闭)'
  return `#${tab.id} ${tab.active ? '[活动] ' : ''}${tab.title || '(无标题)'} — ${tab.url}`
}

function fmtElements(elements, max = 60) {
  if (!elements || !elements.length) return '(没有发现可交互元素)'
  const lines = []
  for (const el of elements.slice(0, max)) {
    const parts = [`[${el.ref}]`, el.role || el.tag]
    if (el.name) parts.push(JSON.stringify(el.name.length > 60 ? el.name.slice(0, 60) + '…' : el.name))
    if (el.type) parts.push(`type=${el.type}`)
    if (el.value !== undefined && el.value !== '') parts.push(`value=${JSON.stringify(String(el.value).slice(0, 40))}`)
    if (el.checked !== undefined) parts.push(`checked=${el.checked}`)
    if (el.placeholder) parts.push(`placeholder=${JSON.stringify(el.placeholder)}`)
    if (el.href) parts.push(`href=${el.href.slice(0, 80)}`)
    if (el.disabled) parts.push('disabled')
    if (!el.inViewport) parts.push('(不在视口)')
    parts.push(`@${Math.round(el.box.x)},${Math.round(el.box.y)} ${Math.round(el.box.w)}x${Math.round(el.box.h)}`)
    lines.push(parts.join(' '))
  }
  if (elements.length > max) lines.push(`…还有 ${elements.length - max} 个元素（可提高 maxElements 或先滚动）`)
  return lines.join('\n')
}

function fmtSnapshot(result) {
  const tab = result.tab || {}
  const head = [
    `标签页: ${fmtTab(tab)}`,
    `视口: ${result.viewport.width}x${result.viewport.height} scroll=(${result.viewport.scrollX},${result.viewport.scrollY}) dpr=${result.viewport.devicePixelRatio}`,
    `可交互元素: ${result.refCount}/${result.total}${result.truncated ? '（已截断）' : ''}`,
  ]
  const body = ['', '元素列表（用 ref 点击/输入）:', fmtElements(result.elements)]
  const text = result.text ? ['', '页面文本:', result.text] : []
  return [...head, ...body, ...text].join('\n')
}

function textResult(text) {
  return [{ type: 'text', text }]
}

function requireTarget(args) {
  if (args.ref == null && !args.selector && !args.text) {
    throw new Error('需要给出 ref / selector / text 之一来定位元素；先用 edge_snapshot 获取 ref')
  }
  const target = {}
  if (args.ref != null) target.ref = args.ref
  if (args.selector) target.selector = args.selector
  if (args.text) target.text = args.text
  return target
}

function targetArgs(args) {
  const target = {}
  if (args.ref != null) target.ref = args.ref
  if (args.selector) target.selector = args.selector
  if (args.text) target.text = args.text
  return target
}

/** 把截图 base64 落盘（并尽量挂成会话附件）。 */
async function persistScreenshot(ctx, exec, config, payload) {
  const mediaType = payload.format === 'jpeg' ? 'image/jpeg' : 'image/png'
  const data = Buffer.from(payload.base64 || '', 'base64')
  const cwd = exec.agent?.session.header.cwd || config.artifactDir || process.cwd()
  const dir = join(cwd, config.screenshotFolder || '.dsh-edge')
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const path = join(dir, `edge-shot-${stamp}-${Math.random().toString(36).slice(2, 6)}.${payload.format === 'jpeg' ? 'jpg' : 'png'}`)
  await writeFile(path, data)
  const out = { path, bytes: data.length, mediaType, mode: payload.mode, tab: payload.tab }
  const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
  if (attachments && typeof attachments.saveImage === 'function') {
    try {
      out.attachment = await attachments.saveImage({ data, mediaType, name: 'edge-screenshot' })
    } catch (err) {
      out.attachmentError = String(err && err.message)
    }
  }
  return out
}

function screenshotRender(_args, value) {
  const text =
    `已截图（${value.mode}，${Math.round(value.bytes / 1024)} KB）：${value.path}\n` +
    `${fmtTab(value.tab)}` +
    (value.attachment ? '\n截图已作为图片附件附在下面。' : '\n（本次未挂附件，可用 read_image 读取上面的路径）')
  if (value.attachment) return [{ type: 'text', text }, { type: 'image', attachment: value.attachment }]
  return textResult(text)
}

/**
 * 注册全部 edge_* 工具。
 * @param {any} ctx cordis context（需要 ctx.tools）
 * @param {import('./bridge.mjs').BridgeServer} bridge
 * @param {object} config 已解析的插件配置
 */
export function registerEdgeTools(ctx, bridge, config) {
  const names = []
  const register = (definition) => {
    names.push(definition.name)
    return ctx.tools.register(definition)
  }
  const launched = { info: null }

  const call = (cmd, params, options = {}) =>
    bridge.request(cmd, params, { timeoutMs: options.timeoutMs || config.timeoutMs || 30000, signal: options.signal })

  // ------------------------------------------------------------------ status
  register({
    name: 'edge_status',
    description:
      '查看 Edge 桥的当前状态：本地桥是否在跑、Edge 扩展是否已连上、有几个标签页、Edge 是否由本插件启动过。任何 edge_* 操作失败时先调用它排查。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUT, render: (_args, value) => textResult(value.text) },
    async execute() {
      const status = bridge.status()
      const lines = [
        `桥: ${status.url || '(未启动)'}  版本 ${status.version}  协议 ${status.protocol}  运行 ${Math.round(status.uptimeMs / 1000)}s`,
        `扩展连接: ${status.connections.length ? status.connections.map((c) => `${c.id}(${c.mode}, ${c.connected ? '在线' : '离线'}, 版本 ${c.extensionVersion || '?'}, 标签 ${c.label || '-'})`).join(', ') : '无'}`,
        `进行中的命令: ${status.pending}`,
      ]
      if (launched.info) lines.push(`Edge: pid=${launched.info.pid} profile=${launched.info.profile} userDataDir=${launched.info.userDataDir || '(用户默认)'}`)
      else lines.push('Edge: 尚未由本插件启动（可调用 edge_launch，或用户手动打开的 Edge 里装有本扩展）')
      if (status.connections.length) {
        try {
          const tabs = await call('tabs.list', {}, { timeoutMs: 8000 })
          lines.push(`标签页 ${tabs.tabs.length} 个，当前窗口活动页：${fmtTab(tabs.tabs.find((t) => t.active && t.focusedWindow) || tabs.tabs.find((t) => t.active))}`)
        } catch (err) {
          lines.push(`标签页读取失败: ${err.message}`)
        }
      } else {
        lines.push('提示: 若 Edge 没运行，调用 edge_launch 让插件拉起一个已加载扩展的 Edge。')
      }
      return { text: lines.join('\n'), status }
    },
  })

  // ------------------------------------------------------------------ launch
  register({
    name: 'edge_launch',
    description:
      '启动 Edge 以便后续 edge_* 操作。默认使用独立 profile（不影响用户日常浏览器）并通过命令行加载本扩展，等扩展连上桥后返回。也可以用 profile="default" 只开一个新窗口去操作用户自己的 Edge（前提是该 profile 里已手动加载过本扩展）。',
    parameters: {
      type: 'object',
      properties: {
        url: S('启动后打开的地址，默认 about:blank'),
        profile: S('"dedicated"（默认，独立 profile+自动加载扩展）或 "default"（用户现有 Edge）'),
        headless: B('是否无头启动（独立 profile 时可用；无头模式下扩展行为受限，建议保持 false）'),
        windowSize: S('窗口尺寸，例如 "1440,900"'),
        userDataDir: S('独立 profile 的数据目录（默认 $DSH_HOME/edge-profiles/dsh-edge）'),
        edgePath: S('msedge.exe 路径（默认自动探测）'),
        extensionDir: S('本扩展目录（默认插件包内的 edge-extension）'),
        waitMs: N('（已废弃，保留兼容）等待扩展连上桥的毫秒数'),
        argWaitMs: N('先用命令行 --load-extension 等待扩展连上的毫秒数，默认 12000'),
        extraArgs: { type: 'array', items: { type: 'string' }, description: '额外命令行参数' },
      },
      additionalProperties: false,
    },
    output: { schema: OUT, render: (_args, value) => textResult(value.text) },
    async execute(args) {
      const profile = args.profile === 'default' ? 'default' : 'dedicated'
      const extensionDir = args.extensionDir || config.extensionDir
      const waitForBridge = async (ms) => {
        try {
          await bridge.waitForConnection(ms)
          return true
        } catch {
          return false
        }
      }
      const info = await launchEdgeWithExtension({
        edgePath: args.edgePath || config.edgePath,
        extensionDir: profile === 'dedicated' ? extensionDir : null,
        userDataDir: args.userDataDir,
        profile,
        headless: args.headless === true,
        windowSize: args.windowSize,
        url: args.url,
        extraArgs: args.extraArgs,
        waitForBridge,
        argWaitMs: Number(args.argWaitMs) || 12000,
        cdpWaitMs: 20000,
      })
      launched.info = info
      bridge.edgeInfo = info
      const connected = info.connected === true || bridge.status().connections.length > 0
      const rec = info.recovery
      const recoveryLine = rec
        ? rec.connected
          ? `扩展禁用态已自动恢复（${rec.state || 'ENABLED'}）并连上桥`
          : `扩展恢复尝试未成功：${rec.reason || rec.state || '未知原因'}`
        : ''
      const lines = [
        `已启动 Edge: pid=${info.pid}`,
        `profile=${info.profile}  userDataDir=${info.userDataDir || '(用户默认)'}`,
        info.extensionDir ? `扩展目录=${info.extensionDir}` : '未通过命令行加载扩展（default profile 需已手动安装扩展）',
        info.debugPort ? `调试端口=${info.debugPort}` : '未开启调试端口',
        info.extension
          ? `扩展加载方式=${info.extension.strategy} 成功=${info.extension.loaded}${info.extension.error ? ` 错误=${info.extension.error}` : ''}`
          : '',
        recoveryLine,
        connected ? '扩展已连上桥 ✔' : '扩展尚未连上桥 ✘（可在 edge://extensions 手动“加载解压缩的扩展”，或稍后重试）',
      ].filter(Boolean)
      return { text: lines.join('\n'), launcher: info, connected }
    },
  })

  // -------------------------------------------------------------------- tabs
  register({
    name: 'edge_tabs',
    description: '标签页管理：list 列出所有标签页与窗口；open 新开标签页；activate 切换/聚焦标签页；close 关闭标签页。',
    parameters: {
      type: 'object',
      properties: {
        action: S('list | open | activate | close'),
        url: S('open 时的地址'),
        tabId: N('activate/close 的目标标签页 id'),
        active: B('open 时是否立即激活，默认 true'),
        windowId: N('限定窗口 / open 到指定窗口'),
        pinned: B('open 时是否固定标签页'),
        timeoutMs: N('open 等待加载的最长时间，默认 20000'),
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: OUT, render: (_args, value) => textResult(value.text) },
    async execute(args) {
      const action = String(args.action || '').toLowerCase()
      if (action === 'list') {
        const result = await call('tabs.list', { windowId: args.windowId })
        const lines = result.tabs.map(
          (t) => `#${t.id} w${t.windowId}${t.active ? ' [活动]' : ''}${t.pinned ? ' [固定]' : ''} ${t.status} ${t.title || '(无标题)'} — ${t.url}`,
        )
        return { text: lines.length ? lines.join('\n') : '(没有标签页)', tabs: result.tabs, windows: result.windows }
      }
      if (action === 'open') {
        const tab = await call('tabs.open', { url: args.url, active: args.active !== false, windowId: args.windowId, pinned: args.pinned === true, timeoutMs: args.timeoutMs }, { timeoutMs: (Number(args.timeoutMs) || 20000) + 8000 })
        return { text: `已打开 ${fmtTab(tab)}`, tab }
      }
      if (action === 'activate') {
        if (args.tabId == null) throw new Error('activate 需要 tabId')
        const tab = await call('tabs.activate', { tabId: args.tabId })
        return { text: `已切换到 ${fmtTab(tab)}`, tab }
      }
      if (action === 'close') {
        if (args.tabId == null) throw new Error('close 需要 tabId')
        const result = await call('tabs.close', { tabId: args.tabId })
        return { text: `已关闭标签页 #${result.closed}（${result.url}）`, result }
      }
      throw new Error(`未知 action: ${args.action}（可用 list/open/activate/close）`)
    },
  })

  // ---------------------------------------------------------------- navigate
  register({
    name: 'edge_navigate',
    description: '在指定（默认当前）标签页打开一个 http/https 地址并等待加载完成，返回最终 URL 与标题。',
    parameters: {
      type: 'object',
      properties: { url: S('要访问的完整地址'), tabId: TAB_PROP, timeoutMs: N('加载超时，默认 30000') },
      required: ['url'],
      additionalProperties: false,
    },
    output: { schema: OUT, render: (_args, value) => textResult(value.text) },
    async execute(args) {
      if (!args.url) throw new Error('缺少 url')
      const tab = await call('navigate', { url: args.url, tabId: args.tabId, timeoutMs: args.timeoutMs }, { timeoutMs: (Number(args.timeoutMs) || 30000) + 8000 })
      return { text: `已导航到 ${fmtTab(tab)}${tab.loadError ? `\n注意: ${tab.loadError}` : ''}`, tab }
    },
  })

  // ---------------------------------------------------------------- snapshot
  register({
    name: 'edge_snapshot',
    description:
      '读取当前页面的“可操作视图”：标题、URL、视口、可见文本，以及所有可交互元素的编号（ref）、角色、名称、位置。做点击/输入前先用它拿 ref。页面变化后 ref 会失效，需要重新 snapshot。',
    parameters: {
      type: 'object',
      properties: {
        tabId: TAB_PROP,
        maxElements: N('最多返回多少元素，默认 120，上限 400'),
        includeText: B('是否返回页面可见文本，默认 true'),
        maxText: N('文本上限字符数，默认 4000'),
      },
      additionalProperties: false,
    },
    output: { schema: OUT, render: (_args, value) => textResult(value.text) },
    async execute(args) {
      const result = await call('snapshot', { tabId: args.tabId, maxElements: args.maxElements, includeText: args.includeText, maxText: args.maxText }, { timeoutMs: 20000 })
      return { text: fmtSnapshot(result), snapshot: result }
    },
  })

  // ------------------------------------------------------------------- click
  register({
    name: 'edge_click',
    description:
      '点击页面元素。用 ref（edge_snapshot 得到）最稳，其次 selector，最后 text。默认用 DOM 合成点击；trusted=true 会通过调试器发送真实鼠标事件（isTrusted=true，适合严格要求真实事件的站点，但会给标签页挂上调试器）。',
    parameters: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        tabId: TAB_PROP,
        trusted: B('是否使用真实(CDP)鼠标事件，默认 false'),
        clickCount: N('点击次数（2=双击），默认 1'),
        waitAfterMs: N('点击后额外等待毫秒数，默认 700'),
      },
      additionalProperties: false,
    },
    output: { schema: OUT, render: (_args, value) => textResult(value.text) },
    async execute(args) {
      const target = requireTarget(args)
      const result = await call('click', { tabId: args.tabId, target, trusted: args.trusted === true, clickCount: args.clickCount, waitAfterMs: args.waitAfterMs })
      const clicked = result.clicked || {}
      const targetInfo = clicked.target || {}
      const lines = [
        `已点击 ${targetInfo.tag || ''} ${targetInfo.name ? JSON.stringify(targetInfo.name) : ''} ${targetInfo.ref != null ? `[${targetInfo.ref}]` : ''}${clicked.trusted ? ' (trusted/CDP)' : ''}`,
        `之后: ${fmtTab(result.after)}`,
      ]
      if (result.before && result.after && result.before.url !== result.after.url) lines.splice(1, 0, `URL 变化: ${result.before.url} → ${result.after.url}`)
      return { text: lines.join('\n'), ...result }
    },
  })

  // -------------------------------------------------------------------- type
  register({
    name: 'edge_type',
    description:
      '向输入框/文本域/contenteditable 输入文本。用 ref/selector/text 定位，value 是要输入的内容。默认逐字符输入并触发 input/change 事件；trusted=true 用调试器走真实输入（isTrusted）。submit=true 表示输入后按回车提交。',
    parameters: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        tabId: TAB_PROP,
        value: S('要输入的文本'),
        clear: B('是否先清空原内容，默认 true'),
        submit: B('输入后按回车，默认 false'),
        trusted: B('是否用真实(CDP)输入，默认 false'),
        delayMs: N('每个字符之间的延迟（毫秒），默认 0'),
      },
      required: ['value'],
      additionalProperties: false,
    },
    output: { schema: OUT, render: (_args, value) => textResult(value.text) },
    async execute(args) {
      const target = requireTarget(args)
      if (args.value === undefined) throw new Error('缺少 value（要输入的文本）')
      const result = await call('type', {
        tabId: args.tabId,
        target,
        text: args.value,
        clear: args.clear !== false,
        submit: args.submit === true,
        trusted: args.trusted === true,
        delayMs: args.delayMs,
      }, { timeoutMs: Math.max(30000, (String(args.value).length * (Number(args.delayMs) || 0)) + 20000) })
      const lines = [
        `已输入 ${String(args.value).length} 个字符${result.typed && result.typed.trusted ? ' (trusted/CDP)' : ''}${args.submit ? '，并回车提交' : ''}`,
        `输入框现值: ${result.value ? JSON.stringify(String(result.value.value).slice(0, 120)) : '(读回失败)'}`,
        `之后: ${fmtTab(result.after)}`,
      ]
      return { text: lines.join('\n'), ...result }
    },
  })

  // --------------------------------------------------------------------- key
  register({
    name: 'edge_key',
    description: '发送键盘按键：Enter、Tab、Escape、Backspace、ArrowDown 等，或配合 ctrlKey/metaKey 发送快捷键。默认走真实(CDP)按键。',
    parameters: {
      type: 'object',
      properties: {
        key: S('按键名，如 Enter / Tab / Escape / ArrowDown / a'),
        tabId: TAB_PROP,
        ...TARGET_PROPS,
        ctrlKey: B('按住 Ctrl'),
        metaKey: B('按住 Meta/Win'),
        altKey: B('按住 Alt'),
        shiftKey: B('按住 Shift'),
        trusted: B('是否走真实按键，默认 true'),
        waitAfterMs: N('之后等待毫秒数，默认 500'),
      },
      required: ['key'],
      additionalProperties: false,
    },
    output: { schema: OUT, render: (_args, value) => textResult(value.text) },
    async execute(args) {
      if (!args.key) throw new Error('缺少 key')
      const result = await call('key', {
        tabId: args.tabId,
        key: args.key,
        ...targetArgs(args),
        ctrlKey: args.ctrlKey === true,
        metaKey: args.metaKey === true,
        altKey: args.altKey === true,
        shiftKey: args.shiftKey === true,
        trusted: args.trusted !== false,
        waitAfterMs: args.waitAfterMs,
      })
      return { text: `已发送按键 ${args.key}${result.trusted ? ' (trusted/CDP)' : ''}\n之后: ${fmtTab(result.after)}`, ...result }
    },
  })

  // ------------------------------------------------------------------ scroll
  register({
    name: 'edge_scroll',
    description: '滚动页面或某个可滚动元素。to="bottom"/"top" 直接到顶/底，否则用 dy（正数向下）。',
    parameters: {
      type: 'object',
      properties: {
        ...TARGET_PROPS,
        tabId: TAB_PROP,
        dy: N('纵向滚动像素，正数向下'),
        dx: N('横向滚动像素'),
        to: S('"top" 或 "bottom"'),
        trusted: B('是否用真实滚轮事件，默认 false'),
      },
      additionalProperties: false,
    },
    output: { schema: OUT, render: (_args, value) => textResult(value.text) },
    async execute(args) {
      const result = await call('scroll', {
        tabId: args.tabId,
        ...targetArgs(args),
        dy: args.dy,
        dx: args.dx,
        to: args.to,
        trusted: args.trusted === true,
      })
      return { text: `已滚动: ${json(result.scroll)}`, ...result }
    },
  })

  // -------------------------------------------------------------------- wait
  register({
    name: 'edge_wait',
    description: '等待页面条件成立：出现 selector、出现某段文本、URL 包含某段字符串，或 fn 表达式为真。用于等加载/等异步渲染完成。',
    parameters: {
      type: 'object',
      properties: {
        selector: S('等待该 CSS 选择器出现且可见'),
        text: S('等待该文本出现在可交互元素上'),
        urlContains: S('等待 URL 包含该字符串'),
        fn: S('等待该表达式为真（走 CDP 在页面主世界求值，例如 document.readyState==="complete"）'),
        timeoutMs: N('超时毫秒，默认 8000'),
        pollMs: N('轮询间隔毫秒，默认 200'),
        tabId: TAB_PROP,
      },
      additionalProperties: false,
    },
    output: { schema: OUT, render: (_args, value) => textResult(value.text) },
    async execute(args) {
      const timeoutMs = Number(args.timeoutMs) || 8000
      const result = await call('wait', { tabId: args.tabId, selector: args.selector, text: args.text, urlContains: args.urlContains, fn: args.fn, timeoutMs, pollMs: args.pollMs }, { timeoutMs: timeoutMs + 8000 })
      return {
        text: result.matched
          ? `条件已满足（${result.elapsedMs}ms，${result.detail && result.detail.reason}）\n当前: ${fmtTab(result.tab)}`
          : `等待超时（${result.elapsedMs}ms）：${json(result.detail)}\n当前: ${fmtTab(result.tab)}`,
        ...result,
      }
    },
  })

  // -------------------------------------------------------------- screenshot
  register({
    name: 'edge_screenshot',
    description: '截图当前标签页并保存到工作区（同时尽量作为图片附件返回，便于直接查看页面）。fullPage=true 截整页（走调试器）。',
    parameters: {
      type: 'object',
      properties: {
        tabId: TAB_PROP,
        fullPage: B('是否整页截图，默认 false（只截视口）'),
        format: S('png（默认）或 jpeg'),
        quality: N('jpeg 质量 10-100'),
      },
      additionalProperties: false,
    },
    output: { schema: OUT, render: screenshotRender },
    async execute(args, exec) {
      const payload = await call('screenshot', { tabId: args.tabId, fullPage: args.fullPage === true, format: args.format, quality: args.quality }, { timeoutMs: 60000, signal: exec?.signal })
      return await persistScreenshot(ctx, exec || {}, config, payload)
    },
  })

  // -------------------------------------------------------------------- eval
  register({
    name: 'edge_eval',
    description:
      '在页面主世界执行 JavaScript 并返回结果（走 CDP Runtime.evaluate：能绕过页面的 CSP 与隔离世界的 eval 限制，代价是该标签页会被挂上调试器）。支持两种写法：纯表达式（如 document.title）或带 return 的语句体（如 return document.title）。返回值必须可 JSON 化。',
    parameters: {
      type: 'object',
      properties: {
        code: S('要执行的 JS：表达式或带 return 的语句体'),
        tabId: TAB_PROP,
        timeoutMs: N('求值超时毫秒，默认 30000'),
        world: S('（已废弃，保留兼容）CDP 求值总在页面主世界执行'),
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: { schema: OUT, render: (_args, value) => textResult(value.text) },
    async execute(args) {
      if (!args.code) throw new Error('缺少 code')
      const result = await call('eval', { code: args.code, world: args.world, tabId: args.tabId, timeoutMs: args.timeoutMs }, { timeoutMs: (Number(args.timeoutMs) || 30000) + 8000 })
      let value
      try {
        value = JSON.parse(JSON.stringify(result.value))
      } catch {
        value = String(result.value)
      }
      return { text: `eval 结果（${result.via || 'cdp'}/${result.type || typeof value}）:\n${json(value)}`, value, tab: result.tab }
    },
  })

  // ------------------------------------------------------------- highlight
  register({
    name: 'edge_highlight',
    description: '在页面上把某个 ref 元素高亮一下（约 1.2 秒），用于人工核对 agent 正在操作哪个元素。',
    parameters: {
      type: 'object',
      properties: { ref: S('edge_snapshot 得到的元素编号'), tabId: TAB_PROP },
      required: ['ref'],
      additionalProperties: false,
    },
    output: { schema: OUT, render: (_args, value) => textResult(value.text) },
    async execute(args) {
      const result = await call('highlight', { ref: args.ref, tabId: args.tabId })
      return { text: `已高亮 [${args.ref}] ${json(result.highlight)}`, ...result }
    },
  })

  // ---------------------------------------------------------- bridge tab tool
  register({
    name: 'edge_open_bridge_tab',
    description:
      '在 Edge 里打开扩展自带的“常驻桥接页”。service worker 空闲后可能被浏览器回收（重连会有几秒延迟），固定一个桥接页可以保证桥始终在线。多浏览器/多 profile 时也便于确认连接的是哪一个。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: OUT, render: (_args, value) => textResult(value.text) },
    async execute() {
      await bridge.waitForConnection(config.waitForConnectionMs || 10000)
      const result = await call('bridge.tab', {}, { timeoutMs: 10000 })
      return {
        text: `${result.reused ? '已聚焦' : '已打开'}常驻桥接页：${fmtTab(result.tab)}\n它自己维持一条到桥的 WebSocket，浏览器回收 service worker 也不会掉线。`,
        ...result,
      }
    },
  })

  return { tools: names }
}

export { findEdgePath, defaultUserDataDir, launchEdge }
