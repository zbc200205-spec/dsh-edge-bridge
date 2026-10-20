/** 标签页解析、列表、开关、导航与等待。 */

import { assertScriptable, callAgent } from './page.js'

export async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId)
  } catch {
    throw new Error(`标签页 ${tabId} 不存在或已关闭`)
  }
}

/** 解析目标标签页：显式 tabId > 当前窗口活动页 > 最近聚焦窗口活动页。 */
export async function resolveTab(tabId) {
  if (tabId != null) return assertScriptable(await getTab(Number(tabId)))
  let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (!tabs.length) tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tabs.length) tabs = await chrome.tabs.query({ active: true })
  const tab = tabs.find((t) => t.id != null)
  if (!tab) throw new Error('没有找到活动标签页')
  return assertScriptable(tab)
}

function brief(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active,
    pinned: tab.pinned,
    status: tab.status,
    title: tab.title || '',
    url: tab.url || tab.pendingUrl || '',
  }
}

export async function listTabs(options = {}) {
  const query = {}
  if (options.windowId != null) query.windowId = Number(options.windowId)
  if (options.currentWindow) query.currentWindow = true
  const tabs = await chrome.tabs.query(query)
  const windows = await chrome.windows.getAll({ populate: false })
  const focused = windows.filter((w) => w.focused).map((w) => w.id)
  return {
    tabs: tabs.map((t) => Object.assign(brief(t), { focusedWindow: focused.includes(t.windowId) })),
    windows: windows.map((w) => ({ id: w.id, focused: w.focused, state: w.state, type: w.type })),
  }
}

export async function openTab(options = {}) {
  const url = options.url || 'about:blank'
  const create = { url, active: options.active !== false }
  if (options.windowId != null) create.windowId = Number(options.windowId)
  if (options.index != null) create.index = Number(options.index)
  if (options.pinned === true) create.pinned = true
  const tab = await chrome.tabs.create(create)
  if (options.waitMs !== 0 && /^https?:/i.test(url)) {
    try {
      await waitForLoad(tab.id, options.timeoutMs || 20000)
    } catch {
      /* 打开慢不阻塞返回 */
    }
  }
  return brief(await getTab(tab.id))
}

export async function activateTab(tabId) {
  const tab = await getTab(tabId)
  await chrome.tabs.update(tab.id, { active: true })
  if (tab.windowId != null) {
    try {
      await chrome.windows.update(tab.windowId, { focused: true })
    } catch {
      /* 某些平台不允许聚焦，忽略 */
    }
  }
  return brief(await getTab(tab.id))
}

export async function closeTab(tabId) {
  const tab = await getTab(tabId)
  await chrome.tabs.remove(tab.id)
  return { closed: tab.id, url: tab.url }
}

export async function waitForLoad(tabId, timeoutMs = 20000) {
  const tab = await getTab(tabId)
  if (tab.status === 'complete') return brief(tab)
  return await new Promise((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      chrome.tabs.onUpdated.removeListener(listener)
      reject(new Error(`等待页面加载超时（${timeoutMs}ms）`))
    }, timeoutMs)
    const listener = (id, changeInfo, updated) => {
      if (id !== tabId) return
      if (changeInfo.status !== 'complete') return
      done = true
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve(brief(updated))
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
}

export async function navigate(tabId, url, options = {}) {
  const tab = await resolveTab(tabId)
  const targetUrl = String(url)
  if (!/^[a-z]+:/i.test(targetUrl)) {
    throw new Error(`URL 必须以协议开头（http:// https:// file:// 等）：${targetUrl}`)
  }
  await chrome.tabs.update(tab.id, { url: targetUrl })
  let loaded = null
  let loadError = ''
  try {
    loaded = await waitForLoad(tab.id, options.timeoutMs || 30000)
  } catch (err) {
    loadError = err && err.message ? err.message : String(err)
  }
  const finalTab = await getTab(tab.id)
  let title = finalTab.title || ''
  if (!title && /^https?:/i.test(finalTab.url || '')) {
    try {
      const info = await callAgent(tab.id, 'pageInfo', [])
      title = info && info.title ? info.title : ''
    } catch {
      /* ignore */
    }
  }
  return Object.assign(brief(finalTab), { title, loadError: loadError || undefined })
}
