/**
 * DSH 插件入口：dsh-edge-bridge
 *
 * 作用：在 DSH 进程内起一个本机桥（HTTP + WebSocket），
 * 让 Edge 扩展连上来，并把 edge_* 工具注册进 ctx.tools。
 *
 * 依赖：只使用 node 内置模块（零 npm 依赖），因此可以直接放进 profile 的
 * node_modules 里被加载，不需要 pnpm 安装流程。
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeServer, DEFAULT_PORT, PROTOCOL, VERSION } from './bridge.mjs'
import { registerEdgeTools } from './tools.mjs'
import { defaultUserDataDir } from './edge-launcher.mjs'

export const name = 'dsh-edge-bridge'
export const inject = ['tools']
export { PROTOCOL, VERSION }

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 解析扩展目录：配置 > 插件包内 edge-extension > 同级目录里的 edge-extension > 当前工作目录下 edge-extension。 */
export function resolveExtensionDir(config = {}) {
  const candidates = []
  if (config.extensionDir) candidates.push(config.extensionDir)
  if (process.env.DSH_EDGE_EXTENSION_DIR) candidates.push(process.env.DSH_EDGE_EXTENSION_DIR)
  candidates.push(join(packageDir, 'edge-extension'))
  // 开发态常用布局：仓库里 dsh-plugin-edge-bridge/ 与 edge-extension/ 是兄弟目录
  // （profile 用 file: 依赖直接指向源码目录时，扩展并不在插件包内部）。
  candidates.push(join(packageDir, '..', 'edge-extension'))
  candidates.push(join(process.cwd(), 'edge-extension'))
  for (const candidate of candidates) {
    if (!candidate) continue
    const full = isAbsolute(candidate) ? candidate : resolve(process.cwd(), candidate)
    if (existsSync(join(full, 'manifest.json'))) return full
    if (candidate === candidates[0] && existsSync(full)) return full
  }
  return null
}

/** 解析静态目录（内置测试页用）。 */
function resolveStaticDir(config = {}) {
  const candidates = []
  if (config.staticDir) candidates.push(config.staticDir)
  candidates.push(join(packageDir, 'test-page'))
  candidates.push(join(process.cwd(), 'tests', 'local-page'))
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return resolve(candidate)
  }
  return null
}

export function normalizeConfig(config = {}) {
  const raw = {}
  for (const [key, value] of Object.entries(config || {})) {
    raw[key] = value && typeof value.get === 'function' ? value.get() : value
  }
  const defaultLog = process.env.DSH_HOME
    ? join(process.env.DSH_HOME, 'logs', 'dsh-edge-bridge.log')
    : join(process.cwd(), '.dsh-edge', 'bridge.log')
  return {
    port: Number(raw.port) || DEFAULT_PORT,
    host: raw.host || '127.0.0.1',
    token: raw.token || '',
    allowNoToken: raw.allowNoToken === true,
    edgePath: raw.edgePath || '',
    extensionDir: raw.extensionDir || '',
    staticDir: raw.staticDir || '',
    userDataDir: raw.userDataDir || '',
    screenshotFolder: raw.screenshotFolder || '.dsh-edge',
    logFile: raw.logFile === false ? null : raw.logFile || defaultLog,
    timeoutMs: Number(raw.timeoutMs) || 30000,
    launchWaitMs: Number(raw.launchWaitMs) || 20000,
    waitForConnectionMs: Number(raw.waitForConnectionMs) || 10000,
    registerTools: raw.registerTools !== false,
  }
}

export function apply(ctx, config = {}) {
  const settings = normalizeConfig(config)
  const extensionDir = resolveExtensionDir(settings)
  settings.extensionDir = extensionDir || ''
  settings.userDataDir = settings.userDataDir || defaultUserDataDir()

  if (settings.logFile) {
    try {
      mkdirSync(dirname(settings.logFile), { recursive: true })
    } catch {
      settings.logFile = null
    }
  }

  const writeLog = (level, ...args) => {
    const line = `[${new Date().toISOString()}] [${level}] ${args
      .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
      .join(' ')}\n`
    if (settings.logFile) {
      try {
        appendFileSync(settings.logFile, line)
      } catch {
        /* ignore */
      }
    }
    try {
      const logger = ctx.logger
      if (logger && typeof logger.info === 'function' && level === 'info') logger.info(...args)
      else if (logger && typeof logger.warn === 'function' && level !== 'info') logger.warn(...args)
      else if (typeof logger === 'function') logger('dsh-edge-bridge', ...args)
    } catch {
      /* 日志失败不影响功能 */
    }
  }

  const bridge = new BridgeServer({
    port: settings.port,
    host: settings.host,
    token: settings.token || undefined,
    allowNoToken: settings.allowNoToken,
    staticDir: resolveStaticDir(settings),
    logger: (...args) => writeLog('info', args),
  })
  bridge.edgeInfo = null

  let disposed = false
  ctx.effect(() => {
    bridge
      .start()
      .then((address) => {
        writeLog('info', `bridge ready at ${address.url} (protocol ${PROTOCOL}, v${VERSION}, extensionDir=${settings.extensionDir || '未找到'})`)
      })
      .catch((err) => {
        writeLog('error', `bridge failed to start on ${settings.host}:${settings.port}: ${err && err.message}`)
      })
    return () => {
      disposed = true
      return bridge.stop()
    }
  })

  if (settings.registerTools) {
    const registered = registerEdgeTools(ctx, bridge, settings)
    writeLog('info', `registered tools: ${registered.tools.join(', ')}`)
  }

  try {
    if (typeof ctx.set === 'function') ctx.set('edgeBridge', bridge)
  } catch {
    /* ignore */
  }

  return { bridge, settings, disposed: () => disposed }
}

function safeStringify(value) {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
