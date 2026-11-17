#!/usr/bin/env node
/** Root start-bloma.cmd and npm start share this production freshness gate. */
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ensureBuild, projectRoot as root } from './build.mjs'
import { acquireBuildLock } from './build-state.mjs'

const require = createRequire(import.meta.url)
const argv = process.argv.slice(2), separator = argv.indexOf('--')
const flags = new Set(separator < 0 ? argv : argv.slice(0, separator))
const electronArgs = separator < 0 ? [] : argv.slice(separator + 1)
const allowed = ['--force-build', '--skip-build', '--no-install', '--build-only']
const report = { started_at: new Date().toISOString() }
const log = text => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${text}`)
function saveReport() {
  mkdirSync(join(root, '.bloma-build'), { recursive: true })
  const path = join(root, '.bloma-build', 'last-start.json'), tmp = path + `.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(report, null, 2)); renameSync(tmp, path)
}

function dependenciesReady() {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))
    for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]) {
      const installed = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'))
      if (installed.version !== lock.packages?.[`node_modules/${name}`]?.version) return false
    }
    const electron = require('electron')
    return typeof electron === 'string' && existsSync(electron) && existsSync(join(root, 'node_modules/.package-lock.json'))
  } catch { return false }
}

async function start() {
  if ([...flags].some(flag => !allowed.includes(flag))) throw Error('未知启动参数；Electron参数请放在 -- 之后。')
  if (flags.has('--force-build') && flags.has('--skip-build')) throw Error('--force-build 与 --skip-build 不能同时使用。')
  const lockAt = performance.now(), release = await acquireBuildLock(root)
  report.lock_wait_ms = Math.round(performance.now() - lockAt)
  try {
  const t = performance.now()
  if (!dependenciesReady()) {
    if (flags.has('--no-install') || flags.has('--skip-build')) throw Error('依赖缺失或与package-lock不一致，请先 npm ci；已停止，不启动旧产物。')
    log('▶ 安装/修复依赖（npm ci）')
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const result = spawnSync(npm, ['ci'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
    if (result.status !== 0 || !dependenciesReady()) throw Error('依赖安装失败；已停止，不启动旧产物。')
  }
  report.dependencies_ms = Math.round(performance.now() - t)
  log(`✓ 依赖检查 ${report.dependencies_ms}ms`)
  report.build = await ensureBuild({ force: flags.has('--force-build'), verifyOnly: flags.has('--skip-build'), lockHeld: true, log })
  } finally { await release() }
  if (!report.build.built.length) log(`✓ 产物与当前源码一致，无需重新构建（校验 ${report.build.total_ms}ms）`)
  else log(`✓ 已更新 ${report.build.built.join(', ')}；复用 ${report.build.reused.join(', ') || '无'}`)
  report.ok = true; saveReport()
  if (flags.has('--build-only')) return

  const token = randomUUID(), readyPath = join(root, '.bloma-build', `ready-${token}.json`)
  const env = { ...process.env, BLOMA_STARTUP_TOKEN: token }
  delete env.ELECTRON_RUN_AS_NODE
  // A production launcher never silently switches to a developer's unrelated Vite server.
  delete env.VITE_DEV_SERVER_URL
  const at = Date.now()
  log('🚀 启动 Bloma；关闭窗口可能收至托盘，彻底退出可用托盘菜单或Ctrl+C。')
  const child = spawn(require('electron'), ['.', ...electronArgs], { cwd: root, stdio: 'inherit', env })
  child.once('spawn', () => { report.electron_pid = child.pid; report.electron_spawn_ms = Date.now() - at; saveReport() })
  const timer = setInterval(() => {
    try {
      const ready = JSON.parse(readFileSync(readyPath, 'utf8'))
      if (ready.token !== token || !Number.isFinite(ready.at)) return
      report.window_pid = ready.pid
      report.window_ready_ms = Math.max(0, ready.at - at)
      report.total_to_window_ms = report.lock_wait_ms + report.dependencies_ms + report.build.total_ms + report.window_ready_ms
      saveReport(); unlinkSync(readyPath); clearInterval(timer)
      log(`✓ 首屏绘制就绪 ${report.window_ready_ms}ms（含预检/构建共 ${report.total_to_window_ms}ms）`)
    } catch { /* Optional measurement, never a reason to break the application. */ }
  }, 100)
  timer.unref()
  const timeout = setTimeout(() => clearInterval(timer), 30000); timeout.unref()
  process.once('SIGINT', () => child.kill('SIGINT'))
  child.once('error', error => { clearInterval(timer); report.ok = false; report.error = error.message; saveReport(); console.error(error.message); process.exitCode = 1 })
  child.once('close', (code, signal) => { clearInterval(timer); clearTimeout(timeout); log(`■ Bloma已退出（${code ?? signal}）`); process.exitCode = code ?? (signal ? 130 : 1) })
}

start().catch(error => { report.ok = false; report.error = error.message; saveReport(); console.error(`✗ ${error.message}`); process.exitCode = 1 })
