/**
 * DSH Edge Bridge — MV3 service worker 入口。
 * 启动本地桥连接、保活闹钟、并把扩展端状态/设置暴露给 popup。
 */

import { ensureAlarm, ensureBridgeTab, getClient, reconnectRuntime, startRuntime } from './lib/runtime.js'
import { getSettings, setSettings } from './lib/settings.js'

ensureAlarm()
startRuntime()

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm()
  startRuntime()
})

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm()
  startRuntime()
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type
  if (type === 'dsh-edge-get-state') {
    const client = getClient()
    Promise.all([getSettings()]).then(([settings]) =>
      sendResponse({ ok: true, state: client.snapshotState(), settings, commands: undefined }),
    )
    return true
  }
  if (type === 'dsh-edge-reconnect') {
    reconnectRuntime()
      .then((state) => sendResponse({ ok: true, state }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }))
    return true
  }
  if (type === 'dsh-edge-save-settings') {
    setSettings(message.settings || {})
      .then(async (settings) => {
        await reconnectRuntime()
        sendResponse({ ok: true, settings })
      })
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }))
    return true
  }
  if (type === 'dsh-edge-open-bridge-tab') {
    ensureBridgeTab()
      .then((tab) => sendResponse({ ok: true, tabId: tab.id }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message) }))
    return true
  }
  return undefined
})
