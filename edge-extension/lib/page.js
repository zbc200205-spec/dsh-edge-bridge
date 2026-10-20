/** 页面脚本注入与调用（isolated world），以及主世界的 CDP 求值。 */

import { evaluate } from './cdp.js'

const RESTRICTED_URL = /^(chrome|edge|about|devtools|view-source|chrome-extension|edge-extension|data|blob):/i

export function assertScriptable(tab) {
  const url = (tab && tab.url) || ''
  if (!url) throw new Error('目标标签页没有可访问的 URL（可能是受保护页面）')
  if (RESTRICTED_URL.test(url) && !/^https?:/i.test(url)) {
    throw new Error(`无法在受保护页面执行脚本：${url}（请先导航到 http/https 页面）`)
  }
  return tab
}

function normalizeError(err) {
  const raw = err && err.message ? err.message : String(err)
  const cleaned = raw.replace(/^Error:\s*/, '')
  const error = new Error(cleaned)
  error.code = 'PAGE_ERROR'
  return error
}

/** 确保页面里已有注入的 agent（幂等）。 */
export async function ensureAgent(tabId, frameIds) {
  const target = { tabId }
  if (Array.isArray(frameIds) && frameIds.length) target.frameIds = frameIds
  try {
    await chrome.scripting.executeScript({ target, files: ['inject/agent.js'] })
  } catch (err) {
    throw normalizeError(err)
  }
}

/** 调用页面侧 __DSH_EDGE__ 的方法。 */
export async function callAgent(tabId, method, args = [], options = {}) {
  const target = { tabId }
  if (options.frameId != null) target.frameIds = [options.frameId]
  await ensureAgent(tabId, target.frameIds)
  let results
  try {
    results = await chrome.scripting.executeScript({
      target,
      func: (m, a) => {
        const api = globalThis.__DSH_EDGE__
        if (!api) throw new Error('agent 未注入（页面可能在执行前重新加载，请重试）')
        const fn = api[m]
        if (typeof fn !== 'function') throw new Error(`agent 不支持方法 ${m}`)
        return fn.apply(api, a)
      },
      args: [method, args],
    })
  } catch (err) {
    throw normalizeError(err)
  }
  const frame = results && results[0]
  if (!frame) throw new Error(`页面无返回（frame 不存在？method=${method}）`)
  return frame.result
}

/** 在页面里执行一段 JS 并返回结果。
 *
 *  走 CDP 的 Runtime.evaluate（主世界）：这样既能绕开页面的 CSP，也能绕开 MV3
 *  隔离世界禁止 eval/new Function 的限制；`return x` 与纯表达式两种写法都支持。
 *  world 参数仅为兼容而保留：CDP 求值总在页面主世界执行。 */
export async function evalInPage(tabId, code, options = {}) {
  const result = await evaluate(tabId, code, { timeoutMs: options.timeoutMs })
  return { value: result.value, type: result.type, world: 'MAIN', via: 'cdp' }
}
