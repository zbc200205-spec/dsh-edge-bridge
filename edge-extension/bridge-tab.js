/** 常驻桥接页：页面级的桥连接 + 状态展示。 */

import { BridgeClient } from './lib/bridge.js'
import { handleCommand } from './lib/commands.js'
import { getSettings, httpBase } from './lib/settings.js'

const stateEl = document.getElementById('state')
const metaEl = document.getElementById('meta')
const logEl = document.getElementById('log')

function log(line) {
  const div = document.createElement('div')
  const ts = new Date().toLocaleTimeString()
  div.textContent = `[${ts}] ${line}`
  logEl.prepend(div)
  while (logEl.childElementCount > 200) logEl.lastElementChild.remove()
}

function renderState(state) {
  const map = {
    connected: ['已连接', 'ok'],
    connecting: ['连接中', 'wait'],
    reconnecting: ['重连中', 'wait'],
    offline: ['未连接（桥没启动？）', 'bad'],
    disconnected: ['断开', 'bad'],
    stopped: ['已停止', 'bad'],
    idle: ['空闲', 'wait'],
  }
  const [text, cls] = map[state.state] || [state.state, 'wait']
  stateEl.textContent = text
  stateEl.className = `pill ${cls}`
  metaEl.textContent = state.lastError ? state.lastError : state.connectedAt ? `已连接 ${Math.round((Date.now() - state.connectedAt) / 1000)}s` : ''
}

const client = new BridgeClient({
  mode: 'bridge-tab',
  onCommand: async (cmd, params) => {
    log(`← ${cmd} ${JSON.stringify(params).slice(0, 160)}`)
    const started = performance.now()
    const result = await handleCommand(cmd, params)
    log(`→ ${cmd} ok ${Math.round(performance.now() - started)}ms`)
    return result
  },
})

client.broadcastState = () => {
  renderState(client.snapshotState())
}

const originalLog = client.logger
client.logger = (...args) => {
  log(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
  originalLog(...args)
}

document.getElementById('reconnect').addEventListener('click', () => {
  client.stop()
  client.start()
})

document.getElementById('clear').addEventListener('click', () => {
  logEl.textContent = ''
})

getSettings().then((settings) => {
  log(`目标桥：${httpBase(settings)}`)
  client.start()
})

setInterval(() => renderState(client.snapshotState()), 1000)
renderState(client.snapshotState())
