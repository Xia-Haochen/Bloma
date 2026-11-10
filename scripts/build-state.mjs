import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, lstatSync, mkdirSync, writeFileSync, renameSync, realpathSync } from 'node:fs'
import { resolve, relative, join, isAbsolute, sep } from 'node:path'
import { createServer } from 'node:net'
import { readFile, readdir, stat, realpath } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

export const UNITS = ['renderer', 'main', 'worker', 'preload', 'templates']
export const OUTPUTS = { renderer: 'dist', main: 'dist-main/main/index.js', worker: 'dist-main/main/platform/speech/worker.mjs', preload: 'dist-main/preload/bridge.cjs', templates: 'dist-main/main/templates' }
const ROOTS = { renderer: ['renderer', 'resources', 'shared', 'vite.config.ts', '.env', '.env.local', '.env.production', '.env.production.local'], main: ['main', 'storage', 'shared', 'resources'], worker: ['main/platform/speech', 'shared'], preload: ['preload', 'shared'], templates: ['main/templates'] }
const COMMON = ['package.json', 'package-lock.json', 'tsconfig.json', '.npmrc', 'scripts/build.mjs', 'scripts/build-state.mjs', 'node_modules/.package-lock.json', 'node_modules/vite/dist/node', 'node_modules/esbuild/lib', `node_modules/@esbuild/${process.platform}-${process.arch}`]
export const sha = data => createHash('sha256').update(data).digest('hex')
export const cachePath = root => join(root, '.bloma-build', 'state.json')

export function localPath(root, name) {
  if (typeof name !== 'string' || isAbsolute(name) || name.includes('\0')) throw Error('无效构建依赖路径')
  const path = resolve(root, name)
  if (!path.startsWith(resolve(root) + sep)) throw Error('构建依赖超出项目目录')
  return path
}

/** Track actual bundled dependencies, including node_modules junctions in isolated tests. */
export function dependencyName(root, path) {
  path = resolve(path.replace(/^\/([A-Za-z]:\/)/, '$1'))
  if (path.startsWith(resolve(root) + sep)) return relative(root, path).split(sep).join('/')
  const modules = join(root, 'node_modules')
  if (existsSync(modules)) {
    const actual = realpathSync(modules)
    if (path.startsWith(actual + sep)) return 'node_modules/' + relative(actual, path).split(sep).join('/')
  }
  throw Error(`无法确认外部构建输入的新鲜度：${path}`)
}

export function snapshot(root, env = process.env, prefetched) {
  const trees = new Map(), hashes = new Map()
  function files(name) {
    if (trees.has(name)) return trees.get(name)
    if (prefetched) {
      const entry = prefetched.get(name)
      const rows = Array.isArray(entry) ? entry.flatMap(n => files(n)) : [name]
      trees.set(name, rows)
      return rows
    }
    const path = localPath(root, name)
    let rows
    if (!existsSync(path)) rows = [name]
    else if (lstatSync(path).isDirectory()) rows = readdirSync(path).sort().filter(n => n !== '__pycache__').flatMap(n => files(name + '/' + n))
    else rows = [name]
    trees.set(name, rows)
    return rows
  }
  function digest(name) {
    if (!hashes.has(name)) {
      const path = localPath(root, name)
      if (prefetched) {
        if (!prefetched.has(name)) throw Error(`未捕获的构建输入：${name}`)
        hashes.set(name, prefetched.get(name))
        return hashes.get(name)
      }
      // Source symlinks require an explicit build graph; never treat them as empty directories.
      hashes.set(name, existsSync(path) && !lstatSync(path).isDirectory() ? sha(readFileSync(path)) : 'missing')
    }
    return hashes.get(name)
  }
  let packages = []
  if (existsSync(join(root, 'package.json'))) {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    packages = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].map(n => `node_modules/${n}/package.json`)
  }
  const environment = Object.fromEntries(Object.entries({ ...env, NODE_ENV: env.NODE_ENV ?? 'production' }).filter(([k]) => k === 'NODE_ENV' || k.startsWith('VITE_')).sort(([a], [b]) => a.localeCompare(b)))
  function hash(names) { return sha(JSON.stringify([...new Set(names.flatMap(files))].sort().map(n => [n, digest(n)]))) }
  return {
    digest,
    input(unit, dependencies = []) {
      let names = ROOTS[unit].flatMap(files)
      if (unit === 'main') names = names.filter(n => !n.startsWith('main/templates/') && n !== 'main/platform/speech/speech-worker.ts')
      return sha(JSON.stringify([1, resolve(root), process.version, process.platform, process.arch, environment, prefetched?.packageMetadata ?? '', hash([...COMMON, ...packages, ...names, ...dependencies])]))
    },
    output(unit) {
      const required = unit === 'renderer' ? join(root, 'dist/index.html') : join(root, OUTPUTS[unit])
      const requiredName = relative(root, required).split(sep).join('/')
      if ((prefetched ? prefetched.get(requiredName) === 'missing' : !existsSync(required)) || files(OUTPUTS[unit]).every(n => digest(n) === 'missing')) return null
      return hash([OUTPUTS[unit]])
    },
  }
}

/** Hash bytes with bounded concurrent IO; never substitute mtimes for content. */
export async function capture(root, env = process.env, dependencies = []) {
  const data = new Map(), pending = new Map(), queue = []
  let active = 0
  async function limited(fn) {
    if (active >= 16) await new Promise(ok => queue.push(ok))
    active++
    try { return await fn() } finally { active--; queue.shift()?.() }
  }
  async function visit(name, directoryHint) {
    if (pending.has(name)) return pending.get(name)
    const work = (async () => {
      const path = localPath(root, name)
      try {
        const directory = directoryHint ?? (await limited(() => stat(path))).isDirectory()
        if (directory) {
          const children = (await limited(() => readdir(path, { withFileTypes: true }))).filter(e => e.name !== '__pycache__').sort((a, b) => a.name.localeCompare(b.name))
          data.set(name, children.map(e => name + '/' + e.name))
          await Promise.all(children.map(e => visit(name + '/' + e.name, e.isSymbolicLink() ? undefined : e.isDirectory())))
        } else data.set(name, sha(await limited(() => readFile(path))))
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') data.set(name, 'missing')
        else throw error
      }
    })()
    pending.set(name, work)
    return work
  }
  // Resolution reads package metadata, not just loaded JS. Include nested and
  // manually added package boundaries/layout, so main/exports/browser changes
  // or a newly shadowing package cannot silently reuse the previous bundle.
  const metadata = []
  async function packageTree(name, ancestors = new Set()) {
    const dir = localPath(root, name)
    let actual, children
    try {
      actual = await limited(() => realpath(dir))
      metadata.push([name, actual])
      if (ancestors.has(actual)) return
      ancestors = new Set([...ancestors, actual])
      children = (await limited(() => readdir(dir, { withFileTypes: true }))).filter(e => !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink()))
    } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { metadata.push([name, 'missing']); return } throw error }
    async function onePackage(pkgName) {
      const path = pkgName + '/package.json'
      await visit(path)
      metadata.push([path, data.get(path)])
      await packageTree(pkgName + '/node_modules', ancestors)
    }
    await Promise.all(children.map(async entry => {
      const path = name + '/' + entry.name
      if (entry.name.startsWith('@')) {
        const scoped = await limited(() => readdir(localPath(root, path), { withFileTypes: true }))
        await Promise.all(scoped.filter(e => e.isDirectory() || e.isSymbolicLink()).map(e => onePackage(path + '/' + e.name)))
      } else await onePackage(path)
    }))
  }
  await packageTree('node_modules')
  data.packageMetadata = sha(JSON.stringify(metadata.sort(([a], [b]) => a.localeCompare(b))))
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const packages = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})].map(n => `node_modules/${n}/package.json`)
  await Promise.all([...new Set([...COMMON, ...Object.values(ROOTS).flat(), ...Object.values(OUTPUTS), 'dist/index.html', ...packages, ...dependencies])].map(n => visit(n)))
  return snapshot(root, env, data)
}

export function readState(root) {
  try {
    const raw = readFileSync(cachePath(root), 'utf8')
    if (raw.length > 4_000_000) return { version: 1, units: {} }
    const state = JSON.parse(raw)
    if (state.version !== 1 || !state.units || typeof state.units !== 'object') throw Error('schema')
    return state
  } catch { return { version: 1, units: {} } }
}
export function writeState(root, state) {
  mkdirSync(join(root, '.bloma-build'), { recursive: true })
  const tmp = cachePath(root) + `.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  renameSync(tmp, cachePath(root))
}
export function fresh(view, unit, receipt) {
  try { return receipt && Array.isArray(receipt.dependencies) && receipt.input === view.input(unit, receipt.dependencies) && receipt.output === view.output(unit) && receipt.output !== null }
  catch { return false }
}

/** OS-owned short-lived lock; Windows pipe disappears even after a killed build. */
export async function acquireBuildLock(root, timeoutMs = 120000) {
  const key = sha(realpathSync(root).toLowerCase()).slice(0, 24)
  const address = process.platform === 'win32' ? `\\\\.\\pipe\\bloma-build-${key}` : { host: '127.0.0.1', port: 40000 + parseInt(key.slice(0, 6), 16) % 20000 }
  const start = Date.now()
  for (;;) {
    const server = createServer(socket => socket.end())
    try {
      await new Promise((ok, fail) => { server.once('error', fail); server.listen(address, () => { server.removeListener('error', fail); ok() }) })
      return () => new Promise((ok, fail) => server.close(error => error ? fail(error) : ok()))
    } catch (error) {
      server.close()
      if (error.code !== 'EADDRINUSE' || Date.now() - start >= timeoutMs) throw Error(`另一次构建仍在进行或构建锁不可用，请稍后重试（${error.code}）。`)
      await delay(100)
    }
  }
}
