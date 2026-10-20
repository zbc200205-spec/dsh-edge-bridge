/** 通过 chrome.debugger(CDP) 发送“真实（isTrusted）”输入事件与整页截图。 */

const PROTOCOL = '1.3'
const attached = new Set()

try {
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId != null) attached.delete(source.tabId)
  })
} catch {
  /* 某些环境（如非扩展页面测试）没有该 API */
}

export function isAttached(tabId) {
  return attached.has(Number(tabId))
}

export async function attach(tabId) {
  const id = Number(tabId)
  if (attached.has(id)) return { tabId: id, reused: true }
  try {
    await chrome.debugger.attach({ tabId: id }, PROTOCOL)
    attached.add(id)
    return { tabId: id, reused: false }
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    if (/already attached/i.test(message)) {
      // 可能是 DevTools 或另一个扩展占用；仍然尝试直接发命令
      attached.add(id)
      return { tabId: id, reused: true, warning: message }
    }
    const error = new Error(`无法附加调试器（trusted 模式需要它）：${message}`)
    error.code = 'DEBUGGER_ATTACH_FAILED'
    throw error
  }
}

export async function detach(tabId) {
  const id = Number(tabId)
  if (!attached.has(id)) return { detached: false }
  try {
    await chrome.debugger.detach({ tabId: id })
  } catch {
    /* ignore */
  }
  attached.delete(id)
  return { detached: true }
}

export async function send(tabId, method, params) {
  const id = Number(tabId)
  await attach(id)
  try {
    return await chrome.debugger.sendCommand({ tabId: id }, method, params || {})
  } catch (err) {
    const message = err && err.message ? err.message : String(err)
    const error = new Error(`CDP ${method} 失败：${message}`)
    error.code = 'CDP_FAILED'
    throw error
  }
}

const VK = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  ' ': { code: 'Space', keyCode: 32, text: ' ' },
}

const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }

function modifierMask(options = {}) {
  let mask = 0
  if (options.altKey) mask |= MODIFIERS.alt
  if (options.ctrlKey) mask |= MODIFIERS.ctrl
  if (options.metaKey) mask |= MODIFIERS.meta
  if (options.shiftKey) mask |= MODIFIERS.shift
  return mask
}

/** 真实鼠标点击（isTrusted=true），坐标为相对视口左上角的 CSS 像素。 */
export async function trustedClick(tabId, point, options = {}) {
  const x = Math.round(point.x)
  const y = Math.round(point.y)
  const button = options.button || 'left'
  const clickCount = Number(options.clickCount) || 1
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons: button === 'left' ? 1 : 2, clickCount })
  await new Promise((r) => setTimeout(r, Number(options.holdMs) || 20))
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount })
  return { x, y, button, clickCount }
}

/** 真实输入文本（走 IME 插入路径，页面收到 isTrusted 的 input 事件）。 */
export async function trustedInsertText(tabId, text) {
  await send(tabId, 'Input.insertText', { text: String(text) })
  return { inserted: String(text).length }
}

/** 真实按键。key 使用 KeyboardEvent.key 名称，例如 'Enter'、'a'、'ArrowDown'。 */
export async function trustedKey(tabId, key, options = {}) {
  const modifiers = modifierMask(options)
  const single = key.length === 1
  const info = VK[key] || (single ? { code: /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : 'Unidentified', keyCode: key.toUpperCase().charCodeAt(0), text: key } : null)
  const base = {
    modifiers,
    key,
    code: (info && info.code) || key,
    windowsVirtualKeyCode: (info && info.keyCode) || 0,
    nativeVirtualKeyCode: (info && info.keyCode) || 0,
  }
  const text = options.ctrlKey || options.metaKey ? undefined : info && info.text
  await send(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'rawKeyDown' }, base, text ? {} : {}))
  if (text) await send(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'char', text }, base))
  await send(tabId, 'Input.dispatchKeyEvent', Object.assign({ type: 'keyUp' }, base))
  return { key, modifiers }
}

/** 全页截图（不受窗口是否聚焦影响）。 */
export async function fullPageScreenshot(tabId, options = {}) {
  const format = options.format === 'jpeg' ? 'jpeg' : 'png'
  const params = { format, captureBeyondViewport: options.fullPage !== false }
  if (format === 'jpeg') params.quality = Math.min(Math.max(Number(options.quality) || 80, 10), 100)
  if (options.clip) params.clip = options.clip
  const result = await send(tabId, 'Page.captureScreenshot', params)
  return { data: result.data, format }
}

/** 视口截图（CDP 路径）。 */
export async function viewportScreenshot(tabId, options = {}) {
  return fullPageScreenshot(tabId, Object.assign({}, options, { fullPage: false }))
}

/** 滚轮滚动（真实事件）。 */
export async function trustedWheel(tabId, point, deltaY, deltaX = 0) {
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(point.x),
    y: Math.round(point.y),
    deltaX,
    deltaY,
  })
  return { deltaX, deltaY }
}

function exceptionText(result) {
  const details = result && result.exceptionDetails
  if (!details) return null
  const desc = details.exception && (details.exception.description || details.exception.value)
  return String(desc || details.text || 'CDP 求值异常')
}

/** 单次 Runtime.evaluate（returnByValue）。 */
async function evaluateOnce(tabId, expression, options) {
  const result = await send(tabId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: options.awaitPromise !== false,
    userGesture: options.userGesture !== false,
    allowUnsafeEvalBlockedByCSP: true,
    timeout: Number(options.timeoutMs) || undefined,
  })
  const error = exceptionText(result)
  if (error) {
    const err = new Error(error)
    err.code = 'EVAL_EXCEPTION'
    throw err
  }
  return result.result || {}
}

/**
 * 在页面主世界求值（绕过页面 CSP / 隔离世界的 unsafe-eval 限制）。
 * 先按表达式求值；如果写的是 `return x` 这类语句，会自动包成 async 函数体重试。
 */
export async function evaluate(tabId, code, options = {}) {
  const source = String(code == null ? '' : code)
  const trimmed = source.trim()
  if (!trimmed) throw new Error('eval 代码为空')
  const attempts = []
  if (!/^\s*(return|await|const|let|var|if|for|while|switch|throw|try|function|class)\b/.test(trimmed)) {
    attempts.push(`(${source})`)
  }
  attempts.push(`(async () => { ${source} })()`)
  let lastError = null
  for (const expression of attempts) {
    try {
      const value = await evaluateOnce(tabId, expression, options)
      return {
        value: value.value === undefined ? null : value.value,
        type: value.type || typeof value.value,
        description: value.description,
        expression,
        viaCdp: true,
      }
    } catch (err) {
      lastError = err
      if (err.code !== 'EVAL_EXCEPTION' || !/SyntaxError|Unexpected token|Invalid or unexpected/.test(err.message)) throw err
    }
  }
  throw lastError || new Error('eval 失败')
}

