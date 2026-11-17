import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync, statSync, copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
// This is a Node build entry with a hashbang, not a browser module. Load it
// through Node (Vitest's runner transform otherwise prepends code to #!).
const { ensureBuild, buildUnit, projectRoot } = createRequire(import.meta.url)('../../scripts/build.mjs')
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { UNITS, OUTPUTS, acquireBuildLock, cachePath, sha } from '../../scripts/build-state.mjs'

const roots = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'bloma-build-test-')); roots.push(root)
  const put = (name, value = 'one') => { mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), value) }
  put('package.json', JSON.stringify({ dependencies: {}, devDependencies: {} }))
  put('package-lock.json', '{}')
  for (const name of ['renderer/main.tsx', 'main/index.ts', 'shared/types.ts', 'preload/bridge.ts', 'main/platform/speech/speech-worker.ts', 'main/templates/app.py', 'resources/icon.svg', 'scripts/build.mjs', 'scripts/build-state.mjs', 'vite.config.ts']) put(name)
  const calls = []
  const builder = async (_, unit) => {
    calls.push(unit)
    if (unit === 'renderer' || unit === 'templates') rmSync(join(root, OUTPUTS[unit]), { recursive: true, force: true })
    put(OUTPUTS[unit] + (unit === 'renderer' ? '/index.html' : unit === 'templates' ? '/app.py' : ''), 'built-' + unit)
    return []
  }
  const run = opts => ensureBuild({ root, builder, log() {}, ...opts })
  return { root, put, run, calls, builder }
}

it('cold builds all, unchanged start hashes/reuses all without invoking any builder', async () => {
  const f = fixture(); expect((await f.run()).built).toEqual(UNITS); f.calls.length = 0
  const warm = await f.run(); expect(warm.reused).toEqual(UNITS); expect(f.calls).toEqual([])
})

describe('dependency-aware component selection', () => {
  it.each([
    ['main/index.ts', ['main']],
    ['renderer/main.tsx', ['renderer']],
    ['preload/bridge.ts', ['preload']],
    ['main/platform/speech/speech-worker.ts', ['worker']],
    ['main/software/code-service-worker.ts', ['semantic']],
    ['main/software/code-service.ts', ['main', 'semantic']],
    ['main/templates/app.py', ['templates']],
    ['shared/types.ts', ['renderer', 'main', 'worker', 'preload']],
    ['vite.config.ts', ['renderer']],
    ['resources/icon.svg', ['renderer', 'main']],
    ['scripts/build.mjs', UNITS],
    ['.env.production', ['renderer']],
  ])('%s invalidates only dependent units', async (file, expected) => {
    const f = fixture(); await f.run(); f.put(file, 'changed'); expect((await f.run()).built).toEqual(expected)
  })
  it('lockfile changes invalidate all build components', async () => {
    const f = fixture(); await f.run(); f.put('package-lock.json', '{"lockfileVersion":3}'); expect((await f.run()).built).toEqual(UNITS)
  })
  it('new/deleted source files and same-mtime content edits are detected', async () => {
    const f = fixture(); await f.run(); const path = join(f.root, 'renderer/main.tsx'), old = statSync(path)
    f.put('renderer/main.tsx', 'changed'); utimesSync(path, old.atime, old.mtime); expect((await f.run()).built).toEqual(['renderer'])
    f.put('renderer/new.ts', 'new'); expect((await f.run()).built).toEqual(['renderer'])
    rmSync(join(f.root, 'renderer/new.ts')); expect((await f.run()).built).toEqual(['renderer'])
  })
  it('actual bundled dependency bytes are checked even when package-lock and version are unchanged', async () => {
    const f = fixture(); f.put('node_modules/demo/index.js', 'old')
    const builder = async (root, unit) => { await f.builder(root, unit); return unit === 'main' ? ['node_modules/demo/index.js'] : [] }
    await f.run({ builder }); f.put('node_modules/demo/index.js', 'new'); expect((await f.run({ builder })).built).toEqual(['main'])
  })
  it('VITE variables are fingerprints, unrelated secrets are not written to cache', async () => {
    const f = fixture(); await f.run({ env: { VITE_NAME: 'a', API_SECRET: 'never-store-this' } })
    expect((await f.run({ env: { VITE_NAME: 'b', API_SECRET: 'never-store-this' } })).built).toEqual(UNITS)
    expect(readFileSync(cachePath(f.root), 'utf8')).not.toContain('never-store-this')
  })
})

it('missing, modified and extra output files invalidate only their owner', async () => {
  const f = fixture(); await f.run(); rmSync(join(f.root, OUTPUTS.preload)); expect((await f.run()).built).toEqual(['preload'])
  f.put('dist/index.html', 'tampered'); expect((await f.run()).built).toEqual(['renderer'])
  f.put('dist/extra.js', 'unproven'); expect((await f.run()).built).toEqual(['renderer'])
})
it('strict skip-build refuses stale output and never calls the builder', async () => {
  const f = fixture(); await f.run(); f.calls.length = 0; f.put('main/index.ts', 'changed')
  await expect(f.run({ verifyOnly: true })).rejects.toThrow('--skip-build'); expect(f.calls).toEqual([])
})
it('failed forced build invalidates old proofs even if unchanged old outputs still exist', async () => {
  const f = fixture(); await f.run()
  await expect(f.run({ force: true, builder: async () => { throw Error('compile failed') } })).rejects.toThrow('compile failed')
  await expect(f.run({ verifyOnly: true })).rejects.toThrow('不是当前版本')
})
it('source changes during compilation cannot be stamped as current', async () => {
  const f = fixture(); await f.run(); f.put('main/index.ts', 'v2')
  await expect(f.run({ builder: async (root, unit) => { await f.builder(root, unit); f.put('main/index.ts', 'v3'); return [] } })).rejects.toThrow('构建期间')
})
it('changes to a supposedly reused component during another build block launch', async () => {
  const f = fixture(); await f.run(); f.put('main/index.ts', 'v2')
  await expect(f.run({ builder: async (root, unit) => { await f.builder(root, unit); f.put('renderer/main.tsx', 'new'); return [] } })).rejects.toThrow('新鲜度复核')
})
it('new dependency changing after load is rejected by the final byte-level check', async () => {
  const f = fixture(); f.put('node_modules/demo/index.js', 'before')
  await expect(f.run({ builder: async (root, unit) => {
    await f.builder(root, unit)
    if (unit !== 'main') return []
    f.put('node_modules/demo/index.js', 'after')
    return { dependencies: ['node_modules/demo/index.js'], digests: new Map([['node_modules/demo/index.js', sha('before')]]) }
  } })).rejects.toThrow('构建期间')
})
it('corrupt or unsafe cache is repaired, not trusted to read paths outside the repo', async () => {
  const f = fixture(); await f.run(); writeFileSync(cachePath(f.root), '{bad json'); expect((await f.run()).built).toEqual(UNITS)
  const state = JSON.parse(readFileSync(cachePath(f.root), 'utf8')); state.units.main.dependencies = ['../../private.txt']; writeFileSync(cachePath(f.root), JSON.stringify(state))
  expect((await f.run()).built).toEqual(['main'])
})
it('OS lock prevents concurrent proof/output writers and is reusable after release', async () => {
  const f = fixture(), release = await acquireBuildLock(f.root)
  try { await expect(acquireBuildLock(f.root, 10)).rejects.toThrow('构建锁') } finally { await release() }
  await (await acquireBuildLock(f.root))()
})

it('real esbuild invalidates changed nested package resolution metadata before loading a new entry', async () => {
  const f = fixture()
  f.put('main/index.ts', 'import value from "top"; console.log(value)')
  f.put('node_modules/top/package.json', '{"name":"top","version":"1.0.0","main":"index.js"}')
  f.put('node_modules/top/index.js', 'module.exports = require("nested")')
  f.put('node_modules/top/node_modules/nested/package.json', '{"name":"nested","version":"1.0.0","main":"old.js"}')
  f.put('node_modules/top/node_modules/nested/old.js', 'module.exports = "OLD_RESOLUTION_OUTPUT"')
  f.put('node_modules/top/node_modules/nested/new.js', 'module.exports = "NEW_RESOLUTION_OUTPUT"')
  await f.run({ units: ['main'], builder: buildUnit })
  expect(readFileSync(join(f.root, OUTPUTS.main), 'utf8')).toContain('OLD_RESOLUTION_OUTPUT')
  f.put('node_modules/top/node_modules/nested/package.json', '{"name":"nested","version":"1.0.0","main":"new.js"}')
  await expect(f.run({ units: ['main'], verifyOnly: true })).rejects.toThrow('不是当前版本')
  expect((await f.run({ units: ['main'], builder: buildUnit })).built).toEqual(['main'])
  expect(readFileSync(join(f.root, OUTPUTS.main), 'utf8')).toContain('NEW_RESOLUTION_OUTPUT')
})

it('real Vite dotenv initialization succeeds then reuses in two fresh Node processes', () => {
  const f = fixture()
  f.put('renderer/index.html', '<html><body>ready</body></html>')
  f.put('renderer/.env.production', 'NODE_ENV=development\n')
  f.put('vite.config.ts', `export default {root:${JSON.stringify(join(f.root, 'renderer'))},build:{outDir:${JSON.stringify(join(f.root, 'dist'))},emptyOutDir:true}}`)
  const env = { ...process.env }; delete env.NODE_ENV; delete env.VITE_USER_NODE_ENV
  const code = `import {ensureBuild} from ${JSON.stringify(pathToFileURL(join(projectRoot, 'scripts/build.mjs')).href)};const r=await ensureBuild({root:process.argv[1],units:['renderer'],log(){}});console.log('PROOF_RESULT='+JSON.stringify(r))`
  const reports = []
  for (let i = 0; i < 2; i++) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.root], { env, encoding: 'utf8', timeout: 30000 })
    expect(child.error, child.stderr).toBeUndefined(); expect(child.status, child.stderr + child.stdout).toBe(0)
    reports.push(JSON.parse(child.stdout.split('PROOF_RESULT=')[1]))
  }
  expect(reports[0].built).toEqual(['renderer']); expect(reports[1].built).toEqual([])
}, 60000)

it.skipIf(process.platform !== 'win32')('strict skip-build never installs dependencies (safe npm stub, no network)', () => {
  const f = fixture()
  for (const name of ['build-state.mjs', 'build.mjs', 'start.mjs']) copyFileSync(join(projectRoot, 'scripts', name), join(f.root, 'scripts', name))
  f.put('npm.cmd', '@echo off\r\necho invoked>"%~dp0called.txt"\r\nexit /b 1\r\n')
  const env = { ...process.env }, path = env.Path ?? env.PATH
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key]
  env.Path = f.root + ';' + path
  const child = spawnSync(process.execPath, [join(f.root, 'scripts/start.mjs'), '--skip-build'], { env, encoding: 'utf8', timeout: 15000 })
  expect(child.status).toBe(1); expect(child.stderr).toContain('依赖缺失'); expect(existsSync(join(f.root, 'called.txt'))).toBe(false)
})
