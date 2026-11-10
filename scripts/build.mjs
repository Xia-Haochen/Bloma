#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UNITS, OUTPUTS, capture, localPath, readState, writeState, fresh, acquireBuildLock, dependencyName, sha } from './build-state.mjs'

export const projectRoot = fileURLToPath(new URL('../', import.meta.url))

/** Same production options as the previous CLI chains; no dev-server substitution. */
export async function buildUnit(root, unit) {
  const captured = new Map(), dependencies = new Set()
  function track(path) {
    if (path.startsWith('\0')) return
    path = path.split('?')[0].replace(/^\/([A-Za-z]:\/)/, '$1')
    if (!existsSync(path)) return
    const name = dependencyName(root, path)
    try { if (!captured.has(name)) captured.set(name, sha(readFileSync(path))); dependencies.add(name) }
    catch (error) { if (error.code !== 'EISDIR') throw error }
  }
  if (unit === 'templates') {
    if (!existsSync(join(root, 'main/templates'))) throw Error('模板源目录缺失')
    rmSync(join(root, OUTPUTS.templates), { recursive: true, force: true })
    mkdirSync(join(root, OUTPUTS.templates), { recursive: true })
    cpSync(join(root, 'main/templates'), join(root, OUTPUTS.templates), { recursive: true, filter: path => !path.includes('__pycache__') })
  } else if (unit === 'renderer') {
    const { build } = await import('vite')
    await build({ configFile: join(root, 'vite.config.ts'), plugins: [{ name: 'bloma-input-proof', enforce: 'pre', load(id) { track(id); return null }, buildEnd() { for (const id of this.getWatchFiles()) track(id) } }] })
  } else {
    const { build } = await import('esbuild')
    const external = unit === 'main' ? ['electron', 'playwright', 'typescript', '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core', '@earendil-works/pi-ai'] : unit === 'worker' ? ['electron', 'sherpa-onnx-node'] : ['electron']
    const entry = unit === 'main' ? 'main/index.ts' : unit === 'worker' ? 'main/platform/speech/speech-worker.ts' : 'preload/bridge.ts'
    const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, platform: 'node', format: unit === 'preload' ? 'cjs' : 'esm', external, outfile: join(root, OUTPUTS[unit]), metafile: true, plugins: [{ name: 'bloma-input-proof', setup(api) { api.onLoad({ filter: /.*/ }, ({ path }) => { track(path); return undefined }) } }] })
    for (const path of Object.keys(result.metafile.inputs)) dependencies.add(dependencyName(root, resolve(root, path)))
  }
  return { dependencies: [...dependencies].sort(), digests: captured }
}

/** One entry for forced production builds and safe incremental launches. */
export async function ensureBuild({ root = projectRoot, units = UNITS, force = false, verifyOnly = false, builder = buildUnit, env = process.env, log = console.log, lockTimeoutMs, lockHeld = false } = {}) {
  if (units.some(unit => !UNITS.includes(unit))) throw Error('未知构建组件')
  // Vite initializes derived NODE_ENV/VITE_USER_NODE_ENV itself. Compare the
  // caller's immutable environment, not that builder-mutated global object.
  env = { ...env }
  const started = performance.now(), release = lockHeld ? async () => {} : await acquireBuildLock(root, lockTimeoutMs)
  const result = { built: [], reused: [], phases_ms: {}, check_ms: 0, total_ms: 0 }
  try {
    const state = readState(root)
    const beforeDependencies = Object.fromEntries(UNITS.map(unit => {
      let deps = state.units[unit]?.dependencies
      try { if (!Array.isArray(deps)) deps = []; for (const name of deps) localPath(root, name) } catch { deps = [] }
      return [unit, deps]
    }))
    const before = await capture(root, env, Object.values(beforeDependencies).flat())
    const plan = units.filter(unit => force || !fresh(before, unit, state.units[unit]))
    result.check_ms = Math.round(performance.now() - started)
    if (verifyOnly && plan.length) throw Error(`构建不是当前版本（${plan.join(', ')}）。请去掉 --skip-build 自动更新；不能跳过失败或过期构建。`)
    // Invalidate before touching outputs, including a force build with unchanged input.
    const initial = Object.fromEntries(units.map(unit => [unit, before.input(unit, beforeDependencies[unit])]))
    const completed = {}
    for (const unit of plan) delete state.units[unit]
    if (plan.length) writeState(root, state)
    for (const unit of units) {
      if (!plan.includes(unit)) { result.reused.push(unit); continue }
      log(`▶ 构建 ${unit}`)
      const t = performance.now(), built = await builder(root, unit)
      completed[unit] = Array.isArray(built) ? { dependencies: built, digests: new Map() } : built
      result.phases_ms[unit] = Math.round(performance.now() - t)
      result.built.push(unit)
      log(`✓ ${unit} ${result.phases_ms[unit]}ms`)
    }
    if (plan.length) {
      const after = await capture(root, env, [...Object.values(beforeDependencies).flat(), ...Object.values(completed).flatMap(value => value.dependencies)])
      for (const unit of plan) {
        const { dependencies, digests } = completed[unit]
        if (after.input(unit, beforeDependencies[unit]) !== initial[unit] || [...digests].some(([name, digest]) => after.digest(name) !== digest)) throw Error('构建期间源码、配置或依赖发生变化，请重新启动；不会运行旧产物。')
        const output = after.output(unit)
        if (!output) throw Error(`构建未生成有效产物：${unit}`)
        state.units[unit] = { input: after.input(unit, dependencies), output, dependencies, built_at: new Date().toISOString() }
      }
      if (units.some(unit => !fresh(after, unit, state.units[unit]))) throw Error('启动前新鲜度复核失败，请重新启动；不会运行旧产物。')
      writeState(root, state)
    }
    result.total_ms = Math.round(performance.now() - started)
    return result
  } finally { await release() }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const target = process.argv[2] ?? 'all'
  const units = target === 'all' ? UNITS : target === 'main' ? UNITS.filter(unit => unit !== 'renderer') : target === 'renderer' ? ['renderer'] : null
  if (!units) { console.error('用法：node scripts/build.mjs [all|main|renderer]'); process.exitCode = 1 }
  else ensureBuild({ units, force: true }).catch(error => { console.error(`✗ ${error.message}`); process.exitCode = 1 })
}
