/**
 * 极简 CDP 客户端（零依赖，使用 Node 内置 WebSocket）。
 * 只用于启动期：探测调试端口、用 Extensions.loadUnpacked 加载未打包扩展。
 */
const DEFAULT_TIMEOUT = 10000

export async function fetchVersion(port, timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal, cache: 'no-store' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** 轮询等待调试端口就绪。 */
export async function waitForDebugPort(port, timeoutMs = 30000, intervalMs = 300) {
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < timeoutMs) {
    try {
      return await fetchVersion(port)
    } catch (err) {
      lastError = err
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }
  const error = new Error(`等待 Edge 调试端口 ${port} 超时：${lastError && lastError.message}`)
  error.code = 'CDP_PORT_TIMEOUT'
  throw error
}

export class CdpConnection {
  constructor(ws) {
    this.ws = ws
    this.seq = 0
    this.waiters = new Map()
    ws.addEventListener('message', (event) => {
      let msg
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
      } catch {
        return
      }
      const waiter = msg.id ? this.waiters.get(msg.id) : null
      if (waiter) {
        this.waiters.delete(msg.id)
        clearTimeout(waiter.timer)
        if (msg.error) {
          const error = new Error(`${waiter.method} 失败: ${msg.error.message}`)
          error.cdpError = msg.error
          waiter.reject(error)
        } else {
          waiter.resolve(msg.result)
        }
      }
    })
    ws.addEventListener('close', () => {
      for (const [, waiter] of this.waiters) {
        clearTimeout(waiter.timer)
        waiter.reject(new Error('CDP 连接已关闭'))
      }
      this.waiters.clear()
    })
  }

  static async connect(url, timeoutMs = DEFAULT_TIMEOUT) {
    const ws = new WebSocket(url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error('CDP WebSocket 连接失败'))
      }, { once: true })
    })
    return new CdpConnection(ws)
  }

  send(method, params = {}, timeoutMs = DEFAULT_TIMEOUT) {
    const id = ++this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error(`CDP ${method} 超时`))
      }, timeoutMs)
      this.waiters.set(id, { resolve, reject, timer, method })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (err) {
        clearTimeout(timer)
        this.waiters.delete(id)
        reject(err)
      }
    })
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * 用 CDP 的 Extensions.loadUnpacked 加载未打包扩展。
 * 需要浏览器带 --enable-unsafe-extension-debugging 启动。
 */
export async function loadUnpackedExtension(port, extensionPath, options = {}) {
  const version = options.version || (await waitForDebugPort(port, options.timeoutMs || 30000))
  const url = version.webSocketDebuggerUrl
  if (!url) throw new Error('调试端口没有返回 webSocketDebuggerUrl')
  const cdp = await CdpConnection.connect(url, options.timeoutMs || 10000)
  try {
    const result = await cdp.send('Extensions.loadUnpacked', { path: extensionPath }, options.loadTimeoutMs || 20000)
    return { ok: true, id: result && result.id, raw: result }
  } catch (err) {
    return { ok: false, error: String(err && err.message), cdpError: err && err.cdpError }
  } finally {
    cdp.close()
  }
}

/** 列出 target，用于判断扩展是否真的加载了。 */
export async function listTargets(port, options = {}) {
  const version = await waitForDebugPort(port, options.timeoutMs || 15000)
  const cdp = await CdpConnection.connect(version.webSocketDebuggerUrl)
  try {
    const result = await cdp.send('Target.getTargets')
    return result.targetInfos || []
  } finally {
    cdp.close()
  }
}

const EXTENSIONS_URL = 'chrome://extensions'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Windows 路径比较用：大小写、斜杠、末尾分隔符都不敏感。 */
const normalizePath = (value) => String(value || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()

/**
 * 打开一个 chrome://extensions 页并连到它的页面 session。
 * WebUI 页可以直接用 /devtools/page/<id> 连接，不需要 flatten session。
 */
async function openExtensionsPage(port) {
  const version = await waitForDebugPort(port, 15000)
  const browser = await CdpConnection.connect(version.webSocketDebuggerUrl)
  let targetId = null
  let page = null
  try {
    const created = await browser.send('Target.createTarget', { url: EXTENSIONS_URL })
    targetId = created && created.targetId
    if (!targetId) throw new Error('chrome://extensions 没有返回 targetId')
    const started = Date.now()
    let target = null
    while (Date.now() - started < 8000) {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      target = list.find((t) => t.id === targetId)
      if (target && target.webSocketDebuggerUrl) break
      await sleep(150)
    }
    if (!target || !target.webSocketDebuggerUrl) throw new Error('拿不到 chrome://extensions 的调试地址')
    page = await CdpConnection.connect(target.webSocketDebuggerUrl)
    try {
      await page.send('Runtime.enable', {})
    } catch {
      /* 部分版本不需要显式 enable */
    }
    // 等 WebUI 的 developerPrivate 接口可用
    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      try {
        const ready = await page.send(
          'Runtime.evaluate',
          { expression: 'typeof chrome !== "undefined" && !!chrome.developerPrivate', returnByValue: true },
          3000,
        )
        if (ready && ready.result && ready.result.value === true) return { browser, page, targetId }
      } catch {
        /* 页面还在加载 */
      }
      await sleep(150)
    }
    throw new Error('chrome://extensions 页没有暴露 developerPrivate')
  } catch (err) {
    if (page) page.close()
    try {
      if (targetId) await browser.send('Target.closeTarget', { targetId })
    } catch {
      /* ignore */
    }
    browser.close()
    throw err
  }
}

async function evaluateOn(page, expression, timeoutMs = 8000) {
  const res = await page.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs)
  if (res && res.exceptionDetails) {
    const detail = res.exceptionDetails.exception && (res.exceptionDetails.exception.description || res.exceptionDetails.exception.value)
    throw new Error(String(detail || res.exceptionDetails.text || 'evaluate 失败'))
  }
  return res && res.result ? res.result.value : undefined
}

const readExtensions = (page) =>
  evaluateOn(
    page,
    `chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true})
       .then((list) => list.map((x) => ({ id: x.id, name: x.name, state: x.state, path: x.path || '' })))`,
  )

/** 打开 chrome://extensions，跑完 fn 后关掉这个页。 */
async function withExtensionsPage(port, fn) {
  let handle = null
  try {
    handle = await openExtensionsPage(port)
    return await fn(handle)
  } finally {
    if (handle) {
      try {
        if (handle.targetId) await handle.browser.send('Target.closeTarget', { targetId: handle.targetId })
      } catch {
        /* ignore */
      }
      handle.page.close()
      handle.browser.close()
    }
  }
}

/**
 * 开关「开发人员模式」。关掉会连同禁用所有未打包扩展，主要用于排查/测试；
 * 也可当作把扩展从禁用态救回来的手段（见 ensureExtensionEnabled）。
 */
export async function setDeveloperMode(port, inDeveloperMode) {
  try {
    return await withExtensionsPage(port, async ({ page }) => {
      await evaluateOn(page, `chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:${inDeveloperMode ? 'true' : 'false'}})`)
      await sleep(600)
      const list = (await readExtensions(page)) || []
      return { ok: true, extensions: list.map((x) => ({ name: x.name, state: x.state })) }
    })
  } catch (err) {
    return { ok: false, reason: String(err && err.message) }
  }
}

/**
 * 兜底：扩展已经装进浏览器但仍处于「已禁用」时把它救回来。
 *
 * 触发场景（实测于 Edge 155）：命令行的 --load-extension 被忽略后，用 CDP 的
 * Extensions.loadUnpacked 装上的扩展会停在 DISABLED，禁用原因是
 * unsupportedDeveloperExtension —— 此时 chrome-extension:// 页直接
 * ERR_BLOCKED_BY_CLIENT，service worker 起不来，桥自然一直等不到连接。
 * 打开 chrome://extensions 重新下发一次「开发人员模式」即可恢复。
 *
 * @returns {Promise<{ok:boolean, state?:string, changed?:boolean, id?:string, reason?:string}>}
 */
export async function ensureExtensionEnabled(port, extensionPath, options = {}) {
  const wanted = normalizePath(extensionPath)
  try {
    return await withExtensionsPage(port, async ({ page }) => {
      const list = (await readExtensions(page)) || []
      const target = list.find((x) => x.path && normalizePath(x.path) === wanted)
      if (!target) {
        return { ok: false, reason: 'not-installed', known: list.map((x) => ({ name: x.name, state: x.state, path: x.path })) }
      }
      if (target.state === 'ENABLED') return { ok: true, state: target.state, changed: false, id: target.id }

      // 先按「重新下发开发人员模式」处理；不行再补一次扩展重载。
      if (options.toggleDevMode !== false) {
        await evaluateOn(page, 'chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode:true})')
        await sleep(600)
        const after = ((await readExtensions(page)) || []).find((x) => x.id === target.id)
        if (after && after.state === 'ENABLED') return { ok: true, state: after.state, changed: true, id: target.id }
      }
      try {
        await evaluateOn(page, `chrome.developerPrivate.reload(${JSON.stringify(target.id)}, {failQuietly:true})`)
        await sleep(800)
      } catch {
        /* reload 对禁用中的扩展可能直接失败，交给下面的复查 */
      }
      const final = ((await readExtensions(page)) || []).find((x) => x.id === target.id)
      return final && final.state === 'ENABLED'
        ? { ok: true, state: final.state, changed: true, id: target.id }
        : { ok: false, state: final ? final.state : 'missing', reason: 'still-disabled', id: target.id }
    })
  } catch (err) {
    return { ok: false, reason: String(err && err.message) }
  }
}

