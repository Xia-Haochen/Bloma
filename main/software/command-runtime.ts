import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { createRequire } from 'node:module'
import { buildDriverEnv, execFileDriverSpawn, resolveDriverVenvCommand } from '../desktop/process-driver'
import { managedRuntime, managedRuntimeDirectories } from './runtime-bindings'
import { capabilityEnvironment } from './capability-bindings'
import { electronEntry, isLocalElectronAlias } from './electron-entry'
import { ownedDirectory } from './owned-directory'

/** Project execution policy, NOT an OS sandbox. Arguments are passed directly;
 * Windows package-manager shims are resolved to their Node entry, never cmd /c. */
export function projectDirectory(root: string, requested = '.'): string {
  const base = realpathSync(root), target = realpathSync(resolve(base, requested))
  const rel = relative(base, target)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('COMMAND_CWD_OUTSIDE_PROJECT')
  return target
}

export function validateSoftwareCommand(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 128 || value.some(x => typeof x !== 'string' || x.includes('\0'))
    || value.join('').length > 64000 || !value[0].trim()) throw new Error('COMMAND_INVALID_ARGUMENTS')
  const command = value as string[], name = basename(command[0]).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
  const globalFlag=(arg:string)=>['--global','--global=true','-g'].includes(arg)
  let operationIndex=1
  while(globalFlag(command[operationIndex]??''))operationIndex++
  const globalRead=['ls','list','root','prefix'].includes(command[operationIndex]?.toLowerCase())
  if (/[|&<>\r\n]/.test(command[0])) throw new Error('COMMAND_EXECUTABLE_REQUIRED')
  if (['sudo', 'runas', 'format', 'diskpart', 'reg', 'regedit', 'shutdown', 'reboot', 'bcdedit', 'msiexec', 'schtasks'].includes(name)
    || name === 'git' && ['push', 'clean'].includes(command[1]?.toLowerCase())
    || ['npm', 'pnpm', 'yarn'].includes(name) && (command.some(globalFlag)&&!globalRead || ['publish', 'login', 'logout', 'config', 'unpublish'].includes(command[1]?.toLowerCase()))
    || ['cmd', 'powershell', 'pwsh', 'sh', 'bash'].includes(name) && /(?:Remove-Item|Remove-Computer|Set-ExecutionPolicy|Invoke-WebRequest.+\|\s*(?:iex|Invoke-Expression)|\brm\s+-rf|\bdel\s+\/[sq])/i.test(command.join(' '))) {
    throw new Error('COMMAND_REQUIRES_SEPARATE_AUTHORIZATION: 系统修改、外发发布或破坏性清理不属于普通项目构建')
  }
  return [...command]
}

/** Resolve the same PATH/PATHEXT candidates without spawning where.exe for
 * every verification/command. No cache: PATH changes and replaced files are
 * observed on every call. Implicit current-directory execution is not allowed. */
function pathExecutable(name: string): string | undefined {
  const file = (path: string) => { try { return statSync(path).isFile() } catch { return false } }
  if (isAbsolute(name)) return file(name) ? name : undefined
  if (name.includes('/') || name.includes(String.fromCharCode(92))) return undefined
  const windows = process.platform === 'win32'
  const environment = (key: string) => Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1] ?? ''
  const extensions = windows && !extname(name)
    ? (environment('PATHEXT') || '.COM;.EXE;.BAT;.CMD').split(';').filter(value => /^\.[a-z0-9]+$/i.test(value)) : ['']
  for (let directory of environment('PATH').split(windows ? ';' : ':')) {
    directory = directory.replace(/^"|"$/g, '')
    if (!directory || !isAbsolute(directory)) continue
    for (const extension of extensions) { const candidate = join(directory, name + extension); if (file(candidate)) return candidate }
  }
  return undefined
}

export function softwareEnvironment(projectId: string, dataDir?: string, root?:string): Record<string, string> {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error('ENVIRONMENT_PROJECT_ID_INVALID')
  const toolsHome = ownedDirectory(getPromaHome(), ['software-environments', projectId])
  const isolatedData = dataDir ? ownedDirectory(dataDir) : ownedDirectory(toolsHome, ['test-data'])
  const home = dataDir ? ownedDirectory(dirname(isolatedData), ['environment-home']) : toolsHome
  const appdata = ownedDirectory(home, ['appdata']), localappdata = ownedDirectory(home, ['localappdata'])
  // Siblings of environment-home: data-update preserves real configuration,
  // not disposable cache/temp trees, when copying an application's generation.
  const scratch = dataDir ? dirname(isolatedData) : toolsHome
  const temporary = ownedDirectory(scratch, ['execution-tmp']), cache = ownedDirectory(scratch, ['execution-cache'])
  const npmCache = ownedDirectory(cache, ['npm']), pipCache = ownedDirectory(cache, ['pip']), uvCache = ownedDirectory(cache, ['uv'])
  const electronCache = ownedDirectory(getPromaHome(), ['software-runtimes', 'electron-cache'])
  const clean = buildDriverEnv({ env_whitelist: [] } as never, process.env), directories = managedRuntimeDirectories(projectId)
  return { ...clean, ...(directories.length ? { PATH: [...directories, clean.PATH ?? clean.Path ?? ''].join(process.platform === 'win32' ? ';' : ':') } : {}),
    BLOMA_RUNTIME_PROJECT: projectId, BLOMA_SPEECH_OFFLINE:'1', ...capabilityEnvironment(projectId,root),
    HOME: home, USERPROFILE: home, APPDATA: appdata, LOCALAPPDATA: localappdata,
    TEMP: temporary, TMP: temporary, XDG_CACHE_HOME: cache, PIP_CACHE_DIR: pipCache, UV_CACHE_DIR: uvCache,
    APP_DATA_DIR: isolatedData, BROWSER: 'none', CI: '1',
    npm_config_cache: npmCache, npm_config_audit: 'false', npm_config_fund: 'false',
    // Electron's installer validates cached archive checksums. Cache downloads,
    // never share mutable node_modules or substitute another runtime version.
    electron_config_cache: electronCache,
    PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_INPUT: '1', PYTHONDONTWRITEBYTECODE: '1' }
}

export function resolveSoftwareCommand(root: string, value: unknown, environment: Record<string, string>): { command: string[]; env: Record<string, string> } {
  let command = validateSoftwareCommand(value)
  if (isLocalElectronAlias(command) || /^electron(?:\.exe|\.cmd)?$/i.test(command[0])) {
    const entry = electronEntry(root, command, environment.BLOMA_RUNTIME_PROJECT)
    command = [entry.executablePath, ...entry.args]
  }
  const name = basename(command[0]).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
  const env = { ...environment }
  if (isLocalElectronAlias(value as string[]) || /^electron(?:\.exe|\.cmd)?$/i.test((value as string[])[0])) delete env.ELECTRON_RUN_AS_NODE
  const runtimeProject = environment.BLOMA_RUNTIME_PROJECT
  const node = runtimeProject ? managedRuntime(runtimeProject, 'node')?.executable : undefined
  if (['python', 'python3'].includes(name)) {
    const original = command[0]
    command = resolveDriverVenvCommand(command, root)
    if (command[0] === original && ['python', 'python3'].includes(original) && runtimeProject) command[0] = managedRuntime(runtimeProject, 'python')?.executable ?? pathExecutable(original) ?? command[0]
  }
  if (name === 'node') {
    const executable = (command[0] === 'node' ? node : undefined) ?? pathExecutable(command[0]) ?? (command[0] === 'node' ? process.execPath : undefined)
    if (!executable) throw new Error('COMMAND_NODE_UNAVAILABLE')
    command[0] = executable
    if (process.versions.electron && executable === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
  } else if (['npm', 'npx'].includes(name)) {
    let script: string | undefined
    try { script = join(dirname(createRequire(import.meta.url).resolve('npm/package.json')), 'bin', name === 'npm' ? 'npm-cli.js' : 'npx-cli.js') } catch {}
    if (!script || !existsSync(script)) throw new Error('BUNDLED_NPM_UNAVAILABLE: 当前Bloma安装缺少开发工具，请修复运行包')
    const executable = node ?? pathExecutable('node') ?? process.execPath
    command = [executable, script, ...command.slice(1)]
    if (process.versions.electron && executable === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
  } else if (process.platform === 'win32' && ['pnpm', 'yarn'].includes(name)) {
    const shim = pathExecutable(command[0])
    if (!shim) throw new Error(`COMMAND_PACKAGE_MANAGER_UNAVAILABLE: ${name}`)
    const entry = { npm: 'npm/bin/npm-cli.js', npx: 'npm/bin/npx-cli.js', pnpm: 'pnpm/bin/pnpm.cjs', yarn: 'yarn/bin/yarn.js' }[name]!
    const candidates = [join(dirname(shim), 'node_modules', entry), join(dirname(shim), '..', 'lib', 'node_modules', entry)]
    const script = candidates.find(existsSync)
    if (!script) throw new Error(`COMMAND_PACKAGE_MANAGER_ENTRY_UNAVAILABLE: ${name}；可用node直接执行已安装的包管理器入口`)
    const executable = node ?? pathExecutable('node') ?? process.execPath
    command = [executable, script, ...command.slice(1)]
    if (process.versions.electron && executable === process.execPath) env.ELECTRON_RUN_AS_NODE = '1'
  } else if (command[0].includes('/') || command[0].includes('\\')) {
    const candidate = resolve(root, command[0])
    if (!existsSync(candidate)) throw new Error('COMMAND_EXECUTABLE_MISSING')
    command[0] = realpathSync(candidate)
  }
  if (/\.(?:bat|cmd)$/i.test(command[0])) throw new Error('COMMAND_USE_EXECUTABLE_OR_NODE_ENTRY: 不通过隐式cmd执行脚本')
  return { command, env }
}

/** Bind Chromium's profile at execution time, not in the immutable launch
 * declaration. The same app uses isolated test profiles and durable user data. */
export function bindSoftwareProfile(command:string[],environment:Record<string,string>):string[]{
  if(!/^electron(?:\.exe)?$/i.test(basename(command[0]))||!environment.APP_DATA_DIR)return command
  const profile=ownedDirectory(environment.APP_DATA_DIR,['electron-profile'])
  const clean = command.filter((arg, index) => arg !== '--user-data-dir' && !arg.startsWith('--user-data-dir=') && command[index - 1] !== '--user-data-dir')
  return[...clean,`--user-data-dir=${profile}`]
}

export async function executeSoftwareCommand(input: { root: string; projectId: string; command: unknown; cwd?: string; timeoutMs?: number; signal?: AbortSignal; dataDir?: string; browserBinding?: { endpoint: string; page: string; targetId?:string; evidenceDir: string; nativeTest?: { file: string; phase: string; trace: string } } }) {
  input.signal?.throwIfAborted()
  const cwd = projectDirectory(input.root, input.cwd)
  const resolved = resolveSoftwareCommand(input.root, input.command, softwareEnvironment(input.projectId, input.dataDir,input.root))
  resolved.command=bindSoftwareProfile(resolved.command,resolved.env)
  if (input.browserBinding) {
    resolved.env.BLOMA_PRODUCT_ROOT = input.root
    const evidence = input.browserBinding.evidenceDir
    if (!isAbsolute(evidence)) throw Error('EVIDENCE_DIRECTORY_REQUIRED')
    mkdirSync(evidence, { recursive: true })
    const rel = relative(realpathSync(input.root), realpathSync(evidence))
    if (!rel || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) throw Error('EVIDENCE_DIRECTORY_INSIDE_PROJECT')
    resolved.env.BLOMA_EVIDENCE_DIR = realpathSync(evidence)
    const endpoint = new URL(input.browserBinding.endpoint)
    if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw Error('BROWSER_SCRIPT_OWNED_ENDPOINT_REQUIRED')
    resolved.env.BLOMA_DEBUG_CDP = endpoint.href
    resolved.env.BLOMA_DEBUG_PAGE = input.browserBinding.page
    if(input.browserBinding.targetId)resolved.env.BLOMA_DEBUG_TARGET=input.browserBinding.targetId
    if (input.browserBinding.nativeTest) {
      resolved.env.BLOMA_NATIVE_TEST_FILE = input.browserBinding.nativeTest.file
      resolved.env.BLOMA_NATIVE_TEST_PHASE = input.browserBinding.nativeTest.phase
      resolved.env.BLOMA_NATIVE_TEST_TRACE = input.browserBinding.nativeTest.trace
    }
  }
  const timeoutMs = input.timeoutMs ?? 120000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('COMMAND_TIMEOUT_INVALID')
  return execFileDriverSpawn({ ...resolved, cwd, timeoutMs, signal: input.signal })
}
