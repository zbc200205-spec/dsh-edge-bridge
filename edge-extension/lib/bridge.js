/**
 * 桥客户端：负责与 DSH 插件的本地 WebSocket 服务保持连接、收命令、回结果。
 * service worker 与桥接标签页共用一个实例逻辑。
 */

import { getSettings, setSettings, wsUrl } from './settings.js'

const PING_INTERVAL_MS = 15000
const HELLO_TIMEOUT_MS = 4000

export class BridgeClient {
  constructor({ onCommand, logger, mode } = {}) {
    this.onCommand = onCommand
    this.mode = mode || 'service-worker'
    this.logger = logger || ((...args) => console.log('[dsh-edge]', ...args))
    this.ws = null
    this.running = false
    this.state = 'idle'
    this.lastError = ''
    this.connectedAt = 0
    this.attempt = 0
    this.pingTimer = null
    this.reconnectTimer = null
    this.info = {}
  }

  snapshotState() {
    return {
      state: this.state,
      lastError: this.lastError,
      connectedAt: this.connectedAt,
      attempts: this.attempt,
      info: this.info,
    }
  }

  setState(state, error) {
    this.state = state
    if (error !== undefined) this.lastError = error ? String(error) : ''
    this.broadcastState()
  }

  broadcastState() {
    try {
      chrome.runtime.sendMessage({ type: 'dsh-edge-state', state: this.snapshotState() }).catch(() => {})
    } catch {
      /* popup 未打开时忽略 */
    }
  }

  async start() {
    if (this.running) return
    this.running = true
    await this.connectLoop()
  }

  stop() {
    this.running = false
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.pingTimer = null
    this.reconnectTimer = null
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* ignore */
      }
    }
    this.ws = null
    this.setState('stopped')
  }

  async connectLoop() {
    while (this.running) {
      try {
        await this.connectOnce()
        // connectOnce 返回意味着连接已断开或失败
      } catch (err) {
        this.logger('connect failed:', err && err.message)
      }
      if (!this.running) return
      this.attempt += 1
      const delay = Math.min(500 * Math.pow(1.6, Math.min(this.attempt, 8)), 15000)
      this.setState('reconnecting', this.lastError)
      await new Promise((resolve) => {
        this.reconnectTimer = setTimeout(resolve, delay)
      })
    }
  }

  /** 候选桥地址：配置优先，其次一串默认端口，便于桥换端口后仍能自动找到。 */
  async candidateBases() {
    const settings = await getSettings()
    const bases = []
    if (settings.bridgeUrl) bases.push(settings.bridgeUrl.replace(/\/+$/, ''))
    const ports = [settings.bridgePort, 17373, 17374, 17375, 17376, 17377, 17378, 17379, 17380]
    for (const port of ports) {
      const value = Number(port)
      if (Number.isFinite(value) && value > 0) bases.push(`http://127.0.0.1:${value}`)
    }
    return [...new Set(bases)]
  }

  /** 依次尝试候选地址的 /hello，返回命中的基址与握手信息。 */
  async discoverBridge() {
    const bases = await this.candidateBases()
    let lastError = null
    for (const base of bases) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), HELLO_TIMEOUT_MS)
      try {
        const res = await fetch(`${base}/hello`, { signal: controller.signal, cache: 'no-store' })
        if (!res.ok) throw new Error(`hello HTTP ${res.status}`)
        const hello = await res.json()
        return { base, hello }
      } catch (err) {
        lastError = err
      } finally {
        clearTimeout(timer)
      }
    }
    throw lastError || new Error('没有任何候选桥地址可用')
  }

  async connectOnce() {
    let settings = await getSettings()
    this.setState('connecting')
    let discovered
    try {
      discovered = await this.discoverBridge()
    } catch (err) {
      this.setState('offline', `找不到桥（已尝试 127.0.0.1 的多个端口）：${err && err.message}`)
      return
    }
    const { base, hello } = discovered
    const token = settings.token || hello.token || ''
    const patch = {}
    if (hello.token && hello.token !== settings.token) patch.token = hello.token
    if (hello.port && hello.port !== settings.bridgePort) patch.bridgePort = hello.port
    if (Object.keys(patch).length) settings = await setSettings(patch)
    const url = wsUrl(Object.assign({}, settings, { bridgeUrl: settings.bridgeUrl || base }), token)
    await new Promise((resolve) => {
      let settled = false
      let ws
      try {
        ws = new WebSocket(url)
      } catch (err) {
        this.setState('offline', String(err && err.message))
        resolve()
        return
      }
      this.ws = ws
      const finish = () => {
        if (settled) return
        settled = true
        resolve()
      }
      ws.addEventListener('open', () => {
        this.attempt = 0
        this.connectedAt = Date.now()
        this.info = {
          extensionVersion: chrome.runtime.getManifest().version,
          label: settings.label || '',
          userAgent: navigator.userAgent,
          mode: this.mode,
        }
        this.setState('connected')
        this.send({ type: 'hello', ext: this.info })
        if (this.pingTimer) clearInterval(this.pingTimer)
        this.pingTimer = setInterval(() => this.send({ type: 'ping', t: Date.now() }), PING_INTERVAL_MS)
        this.logger('connected to', url)
      })
      ws.addEventListener('message', (event) => {
        this.handleMessage(event.data)
      })
      ws.addEventListener('close', () => {
        if (this.pingTimer) clearInterval(this.pingTimer)
        this.pingTimer = null
        this.ws = null
        this.setState('disconnected')
        finish()
      })
      ws.addEventListener('error', () => {
        this.setState('offline', 'WebSocket 错误（桥未启动或端口被占用）')
      })
    })
  }

  send(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false
    try {
      this.ws.send(JSON.stringify(payload))
      return true
    } catch (err) {
      this.logger('send failed', err && err.message)
      return false
    }
  }

  async handleMessage(raw) {
    let msg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : '')
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'ping') {
      this.send({ type: 'pong', t: msg.t })
      return
    }
    if (msg.type === 'pong') return
    if (msg.type === 'welcome') {
      this.info = { ...this.info, bridge: msg.bridge, protocol: msg.protocol }
      this.broadcastState()
      return
    }
    if (msg.type === 'cmd') {
      const startedAt = Date.now()
      try {
        if (typeof this.onCommand !== 'function') throw new Error('扩展未就绪：onCommand 缺失')
        const result = await this.onCommand(msg.cmd, msg.params || {})
        this.send({ type: 'result', id: msg.id, ok: true, result, elapsedMs: Date.now() - startedAt })
      } catch (err) {
        this.send({
          type: 'result',
          id: msg.id,
          ok: false,
          error: { message: err && err.message ? err.message : String(err), code: err && err.code ? err.code : 'EXTENSION_ERROR' },
          elapsedMs: Date.now() - startedAt,
        })
      }
    }
  }
}
