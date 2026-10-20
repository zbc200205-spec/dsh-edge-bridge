/** 命令实现：桥发来的每条命令在这里落到 chrome.* / 页面注入 API 上。 */

import { callAgent, evalInPage } from './page.js'
import { activateTab, closeTab, getTab, listTabs, navigate, openTab, resolveTab, waitForLoad } from './tabs.js'
import { fullPageScreenshot, trustedClick, trustedInsertText, trustedKey, trustedWheel, viewportScreenshot } from './cdp.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)))

/** 目标描述：既支持 {target:{...}}，也支持平铺的 ref/selector/text。 */
function targetOf(params = {}) {
  if (params.target && typeof params.target === 'object') return params.target
  const target = {}
  if (params.ref != null) target.ref = params.ref
  if (params.selector) target.selector = params.selector
  if (params.text) target.text = params.text
  if (params.exact != null) target.exact = params.exact
  if (params.role) target.role = params.role
  return target
}

function requireTarget(params) {
  const target = targetOf(params)
  if (!target.ref && !target.selector && !target.text) {
    throw new Error('需要指定目标：ref（来自 snapshot 的编号）、selector（CSS）或 text（可见文本）三者之一')
  }
  return target
}

function briefTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    title: tab.title || '',
    url: tab.url || '',
    status: tab.status,
  }
}

/** 动作之后等页面稳定：URL 变了就等加载完成，否则短暂静默等待。 */
async function settle(tabId, prevUrl, waitMs = 800) {
  const timeout = Math.max(0, Number(waitMs) || 0)
  try {
    const current = await getTab(tabId)
    if (current.status === 'loading' || (prevUrl && current.url && current.url !== prevUrl)) {
      try {
        await waitForLoad(tabId, Math.max(5000, timeout))
      } catch {
        /* 超时不致命 */
      }
    } else if (timeout) {
      await sleep(timeout)
    }
  } catch {
    /* tab 可能已关闭 */
  }
  try {
    const tab = await getTab(tabId)
    return briefTab(tab)
  } catch {
    return null
  }
}

async function cmdStatus() {
  const manifest = chrome.runtime.getManifest()
  const all = await chrome.tabs.query({})
  let active = null
  try {
    active = briefTab(await resolveTab())
  } catch {
    active = null
  }
  return {
    extensionVersion: manifest.version,
    extensionId: chrome.runtime.id,
    mode: 'service-worker',
    userAgent: navigator.userAgent,
    tabCount: all.length,
    activeTab: active,
    settings: await chrome.storage.local.get('dshEdgeSettings').then((s) => s && s.dshEdgeSettings),
  }
}

async function cmdSnapshot(params) {
  const tab = await resolveTab(params.tabId)
  const snapshot = await callAgent(tab.id, 'snapshot', [
    { maxElements: params.maxElements, includeText: params.includeText, maxText: params.maxText },
  ])
  return Object.assign({ tab: briefTab(tab) }, snapshot)
}

async function cmdClick(params) {
  const tab = await resolveTab(params.tabId)
  const target = requireTarget(params)
  const trusted = params.trusted === true
  const before = briefTab(tab)
  let clicked
  if (trusted) {
    const info = await callAgent(tab.id, 'boxOfTarget', [target])
    const at = await trustedClick(
      tab.id,
      { x: info.box.cx, y: info.box.cy },
      { button: params.button || 'left', clickCount: params.clickCount || 1 },
    )
    clicked = { at, target: info, trusted: true }
  } else {
    const result = await callAgent(tab.id, 'click', [target, { button: params.button || 'left' }])
    clicked = Object.assign({ trusted: false }, result)
  }
  const after = await settle(tab.id, before.url, params.waitAfterMs != null ? params.waitAfterMs : 700)
  return { clicked, before, after }
}

async function cmdType(params) {
  const tab = await resolveTab(params.tabId)
  const target = requireTarget(params)
  const text = String(params.text == null ? '' : params.text)
  const trusted = params.trusted === true
  const clear = params.clear !== false
  const before = briefTab(tab)
  let typed
  if (trusted) {
    await callAgent(tab.id, 'focusTarget', [target])
    if (clear) await callAgent(tab.id, 'type', [target, '', { clear: true, delayMs: 0 }])
    await trustedInsertText(tab.id, text)
    typed = { trusted: true, inserted: text.length }
  } else {
    const result = await callAgent(tab.id, 'type', [target, text, { clear, delayMs: params.delayMs || 0 }])
    typed = Object.assign({ trusted: false }, result)
  }
  let submitted = false
  if (params.submit === true) {
    if (trusted) await trustedKey(tab.id, 'Enter', {})
    else await callAgent(tab.id, 'key', [null, 'Enter', { submit: true }])
    submitted = true
  }
  const readBack = await callAgent(tab.id, 'readTarget', [target]).catch(() => null)
  const after = await settle(tab.id, before.url, params.waitAfterMs != null ? params.waitAfterMs : (submitted ? 1200 : 250))
  return { typed, submitted, value: readBack, before, after }
}

async function cmdKey(params) {
  const tab = await resolveTab(params.tabId)
  const key = String(params.key || '')
  if (!key) throw new Error('缺少 key，例如 Enter / Tab / Escape / ArrowDown / a')
  const trusted = params.trusted !== false // 按键默认走真实事件，因为 React 等框架常用
  const before = briefTab(tab)
  let result
  if (trusted) {
    const target = targetOf(params)
    if (target.ref || target.selector || target.text) await callAgent(tab.id, 'focusTarget', [target])
    result = await trustedKey(tab.id, key, {
      ctrlKey: params.ctrlKey,
      metaKey: params.metaKey,
      altKey: params.altKey,
      shiftKey: params.shiftKey,
    })
  } else {
    result = await callAgent(tab.id, 'key', [targetOf(params), key, params])
  }
  const after = await settle(tab.id, before.url, params.waitAfterMs != null ? params.waitAfterMs : 500)
  return { key, trusted, result, before, after }
}

async function cmdScroll(params) {
  const tab = await resolveTab(params.tabId)
  const trusted = params.trusted === true
  let result
  if (trusted) {
    const point = params.ref != null || params.selector || params.text
      ? (await callAgent(tab.id, 'boxOfTarget', [targetOf(params)])).box
      : { cx: 200, cy: 200 }
    result = await trustedWheel(tab.id, { x: point.cx, y: point.cy }, Number(params.dy) || 600, Number(params.dx) || 0)
  } else {
    result = await callAgent(tab.id, 'scroll', [Object.assign({}, targetOf(params), { dx: params.dx, dy: params.dy, to: params.to })])
  }
  return { scroll: result }
}

async function cmdWait(params) {
  const tab = await resolveTab(params.tabId)
  const timeoutMs = Math.min(Math.max(Number(params.timeoutMs) || 8000, 100), 120000)
  const pollMs = Math.min(Math.max(Number(params.pollMs) || 200, 50), 2000)
  const started = Date.now()
  const condition = {
    selector: params.selector,
    text: params.text,
    exact: params.exact,
    urlContains: params.urlContains,
    fn: params.fn,
    visible: params.visible,
  }
  if (!condition.selector && !condition.text && !condition.urlContains && !condition.fn) {
    throw new Error('wait 需要 selector / text / urlContains / fn 之一作为条件')
  }
  let last = null
  while (Date.now() - started < timeoutMs) {
    if (condition.fn) {
      // fn 条件只能走 CDP（隔离世界不允许 eval）
      try {
        const evaluated = await evalInPage(tab.id, condition.fn, {})
        last = { matched: !!evaluated.value, reason: 'fn', value: evaluated.value, via: evaluated.via }
      } catch (err) {
        last = { matched: false, reason: 'fn-error', error: err.message }
      }
    } else {
      last = await callAgent(tab.id, 'probe', [condition]).catch((err) => ({ matched: false, reason: 'probe-error', error: err.message }))
    }
    if (last && last.matched) {
      return { matched: true, elapsedMs: Date.now() - started, detail: last, tab: briefTab(await getTab(tab.id)) }
    }
    await sleep(pollMs)
  }
  const current = await getTab(tab.id).catch(() => null)
  return { matched: false, elapsedMs: Date.now() - started, detail: last, tab: current ? briefTab(current) : null }
}

async function cmdScreenshot(params) {
  const tab = await resolveTab(params.tabId)
  const format = params.format === 'jpeg' ? 'jpeg' : 'png'
  const fullPage = params.fullPage === true
  let data = null
  let mode = ''
  if (fullPage) {
    const shot = await fullPageScreenshot(tab.id, { format, quality: params.quality })
    data = shot.data
    mode = 'cdp-fullpage'
  } else {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format })
      data = dataUrl.replace(/^data:image\/\w+;base64,/, '')
      mode = 'captureVisibleTab'
    } catch (err) {
      const shot = await viewportScreenshot(tab.id, { format, quality: params.quality })
      data = shot.data
      mode = 'cdp-viewport'
    }
  }
  return {
    mode,
    format,
    base64: data,
    bytes: data ? Math.floor((data.length * 3) / 4) : 0,
    tab: briefTab(await getTab(tab.id)),
  }
}

async function cmdEval(params) {
  const tab = await resolveTab(params.tabId)
  const result = await evalInPage(tab.id, params.code, { world: params.world, timeoutMs: params.timeoutMs })
  return Object.assign({ tab: briefTab(tab) }, result)
}

async function cmdHighlight(params) {
  const tab = await resolveTab(params.tabId)
  const result = await callAgent(tab.id, 'highlight', [String(params.ref)])
  return { highlight: result, tab: briefTab(tab) }
}

async function cmdInfo(params) {
  const tab = await resolveTab(params.tabId)
  const info = await callAgent(tab.id, 'pageInfo', [])
  return Object.assign({ tab: briefTab(tab) }, info)
}

async function cmdFocus(params) {
  const tab = await resolveTab(params.tabId)
  const activated = await activateTab(tab.id)
  return { tab: activated }
}

/** 打开/复用扩展自带的常驻桥接页。 */
async function cmdBridgeTab() {
  const url = chrome.runtime.getURL('bridge-tab.html')
  const existing = await chrome.tabs.query({ url })
  if (existing.length) {
    if (!existing[0].active) await chrome.tabs.update(existing[0].id, { active: true })
    return { reused: true, tab: briefTab(existing[0]) }
  }
  const tab = await chrome.tabs.create({ url, active: true, pinned: true })
  return { reused: false, tab: briefTab(tab) }
}

/** 诊断：直接看 chrome.scripting.executeScript 返回的原始 frame 结构。 */
async function cmdDebugScripting(params) {
  const tab = await resolveTab(params.tabId)
  const frames = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => ({
      ok: true,
      value: 42,
      title: document.title,
      counter: document.getElementById('click-count') ? document.getElementById('click-count').textContent : 'MISSING',
      url: location.href,
    }),
  })
  return {
    tab: briefTab(tab),
    frames: frames.map((frame) => ({
      frameId: frame.frameId,
      documentId: frame.documentId,
      result: frame.result === undefined ? null : frame.result,
      resultType: typeof frame.result,
      error: frame.error ? String(frame.error) : null,
      keys: Object.keys(frame),
    })),
  }
}

const COMMANDS = {
  status: cmdStatus,
  'tabs.list': (params) => listTabs(params),
  'tabs.open': (params) => openTab(params),
  'tabs.activate': (params) => activateTab(Number(params.tabId)),
  'tabs.close': (params) => closeTab(Number(params.tabId)),
  navigate: (params) => navigate(params.tabId, params.url, { timeoutMs: params.timeoutMs }),
  snapshot: cmdSnapshot,
  click: cmdClick,
  type: cmdType,
  key: cmdKey,
  scroll: cmdScroll,
  wait: cmdWait,
  screenshot: cmdScreenshot,
  eval: cmdEval,
  highlight: cmdHighlight,
  info: cmdInfo,
  focus: cmdFocus,
  'bridge.tab': cmdBridgeTab,
  'debug.scripting': cmdDebugScripting,
}

export async function handleCommand(cmd, params = {}) {
  const handler = COMMANDS[cmd]
  if (!handler) {
    const error = new Error(`扩展不支持命令 "${cmd}"。可用：${Object.keys(COMMANDS).sort().join(', ')}`)
    error.code = 'UNKNOWN_COMMAND'
    throw error
  }
  return await handler(params || {})
}

export function commandNames() {
  return Object.keys(COMMANDS).sort()
}
