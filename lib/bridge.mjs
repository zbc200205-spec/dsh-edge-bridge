/**
 * DSH Edge Bridge 服务端：本机 HTTP + WebSocket 桥。
 * - 扩展连上来：ws://127.0.0.1:<port>/edge?token=...
 * - 其它本地程序也可以用 HTTP 调：POST /command {cmd, params}
 */
import { EventEmitter } from 'node:events'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'
import { attachWebSocketServer } from './ws.mjs'

export const PROTOCOL = 'dsh-edge/1'
export const VERSION = '0.2.1'
export const DEFAULT_PORT = 17373

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

const isLoopback = (address) => {
  if (!address) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export class BridgeServer extends EventEmitter {
  constructor(options = {}) {
    super()
    this.host = options.host || '127.0.0.1'
    this.port = options.port === 0 ? 0 : Number(options.port) || DEFAULT_PORT
    this.token = options.token || randomUUID().replace(/-/g, '')
    this.logger = options.logger || (() => {})
    this.staticDir = options.staticDir ? resolve(options.staticDir) : null
    this.allowNoToken = options.allowNoToken === true
    this.requestTimeoutMs = Number(options.requestTimeoutMs) || 30000
    this.waitForConnectionMs = Number(options.waitForConnectionMs) || 30000

    this.server = null
    this.address = null
    this.startedAt = 0
    this.connections = new Map() // id -> record
    this.pending = new Map() // id -> record
    this.seq = 0
    this.lastError = ''
    this.timers = new Set()
    this.launcher = options.launcher || null
    this.edgeInfo = null
  }

  log(...args) {
    this.logger('[dsh-edge-bridge]', ...args)
  }

  async start() {
    if (this.server) return this.address
    this.server = http.createServer((req, res) => {
      this.handleHttp(req, res).catch((err) => {
        this.log('http error', err && err.message)
        sendJson(res, 500, { ok: false, error: String(err && err.message) })
      })
    })
    this.server.on('clientError', (err, socket) => {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    })
    attachWebSocketServer(this.server, {
      path: '/edge',
      verify: (req, url) => {
        const remote = req.socket && req.socket.remoteAddress
        if (!isLoopback(remote)) return { ok: false, reason: 'non-loopback' }
        if (this.allowNoToken) return { ok: true, meta: { remote } }
        const token = url.searchParams.get('token') || req.headers['x-dsh-token']
        if (!token || token !== this.token) return { ok: false, reason: 'bad token' }
        return { ok: true, meta: { remote } }
      },
      onConnection: (conn) => this.registerConnection(conn),
    })
    await new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server.removeListener('listening', onListening)
        reject(err)
      }
      const onListening = () => {
        this.server.removeListener('error', onError)
        resolve()
      }
      this.server.once('error', onError)
      this.server.once('listening', onListening)
      this.server.listen(this.port, this.host)
    })
    const addr = this.server.address()
    this.address = { host: this.host, port: addr.port, url: `http://${this.host}:${addr.port}` }
    this.port = addr.port
    this.startedAt = Date.now()
    this.keepalive = setInterval(() => this.tick(), 20000)
    this.keepalive.unref?.()
    this.log(`listening on ${this.address.url} (token ${this.token.slice(0, 6)}…)`)
    return this.address
  }

  async stop() {
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = null
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    for (const [id, record] of this.pending) {
      clearTimeout(record.timer)
      record.reject(new Error('桥已关闭，命令被取消'))
      this.pending.delete(id)
    }
    for (const [id, record] of this.connections) {
      try {
        record.conn.close(1001, 'bridge shutting down')
      } catch {
        /* ignore */
      }
      this.connections.delete(id)
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()))
      this.server = null
    }
    this.address = null
    this.log('stopped')
  }

  // ------------------------------------------------------------- connections
  registerConnection(conn) {
    const id = `ext-${++this.seq}`
    const record = {
      id,
      conn,
      mode: 'unknown',
      info: {},
      connectedAt: Date.now(),
      lastSeen: Date.now(),
      pending: 0,
    }
    this.connections.set(id, record)
    this.log(`extension connected (${id} from ${conn.meta.remote})`)
    conn.send(JSON.stringify({ type: 'welcome', protocol: PROTOCOL, bridge: VERSION }))
    conn.on('message', (raw) => this.onMessage(record, raw))
    conn.on('close', (reason) => {
      this.connections.delete(id)
      this.log(`extension disconnected (${id}: ${reason})`)
      for (const [reqId, pending] of this.pending) {
        if (pending.connectionId === id) {
          clearTimeout(pending.timer)
          this.pending.delete(reqId)
          pending.reject(new Error(`扩展连接断开（${reason}），命令 ${pending.cmd} 未完成；请确认 Edge 与扩展仍在运行`))
        }
      }
      this.emit('connection-closed', id)
    })
    this.emit('connection', record)
  }

  onMessage(record, raw) {
    record.lastSeen = Date.now()
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return
    switch (msg.type) {
      case 'hello':
        record.info = msg.ext || {}
        record.mode = record.info.mode || 'service-worker'
        this.log(`hello from ${record.id}: ${JSON.stringify(record.info).slice(0, 200)}`)
        this.emit('hello', record)
        return
      case 'ping':
        record.conn.send(JSON.stringify({ type: 'pong', t: msg.t }))
        return
      case 'pong':
        return
      case 'result': {
        const pending = this.pending.get(msg.id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(msg.id)
        record.pending = Math.max(0, record.pending - 1)
        if (msg.ok) pending.resolve(msg.result)
        else {
          const error = new Error((msg.error && msg.error.message) || '扩展返回未知错误')
          error.code = (msg.error && msg.error.code) || 'EXTENSION_ERROR'
          pending.reject(error)
        }
        return
      }
      case 'event':
        this.emit('event', msg)
        return
      default:
        return
    }
  }

  /** 可用的扩展连接：优先 service-worker 与 pending 最少的。 */
  pickConnection() {
    const alive = [...this.connections.values()].filter((r) => !r.conn.closed)
    if (!alive.length) return null
    alive.sort((a, b) => a.pending - b.pending || b.lastSeen - a.lastSeen)
    return alive[0]
  }

  async waitForConnection(timeoutMs = this.waitForConnectionMs) {
    const current = this.pickConnection()
    if (current) return current
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('connection', onConnection)
        reject(this.noConnectionError())
      }, Math.max(0, timeoutMs))
      timer.unref?.()
      const onConnection = (record) => {
        clearTimeout(timer)
        resolve(record)
      }
      this.once('connection', onConnection)
    })
  }

  noConnectionError() {
    const err = new Error(
      '没有可用的 Edge 扩展连接。请确认：\n' +
        '1) Edge 已启动，且已加载 “DSH Edge Bridge” 扩展（edge://extensions → 开发者模式 → 加载解压缩的扩展）；\n' +
        '2) 扩展弹窗里的桥端口与本桥一致（当前 ' +
        this.port +
        '）；\n' +
        '3) 需要的话调用 edge_launch 让本插件自己拉起一个带扩展的 Edge。',
    )
    err.code = 'NO_EXTENSION'
    return err
  }

  /** 发一条命令给扩展并等待结果。 */
  async request(cmd, params = {}, options = {}) {
    const timeoutMs = Number(options.timeoutMs) || this.requestTimeoutMs
    if (options.signal?.aborted) throw abortError()
    const record = options.connection || (await this.waitForConnection(options.waitForConnectionMs))
    if (options.signal?.aborted) throw abortError()
    const id = `c${++this.seq}-${randomUUID().slice(0, 8)}`
    const payload = JSON.stringify({ type: 'cmd', id, cmd, params, timeoutMs })
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        record.pending = Math.max(0, record.pending - 1)
        const error = new Error(`命令 ${cmd} 超时（${timeoutMs}ms）`)
        error.code = 'TIMEOUT'
        reject(error)
      }, timeoutMs + 5000)
      this.pending.set(id, { cmd, connectionId: record.id, resolve, reject, timer })
      record.pending += 1
      const onAbort = () => {
        clearTimeout(timer)
        this.pending.delete(id)
        record.pending = Math.max(0, record.pending - 1)
        reject(abortError())
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      try {
        record.conn.send(payload)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        record.pending = Math.max(0, record.pending - 1)
        reject(new Error(`发送命令失败：${err && err.message}`))
      }
    })
  }

  tick() {
    const now = Date.now()
    for (const record of this.connections.values()) {
      if (record.conn.closed) continue
      if (now - record.lastSeen > 120000) {
        this.log(`connection ${record.id} 心跳超时，主动断开`)
        record.conn.close(1000, 'heartbeat timeout')
        continue
      }
      try {
        record.conn.send(JSON.stringify({ type: 'ping', t: now }))
      } catch {
        /* ignore */
      }
    }
  }

  status() {
    const now = Date.now()
    return {
      ok: true,
      name: 'dsh-edge-bridge',
      version: VERSION,
      protocol: PROTOCOL,
      url: this.address ? this.address.url : null,
      port: this.port,
      uptimeMs: this.startedAt ? now - this.startedAt : 0,
      pending: this.pending.size,
      // 注意：这里不能出现 undefined —— DSH 工具返回值必须是 lossless JSON，
      // 带 undefined 属性的对象会被 JSON 往返丢掉，导致 edge_status 直接报错。
      lastError: this.lastError || '',
      connections: [...this.connections.values()].map((r) => ({
        id: r.id,
        mode: r.mode,
        extensionVersion: r.info.extensionVersion || '',
        label: r.info.label || '',
        connected: !r.conn.closed,
        connectedMs: now - r.connectedAt,
        lastSeenMsAgo: now - r.lastSeen,
        pending: r.pending,
      })),
      edge: this.edgeInfo,
    }
  }

  // -------------------------------------------------------------------- http
  async handleHttp(req, res) {
    const url = new URL(req.url, `http://${this.host}:${this.port}`)
    const path = url.pathname
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-dsh-token')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end()
      return
    }
    if (path === '/hello') {
      sendJson(res, 200, {
        ok: true,
        name: 'dsh-edge-bridge',
        protocol: PROTOCOL,
        version: VERSION,
        token: this.token,
        port: this.port,
        pid: process.pid,
      })
      return
    }
    if (path === '/health' || path === '/status') {
      sendJson(res, 200, this.status())
      return
    }
    if (path === '/command' && req.method === 'POST') {
      const body = await readBody(req, 8 * 1024 * 1024)
      let payload
      try {
        payload = JSON.parse(body || '{}')
      } catch (err) {
        sendJson(res, 400, { ok: false, error: 'body 不是合法 JSON' })
        return
      }
      try {
        const result = await this.request(payload.cmd, payload.params || {}, { timeoutMs: payload.timeoutMs })
        sendJson(res, 200, { ok: true, result })
      } catch (err) {
        this.lastError = String(err && err.message)
        sendJson(res, 200, { ok: false, error: String(err && err.message), code: err && err.code })
      }
      return
    }
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        `<!doctype html><meta charset="utf-8"><title>DSH Edge Bridge</title>` +
          `<h1>DSH Edge Bridge</h1><p>协议 <code>${PROTOCOL}</code>，版本 ${VERSION}，端口 ${this.port}。</p>` +
          `<ul><li><a href="/health">/health</a> — 连接状态</li>` +
          `<li><a href="/hello">/hello</a> — 握手与令牌</li>` +
          `<li><a href="/test-page">/test-page</a> — 内置测试页（用于验证点击/输入）</li></ul>` +
          `<p>扩展连接地址：<code>ws://127.0.0.1:${this.port}/edge?token=***</code></p>`,
      )
      return
    }
    if (path === '/test-page' || path.startsWith('/demo/')) {
      await this.serveStatic(path, res)
      return
    }
    sendJson(res, 404, { ok: false, error: `未知路径 ${path}` })
  }

  async serveStatic(path, res) {
    if (!this.staticDir) {
      sendJson(res, 404, { ok: false, error: '未配置静态目录（staticDir）' })
      return
    }
    const rel = path === '/test-page' ? 'index.html' : path.replace(/^\/demo\//, '')
    const target = normalize(join(this.staticDir, rel))
    if (!target.startsWith(this.staticDir)) {
      sendJson(res, 403, { ok: false, error: '路径越界' })
      return
    }
    if (!existsSync(target)) {
      sendJson(res, 404, { ok: false, error: `找不到 ${rel}` })
      return
    }
    const data = await readFile(target)
    res.writeHead(200, { 'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream' })
    res.end(data)
  }
}

function abortError() {
  const error = new Error('调用已取消')
  error.code = 'ABORTED'
  return error
}

function sendJson(res, status, value) {
  if (res.headersSent) return
  const body = JSON.stringify(value, null, 2)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
