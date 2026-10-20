/** 扩展弹窗：设置桥地址并查看连接状态。 */

const els = {
  state: document.getElementById('state'),
  port: document.getElementById('port'),
  url: document.getElementById('url'),
  label: document.getElementById('label'),
  persistent: document.getElementById('persistent'),
  save: document.getElementById('save'),
  reconnect: document.getElementById('reconnect'),
  tab: document.getElementById('tab'),
  hint: document.getElementById('hint'),
}

function pill(text, cls) {
  els.state.textContent = text
  els.state.className = `pill ${cls}`
}

async function loadSettings() {
  const { dshEdgeSettings } = await chrome.storage.local.get('dshEdgeSettings')
  const settings = Object.assign({ bridgePort: 17373, bridgeUrl: '', label: '', persistentTab: false }, dshEdgeSettings || {})
  els.port.value = settings.bridgePort
  els.url.value = settings.bridgeUrl || ''
  els.label.value = settings.label || ''
  els.persistent.checked = !!settings.persistentTab
  return settings
}

async function refreshState() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'dsh-edge-get-state' })
    if (response && response.ok) {
      const s = response.state
      const map = { connected: ['已连接', 'ok'], connecting: ['连接中', 'wait'], reconnecting: ['重连中', 'wait'], offline: ['未连接', 'bad'], disconnected: ['断开', 'bad'], stopped: ['已停止', 'bad'], idle: ['空闲', 'wait'] }
      const [text, cls] = map[s.state] || [s.state, 'wait']
      pill(text, cls)
      els.hint.textContent = s.lastError || (s.connectedAt ? `已连接 ${Math.round((Date.now() - s.connectedAt) / 1000)} 秒` : '')
      return
    }
  } catch (err) {
    /* service worker 可能正在休眠 */
  }
  try {
    const settings = await loadSettings()
    const base = settings.bridgeUrl || `http://127.0.0.1:${settings.bridgePort}`
    const res = await fetch(`${base}/health`, { cache: 'no-store' })
    const health = await res.json()
    pill(health.extension && health.extension.connected ? '已连接' : '桥在，扩展未连', health.extension && health.extension.connected ? 'ok' : 'wait')
    els.hint.textContent = JSON.stringify(health.extension || {})
  } catch (err) {
    pill('未连接', 'bad')
    els.hint.textContent = `连不上桥：${err && err.message}`
  }
}

els.save.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'dsh-edge-save-settings',
    settings: {
      bridgePort: Number(els.port.value) || 17373,
      bridgeUrl: els.url.value.trim(),
      label: els.label.value.trim(),
      persistentTab: els.persistent.checked,
      autoConnect: true,
      token: '',
    },
  })
  els.hint.textContent = '已保存，正在重连…'
  setTimeout(refreshState, 600)
})

els.reconnect.addEventListener('click', async () => {
  els.hint.textContent = '正在重连…'
  await chrome.runtime.sendMessage({ type: 'dsh-edge-reconnect' })
  setTimeout(refreshState, 600)
})

els.tab.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'dsh-edge-open-bridge-tab' })
  window.close()
})

loadSettings().then(refreshState)
setInterval(refreshState, 1500)
