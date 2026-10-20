#!/usr/bin/env node
/**
 * 独立运行的桥（不依赖 DSH）——用于单独调试扩展、或给其它程序调用。
 *
 *   node bin/edge-bridge.mjs [--port 17373] [--launch-edge] [--headless] [--url http://127.0.0.1:17373/test-page]
 *
 * 启动后：
 *   - GET  http://127.0.0.1:<port>/health           查看连接状态
 *   - GET  http://127.0.0.1:<port>/test-page        内置测试页
 *   - POST http://127.0.0.1:<port>/command          执行命令 {"cmd":"snapshot","params":{}}
 */
import { BridgeServer, DEFAULT_PORT } from '../lib/bridge.mjs'
import { findEdgePath, launchEdge } from '../lib/edge-launcher.mjs'
import { existsSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspaceDir = resolve(packageDir, '..')

function parseArgs(argv) {
  const args = { port: DEFAULT_PORT, launchEdge: false, headless: false, url: '', extensionDir: '' }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--port') args.port = Number(argv[++i])
    else if (token === '--launch-edge') args.launchEdge = true
    else if (token === '--headless') args.headless = true
    else if (token === '--url') args.url = argv[++i]
    else if (token === '--extension') args.extensionDir = argv[++i]
    else if (token === '--help' || token === '-h') args.help = true
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(`用法: node bin/edge-bridge.mjs [--port ${DEFAULT_PORT}] [--launch-edge] [--headless] [--url <url>] [--extension <dir>]`)
  process.exit(0)
}

const candidates = [args.extensionDir, join(packageDir, 'edge-extension'), join(workspaceDir, 'edge-extension')].filter(Boolean)
const extensionDir = candidates.find((dir) => existsSync(join(dir, 'manifest.json'))) || null
const testPageDir = [join(packageDir, 'test-page'), join(workspaceDir, 'tests', 'local-page')].find((dir) => existsSync(dir)) || null

const logFile = join(workspaceDir, '.dsh-edge', 'standalone-bridge.log')
const bridge = new BridgeServer({
  port: args.port,
  staticDir: testPageDir,
  logger: (...parts) => {
    const line = `[${new Date().toISOString()}] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}`
    console.log(line)
    try {
      appendFileSync(logFile, line + '\n')
    } catch {
      /* ignore */
    }
  },
})

const address = await bridge.start()
console.log(`\n桥已启动: ${address.url}`)
console.log(`扩展目录: ${extensionDir || '未找到（请把 edge-extension 放在插件包或工作区根目录）'}`)
console.log(`测试页:   ${testPageDir ? `${address.url}/test-page` : '未找到 tests/local-page'}`)

if (args.launchEdge) {
  if (!extensionDir) {
    console.error('启动 Edge 需要扩展目录')
  } else {
    const info = launchEdge({
      extensionDir,
      headless: args.headless,
      url: args.url || `${address.url}/test-page`,
      windowSize: '1440,900',
    })
    console.log(`已启动 Edge pid=${info.pid} profile=${info.userDataDir}`)
    console.log(`msedge: ${findEdgePath()}`)
  }
}

process.on('SIGINT', async () => {
  await bridge.stop()
  process.exit(0)
})

// 有连接/断开时打印，便于观察
bridge.on('connection', (record) => console.log(`[event] 扩展连接 ${record.id}`))
bridge.on('hello', (record) => console.log(`[event] hello: ${JSON.stringify(record.info)}`))
bridge.on('connection-closed', (id) => console.log(`[event] 扩展断开 ${id}`))
