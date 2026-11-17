import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { prepareSoftwareRuntime } from '../../../main/software/runtime-manager'
import { hostElectronDistribution, electronConstraint, assertElectronVersion } from '../../../main/software/electron-runtime'
import { electronEntry } from '../../../main/software/electron-entry'
import { resolveSoftwareCommand, softwareEnvironment } from '../../../main/software/command-runtime'
import { managedRuntime, runtimeDirectoryDigest } from '../../../main/software/runtime-bindings'
import { prepareSoftwareRelease, validateSoftwareRelease } from '../../../main/software/release-store'

const previous = process.env.PROMA_HOME
let home: string | undefined
afterEach(() => { vi.restoreAllMocks(); if (previous === undefined) delete process.env.PROMA_HOME; else process.env.PROMA_HOME = previous
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) })
it('honors the npm lock instead of upgrading within a compatible declared range', () => {
  home = mkdtempSync(join(tmpdir(), 'bloma-electron-lock-'))
  writeFileSync(join(home, 'package.json'), JSON.stringify({devDependencies:{electron:'^33.2.0'}}))
  writeFileSync(join(home, 'package-lock.json'), JSON.stringify({packages:{'node_modules/electron':{version:'33.2.0'}}}))
  expect(electronConstraint(home)).toBe('33.2.0')
  expect(() => assertElectronVersion(home!, '33.3.0')).toThrow('RUNTIME_PROJECT_ENGINE_MISMATCH')
  writeFileSync(join(home, 'package-lock.json'), JSON.stringify({packages:{'node_modules/electron':{version:'39.8.10'}}}))
  expect(() => electronConstraint(home!)).toThrow('PROJECT_ELECTRON_LOCK_MISMATCH')
})
it.skipIf(process.platform !== 'win32' || !hostElectronDistribution())('imports a complete Electron offline, launches and reopens it, pins snapshots and rejects incompatible or modified resources', async () => {
  home = mkdtempSync(join(tmpdir(), 'bloma-electron-binding-')); process.env.PROMA_HOME = home
  const project = createProject({ request_id: 'electron', mode: 'quick' }, { workflowVersion: 'software-v1' }), root = project.root_path, id = project.project_id
  const version = readFileSync(join(hostElectronDistribution()!, 'version'), 'utf8').trim()
  const packageFile = join(root, 'package.json')
  writeFileSync(packageFile, JSON.stringify({ main: 'main.cjs', devDependencies: { electron: version } }))
  writeFileSync(join(root, 'main.cjs'), `const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path');app.whenReady().then(()=>{const p=path.join(process.env.APP_DATA_DIR,'count');const n=Number(fs.existsSync(p)?fs.readFileSync(p):0)+1;fs.writeFileSync(p,String(n));new BrowserWindow({show:false}).loadURL('data:text/html,<h1>'+n+'</h1>')});app.on('window-all-closed',()=>app.quit())`)
  writeFileSync(join(root, 'LAUNCH.json'), JSON.stringify({ schema_version: 2, ui: 'electron', command: ['npx', 'electron', '.'], window_title: 'Binding fixture' }))
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('network forbidden'))
  expect(() => electronEntry(root, ['electron', '.'], id)).toThrow('ELECTRON_EXECUTABLE_MISSING')
  const runtime = await prepareSoftwareRuntime(id, root, 'electron')
  expect(runtime.executable).toContain(home); expect(runtime.directory_sha256).toMatch(/^[a-f0-9]{64}$/)
  expect((await prepareSoftwareRuntime(id, root, 'electron')).reused).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
  const env = softwareEnvironment(id)
  const entry = electronEntry(root, ['npx', 'electron', '.'], id)
  expect(resolveSoftwareCommand(root, ['electron', '.'], env).command).toEqual([entry.executablePath, '.'])
  const { _electron } = await import('playwright')
  for (const count of [1, 2]) {
    const app = await _electron.launch({ ...entry, args: [...entry.args, '--user-data-dir=' + join(home!, 'profile')], cwd: root, env, timeout: 20000 })
    try { const page = await app.firstWindow(); await page.waitForSelector('h1'); expect(await page.locator('h1').textContent()).toBe(String(count)) }
    finally { await app.close() }
  }
  const release = await prepareSoftwareRelease(id, root)
  expect(release.electron_runtime?.directory_sha256).toBe(runtime.directory_sha256)
  await validateSoftwareRelease(id, release)
  writeFileSync(packageFile, JSON.stringify({ devDependencies: { electron: '33.2.0' } }))
  expect(() => electronEntry(root, ['electron', '.'], id)).toThrow('RUNTIME_PROJECT_ENGINE_MISMATCH')
  await expect(prepareSoftwareRuntime(id, root, 'electron')).rejects.toThrow('ELECTRON_COMPATIBLE_DISTRIBUTION_MISSING')
  const locale = join(runtime.executable, '..', 'locales/en-US.pak')
  expect(existsSync(locale)).toBe(true); writeFileSync(locale, 'damaged non-executable resource')
  expect(() => managedRuntime(id, 'electron')).toThrow('MANAGED_RUNTIME_DIRECTORY_CHANGED')
  await expect(validateSoftwareRelease(id, release)).rejects.toThrow('MANAGED_RUNTIME_DIRECTORY_CHANGED')
  expect(fetch).not.toHaveBeenCalled()
}, 120000)
it.skipIf(!process.env.SOFTWARE_RUNTIME_SOURCE_TEST)('imports the existing failure fixture runtime without changing its source or upgrading its version', async () => {
  home = mkdtempSync(join(tmpdir(), 'bloma-electron-source-')); process.env.PROMA_HOME = home
  const root = process.env.SOFTWARE_RUNTIME_SOURCE_TEST!, source = join(root, 'node_modules/electron/dist')
  const before = runtimeDirectoryDigest(source), version = readFileSync(join(source, 'version'), 'utf8').trim()
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('network forbidden'))
  const runtime = await prepareSoftwareRuntime('isolated-source-import', root, 'electron')
  expect(runtime.version).toBe(version); expect(runtime.source).toBe(source)
  expect(runtime.directory_sha256).toBe(before); expect(runtime.executable).toContain(home)
  expect(runtimeDirectoryDigest(source)).toBe(before); expect(fetch).not.toHaveBeenCalled()
}, 60000)
