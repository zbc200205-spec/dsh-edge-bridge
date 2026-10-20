/** 扩展设置：桥地址、端口、令牌、自动重连等。 */

const STORAGE_KEY = 'dshEdgeSettings'

export const DEFAULT_SETTINGS = {
  /** 桥监听端口（DSH 插件默认 17373）。 */
  bridgePort: 17373,
  /** 完整 HTTP 基址，留空则用 http://127.0.0.1:<bridgePort>。 */
  bridgeUrl: '',
  /** 由 /hello 获取的会话令牌；手工填写可覆盖。 */
  token: '',
  /** 是否在 service worker 启动时自动连接。 */
  autoConnect: true,
  /** 是否额外打开一个常驻桥接标签页（更稳，但会多一个标签）。 */
  persistentTab: false,
  /** 自定义显示名，便于多浏览器区分。 */
  label: '',
}

export async function getSettings() {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY)
    return { ...DEFAULT_SETTINGS, ...(stored && stored[STORAGE_KEY] ? stored[STORAGE_KEY] : {}) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function setSettings(patch) {
  const current = await getSettings()
  const next = { ...current, ...patch }
  await chrome.storage.local.set({ [STORAGE_KEY]: next })
  return next
}

/** HTTP 基址（用于 /hello、/health）。 */
export function httpBase(settings) {
  if (settings.bridgeUrl) return settings.bridgeUrl.replace(/\/+$/, '')
  return `http://127.0.0.1:${settings.bridgePort}`
}

/** WebSocket 地址。 */
export function wsUrl(settings, token) {
  const base = httpBase(settings).replace(/^http/, 'ws')
  const query = token ? `?token=${encodeURIComponent(token)}` : ''
  return `${base}/edge${query}`
}
