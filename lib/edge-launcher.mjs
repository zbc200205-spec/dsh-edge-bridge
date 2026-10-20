/** 定位并启动 Edge（默认独立 profile；优先命令行加载扩展，失败时可用 CDP 兜底）。 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { loadUnpackedExtension, ensureExtensionEnabled, waitForDebugPort } from './cdp-client.mjs'

export function findEdgePath(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.DSH_EDGE_PATH) candidates.push(process.env.DSH_EDGE_PATH)
  const pf = process.env.ProgramFiles || 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA
  candidates.push(join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  candidates.push(join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  if (local) candidates.push(join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  return null
}

export function defaultUserDataDir(name = 'dsh-edge') {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'edge-profiles', name)
}

/** 找本机空闲端口（用于 --remote-debugging-port）。 */
export function pickFreePort(host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, host, () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/**
 * 启动 Edge。
 * @param {object} options
 * @param {'dedicated'|'default'} [options.profile='dedicated']
 * @param {string} [options.extensionDir] 命令行加载的扩展目录
 * @param {number} [options.debugPort] 远程调试端口（提供后可 CDP 兜底加载扩展）
 */
export function launchEdge(options = {}) {
  const edgePath = findEdgePath(options.edgePath)
  if (!edgePath) {
    const error = new Error('找不到 msedge.exe。请通过配置 edgePath 指定 Edge 可执行文件路径。')
    error.code = 'EDGE_NOT_FOUND'
    throw error
  }
  const dedicated = options.profile !== 'default'
  const args = []
  let userDataDir = null
  if (dedicated) {
    userDataDir = options.userDataDir || defaultUserDataDir(options.profileName || 'dsh-edge')
    mkdirSync(userDataDir, { recursive: true })
    args.push(`--user-data-dir=${userDataDir}`)
    args.push('--no-first-run', '--no-default-browser-check', '--disable-sync', '--no-service-autorun')
    args.push('--disable-features=DisableLoadExtensionCommandLineSwitch')
  } else {
    args.push('--new-window')
  }
  if (options.extensionDir) {
    args.push(`--load-extension=${options.extensionDir}`)
    args.push(`--disable-extensions-except=${options.extensionDir}`)
    args.push('--enable-unsafe-extension-debugging')
  }
  if (options.debugPort) {
    args.push(`--remote-debugging-port=${options.debugPort}`)
    args.push('--remote-allow-origins=*')
  }
  if (options.headless) args.push('--headless=new', '--disable-gpu', '--hide-scrollbars')
  if (options.windowSize) args.push(`--window-size=${options.windowSize}`)
  if (Array.isArray(options.extraArgs)) args.push(...options.extraArgs)
  args.push(options.url || 'about:blank')

  const child = spawn(edgePath, args, { detached: true, stdio: 'ignore' })
  child.unref()
  return {
    pid: child.pid,
    edgePath,
    profile: dedicated ? 'dedicated' : 'default',
    userDataDir,
    extensionDir: dedicated ? options.extensionDir || null : null,
    debugPort: options.debugPort || null,
    args,
  }
}

/**
 * 扩展装了但没连上桥时的补救：先尝试恢复「已禁用」的扩展，再等一次连接。
 * @returns {Promise<{ok:boolean, state?:string, changed?:boolean, reason?:string, connected:boolean}>}
 */
async function recoverDisabledExtension(debugPort, extensionDir, connect, options) {
  let enabled
  try {
    enabled = await ensureExtensionEnabled(debugPort, extensionDir)
  } catch (err) {
    return { ok: false, reason: String(err && err.message), connected: false }
  }
  if (!enabled.ok) return { ...enabled, connected: false }
  const connected = await connect(options.recoverWaitMs || 12000)
  return { ...enabled, connected }
}

/**
 * 启动 Edge + 扩展：命令行 → 救回禁用态扩展 → CDP 加载 → 再救一次。
 * @param {(ms:number)=>Promise<boolean>} [options.waitForBridge] 返回 true 表示扩展已连上桥
 */
export async function launchEdgeWithExtension(options = {}) {
  const extensionDir = options.extensionDir
  if (!extensionDir || !existsSync(join(extensionDir, 'manifest.json'))) {
    throw new Error(`扩展目录无效：${extensionDir || '(未提供)'}`)
  }
  const debugPort = options.debugPort || (await pickFreePort())
  const info = launchEdge({ ...options, extensionDir, debugPort })
  const waitForBridge = options.waitForBridge
  const result = {
    ...info,
    extension: { strategy: 'arg', loaded: false, error: null },
    cdp: null,
    recovery: null,
    connected: false,
  }
  const connect = async (ms) => (typeof waitForBridge === 'function' ? await waitForBridge(ms) : false)

  // 1) 命令行 --load-extension
  if (await connect(options.argWaitMs || 12000)) {
    result.extension = { strategy: 'arg', loaded: true, error: null }
    result.connected = true
    return result
  }

  // 2) 命令行装上了、但扩展停在禁用态（Edge 155 实测会遇到）：救一次再看
  if (options.recover !== false) {
    result.recovery = await recoverDisabledExtension(debugPort, extensionDir, connect, options)
    if (result.recovery.connected) {
      result.extension = { strategy: 'arg', loaded: true, error: null }
      result.connected = true
      return result
    }
  }

  // 3) 兜底：CDP 加载未打包扩展
  try {
    await waitForDebugPort(debugPort, options.cdpTimeoutMs || 20000)
    const loaded = await loadUnpackedExtension(debugPort, extensionDir, { loadTimeoutMs: 20000 })
    result.cdp = loaded
    if (loaded.ok) {
      result.extension = { strategy: 'cdp', loaded: true, error: null, id: loaded.id }
      if (await connect(options.cdpWaitMs || 20000)) {
        result.connected = true
        return result
      }
      // 4) CDP 装上了但仍是禁用态：再救一次
      if (options.recover !== false) {
        result.recovery = await recoverDisabledExtension(debugPort, extensionDir, connect, options)
        result.connected = result.recovery.connected === true
      }
      return result
    }
    result.extension = { strategy: 'cdp', loaded: false, error: loaded.error }
  } catch (err) {
    result.extension = { strategy: 'cdp', loaded: false, error: String(err && err.message) }
  }
  return result
}

/** 关闭由本模块启动的 Edge（按进程树）。 */
export function killEdge(pid) {
  if (!pid) return
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* ignore */
  }
}
