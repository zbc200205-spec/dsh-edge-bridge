/** 扩展端运行时：建立并维持到 DSH 桥的连接。service worker 与桥接标签页共用。 */

import { BridgeClient } from './bridge.js'
import { handleCommand } from './commands.js'
import { getSettings } from './settings.js'

const KEEPALIVE_ALARM = 'dsh-edge-keepalive'
const BRIDGE_TAB_URL = 'bridge-tab.html'

let client = null
let listenersInstalled = false

export function getClient(mode) {
  if (!client) client = new BridgeClient({ onCommand: handleCommand, mode: mode || 'service-worker' })
  return client
}

/** 打开/复用常驻桥接标签页（页面级别的 WebSocket 不会被 SW 回收影响）。 */
export async function ensureBridgeTab() {
  const url = chrome.runtime.getURL(BRIDGE_TAB_URL)
  const existing = await chrome.tabs.query({ url })
  if (existing.length) {
    try {
      await chrome.tabs.reload(existing[0].id)
    } catch {
      /* ignore */
    }
    return existing[0]
  }
  return await chrome.tabs.create({ url, active: false, pinned: true })
}

export function installListeners() {
  if (listenersInstalled) return
  listenersInstalled = true
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name !== KEEPALIVE_ALARM) return
    const c = getClient()
    if (c.state !== 'connected' && !c.running) await c.start()
    else if (c.state === 'connected') c.send({ type: 'ping', t: Date.now() })
    const settings = await getSettings()
    if (settings.persistentTab) {
      const tabs = await chrome.tabs.query({ url: chrome.runtime.getURL(BRIDGE_TAB_URL) })
      if (!tabs.length) await ensureBridgeTab()
    }
  })
}

export function ensureAlarm() {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 })
}

/** 启动运行时（幂等）。 */
export async function startRuntime(options = {}) {
  installListeners()
  const settings = await getSettings()
  const c = getClient(options.mode)
  if (settings.autoConnect !== false) {
    if (!c.running) await c.start()
  }
  if (settings.persistentTab || options.persistentTab) await ensureBridgeTab()
  return c
}

export async function reconnectRuntime() {
  const c = getClient()
  c.stop()
  await c.start()
  return c.snapshotState()
}
