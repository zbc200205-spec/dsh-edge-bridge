/**
 * 极简 WebSocket 服务端（RFC 6455），零依赖。
 * 只实现桥需要的部分：文本帧、ping/pong、close、分片接收、掩码校验。
 */
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_PAYLOAD = 16 * 1024 * 1024 // 单条消息上限（截图 base64 可能较大）

const OPCODE = { CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

function unmask(payload, mask) {
  const out = Buffer.allocUnsafe(payload.length)
  for (let i = 0; i < payload.length; i++) out[i] = payload[i] ^ mask[i & 3]
  return out
}

function encodeFrame(opcode, payload) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

export class WsConnection extends EventEmitter {
  constructor(socket, request, meta = {}) {
    super()
    this.socket = socket
    this.request = request
    this.meta = meta
    this.closed = false
    this.buffer = Buffer.alloc(0)
    this.fragment = null
    this.socket.setNoDelay(true)
    this.socket.on('data', (chunk) => {
      this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
      try {
        this.drain()
      } catch (err) {
        this.emit('error', err)
        this.close(1002, 'protocol error')
      }
    })
    this.socket.on('close', () => this.finish('socket closed'))
    this.socket.on('error', (err) => this.finish(err.message))
    this.socket.on('end', () => this.finish('socket ended'))
  }

  drain() {
    for (;;) {
      if (this.closed) return
      const buf = this.buffer
      if (buf.length < 2) return
      const fin = (buf[0] & 0x80) !== 0
      const opcode = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let offset = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        const big = buf.readBigUInt64BE(2)
        if (big > BigInt(MAX_PAYLOAD)) throw new Error('帧过大')
        len = Number(big)
        offset = 10
      }
      if (!masked) throw new Error('客户端帧必须带掩码')
      if (buf.length < offset + 4) return
      const mask = buf.subarray(offset, offset + 4)
      offset += 4
      if (buf.length < offset + len) return
      const payload = unmask(buf.subarray(offset, offset + len), mask)
      this.buffer = buf.subarray(offset + len)

      if (opcode === OPCODE.CLOSE) {
        this.close(1000, '')
        return
      }
      if (opcode === OPCODE.PING) {
        this.raw(OPCODE.PONG, payload)
        continue
      }
      if (opcode === OPCODE.PONG) {
        this.emit('pong', payload)
        continue
      }
      if (opcode === OPCODE.CONTINUATION) {
        if (!this.fragment) throw new Error('没有待续帧')
        this.fragment.chunks.push(payload)
        this.fragment.size += payload.length
        if (this.fragment.size > MAX_PAYLOAD) throw new Error('分片消息过大')
        if (fin) {
          const full = Buffer.concat(this.fragment.chunks)
          const type = this.fragment.type
          this.fragment = null
          this.dispatch(type, full)
        }
        continue
      }
      // TEXT / BINARY
      if (fin) {
        this.dispatch(opcode, payload)
      } else {
        this.fragment = { type: opcode, chunks: [payload], size: payload.length }
      }
    }
  }

  dispatch(opcode, payload) {
    if (opcode === OPCODE.TEXT) this.emit('message', payload.toString('utf8'))
    else this.emit('binary', payload)
  }

  raw(opcode, payload) {
    if (this.closed) return
    try {
      this.socket.write(encodeFrame(opcode, payload))
    } catch {
      this.finish('write failed')
    }
  }

  send(text) {
    this.raw(OPCODE.TEXT, Buffer.from(String(text), 'utf8'))
  }

  ping(payload = Buffer.alloc(0)) {
    this.raw(OPCODE.PING, payload)
  }

  close(code = 1000, reason = '') {
    if (this.closed) return
    const reasonBuf = Buffer.from(String(reason), 'utf8')
    const payload = Buffer.allocUnsafe(2 + reasonBuf.length)
    payload.writeUInt16BE(code, 0)
    reasonBuf.copy(payload, 2)
    try {
      this.socket.write(encodeFrame(OPCODE.CLOSE, payload))
    } catch {
      /* ignore */
    }
    this.socket.end()
    this.finish('closed locally')
  }

  finish(reason) {
    if (this.closed) return
    this.closed = true
    try {
      this.socket.destroy()
    } catch {
      /* ignore */
    }
    this.emit('close', reason)
  }
}

/**
 * 在 http server 上挂一个 WS 端点。
 * @param {import('node:http').Server} server
 * @param {{ path?: string, verify?: (req) => {ok:boolean, reason?:string}, onConnection: (conn) => void }} options
 */
export function attachWebSocketServer(server, options = {}) {
  const path = options.path || '/edge'
  server.on('upgrade', (req, socket, head) => {
    let url
    try {
      url = new URL(req.url, 'http://127.0.0.1')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== path) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const key = req.headers['sec-websocket-key']
    const upgrade = String(req.headers.upgrade || '').toLowerCase()
    if (!key || upgrade !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }
    const verdict = options.verify ? options.verify(req, url) : { ok: true }
    if (!verdict.ok) {
      socket.write(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n`)
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
    )
    const conn = new WsConnection(socket, req, verdict.meta || {})
    if (head && head.length) {
      conn.buffer = head
      try {
        conn.drain()
      } catch {
        /* ignore */
      }
    }
    options.onConnection(conn)
  })
}
