import { mkdirSync, cpSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '..')
const runtime = join(root, 'run-artifacts/complex-trial-runtime/main/runner.mjs')
if (!process.versions.electron) {
  mkdirSync(dirname(runtime), { recursive: true })
  cpSync(join(root, 'main/templates'), join(dirname(runtime), 'templates'), { recursive: true, filter: p => !p.includes('__pycache__') })
  const { build } = await import('esbuild')
  await build({ stdin: { contents: "export { main } from './scripts/software-complex-trial'", resolveDir: root }, outfile: runtime, bundle: true, platform: 'node', format: 'esm', packages: 'external' })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [import.meta.filename], { cwd: root, env, windowsHide: true, stdio: 'inherit' })
  child.once('error', error => { console.error(error.message); process.exitCode = 1 })
  child.once('exit', code => { process.exitCode = code ?? 1 })
} else {
  const { app } = await import('electron')
  import(pathToFileURL(runtime).href).then(api => api.main()).then(() => app.exit(0), error => { console.error(error.message); app.exit(1) })
}
