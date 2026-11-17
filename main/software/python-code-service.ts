import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { getPromaHome } from '../../storage/config-paths'
import { mainRootDir } from '../platform/paths'
import type { CodeServiceItem, CodeServiceRequest } from './code-service'

export interface PythonCodeServiceSuccess {
  ok: true; backend: 'jedi'; language: 'python'; jediVersion: string; parsoVersion: string; pythonVersion: string
  kind: CodeServiceRequest['kind']; path: string; fileVersion: string; indexVersion: string
  config: { mode: 'bounded-snapshot'; files: string[]; filesTruncated: boolean }
  items: Array<CodeServiceItem | { kind: 'reference'; isDefinition: boolean; writeAccess: 'unknown'; location: Extract<CodeServiceItem, {kind:'reference'}>['location'] } | { kind: 'diagnostic'; code: string; category: string; message: string; messageTruncated: boolean; location?: Extract<CodeServiceItem, {kind:'definition'}>['location'] }>
  truncated: boolean; boundary: { deniedReads: number; omittedExternalResults: number; examples: string[] }
  observed: { files: number; bytes: number; projectFiles: number }; timings: { totalMs: number; backendImportMs: number; queryMs: number }; cache: 'fresh-jedi-snapshot'; limitations: string[]
}
export type PythonCodeServiceResult = PythonCodeServiceSuccess | { ok: false; backend: 'jedi' | 'unavailable'; error: {code: string; message: string} }
class PythonFailure extends Error { constructor(readonly code: string, message = code) { super(message) } }
const hash = (value: string | Buffer) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const inside = (base: string, file: string) => { const rel = relative(base, file); return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) }
const ignored = new Set(['.git','node_modules','.venv','venv','__pycache__','.cache','.context','.bloma-build','dist','build'])
const indexed = (name: string) => /\.py$/i.test(name) || /^(?:pyproject\.toml|setup\.cfg|\.python-version|requirements(?:[-.][\w-]+)?\.txt)$/.test(name)
interface Image { root: string; files: Map<string, Buffer>; directories: string[]; signature: string; bytes: number }
async function image(root: string, check: () => void): Promise<Image> {
  const base = await realpath(root), files = new Map<string, Buffer>(), directories: string[] = []; let bytes = 0
  const visit = async (directory: string, prefix = '', depth = 0): Promise<void> => {
    check(); if (depth > 40 || directories.length > 2048) throw new PythonFailure('PYTHON_SCAN_LIMIT')
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a,b)=>a.name.localeCompare(b.name))
    if (entries.length > 10000) throw new PythonFailure('PYTHON_SCAN_LIMIT')
    directories.push(`${prefix}:${JSON.stringify(entries.filter(e=>!ignored.has(e.name)).map(e=>[e.name,e.isDirectory()?'d':e.isSymbolicLink()?'l':'f']))}`)
    for (const entry of entries) {
      check(); if (ignored.has(entry.name)) continue
      const path = join(directory, entry.name), label = prefix + entry.name
      if (entry.isSymbolicLink()) throw new PythonFailure('PYTHON_LINK_UNSUPPORTED', 'Project links are not followed by the bounded Python snapshot')
      const actual = await realpath(path); if (!inside(base, actual)) throw new PythonFailure('PYTHON_PATH_OUTSIDE_PROJECT')
      if (entry.isDirectory()) { await visit(path, `${label}/`, depth+1); continue }
      if (!entry.isFile() || !indexed(entry.name)) continue
      if (files.size >= 256) throw new PythonFailure('PYTHON_FILE_LIMIT')
      const handle = await open(path, 'r')
      try {
        const before = await handle.stat(); if (before.size > 1024*1024) throw new PythonFailure('PYTHON_FILE_BYTE_LIMIT')
        const chunks: Buffer[] = []; let size = 0
        for (;;) { check(); const chunk=Buffer.allocUnsafe(Math.min(65536,1024*1024+1-size)), result=await handle.read(chunk,0,chunk.length,null); if(!result.bytesRead)break; size+=result.bytesRead; if(size>1024*1024)throw new PythonFailure('PYTHON_FILE_BYTE_LIMIT'); chunks.push(chunk.subarray(0,result.bytesRead)) }
        const after=await handle.stat(), current=await stat(path)
        if (['dev','ino','size','mtimeMs','ctimeMs'].some(k=>before[k as keyof typeof before]!==after[k as keyof typeof after] || after[k as keyof typeof after]!==current[k as keyof typeof current]) || await realpath(path)!==actual) throw new PythonFailure('STALE_INDEX_VERSION')
        const value=Buffer.concat(chunks), text=new TextDecoder('utf-8',{fatal:true}).decode(value)
        if(label.toLowerCase().endsWith('.py')){const encoding=text.split(/\r?\n/,2).map(line=>/^[ \t\f]*#.*?coding[:=]\s*([-\w.]+)/.exec(line)?.[1]).find(Boolean)?.toLowerCase().replaceAll('_','-');if(encoding&&!['utf-8','utf8','utf-8-sig'].includes(encoding))throw new PythonFailure('PYTHON_ENCODING_UNSUPPORTED','Only UTF-8 Python source declarations are supported')}
        bytes+=value.length; if(bytes>8*1024*1024)throw new PythonFailure('PYTHON_TOTAL_BYTE_LIMIT')
        files.set(label,value)
      } finally { await handle.close() }
    }
  }
  await visit(base)
  return { root: base, files, directories, bytes, signature: hash(JSON.stringify({root:base, directories, files:[...files].map(([p,b])=>[p,hash(b)])})) }
}
function configuration() {
  // Host-only opt-in. Neither path is a model tool parameter; never search a
  // project's executable/site/.venv or process user .pth files.
  const executable=process.env.BLOMA_PYTHON_SEMANTICS_EXECUTABLE, site=process.env.BLOMA_PYTHON_SEMANTICS_SITE
  if(!executable || !site || !isAbsolute(executable) || !isAbsolute(site))throw new PythonFailure('PYTHON_BACKEND_UNAVAILABLE','Host must explicitly provision absolute Python/Jedi site paths; no packages are auto-installed')
  return { executable, site }
}
async function bridge(config: {executable:string;site:string}, workspace: string, payload: object, signal: AbortSignal, timeout: number): Promise<Record<string, any>> {
  const script=join(mainRootDir(),'templates/tools/python-code-service.py')
  await stat(script); let executable: string, site: string
  try { executable=await realpath(config.executable); site=await realpath(config.site) } catch { throw new PythonFailure('PYTHON_BACKEND_UNAVAILABLE','Configured host Python/site paths are unavailable') }
  return new Promise((resolveResult,reject)=>{
    let error: Error | undefined, output='', size=0, closed=false, stopping: Promise<void> | undefined
    const child=spawn(executable,['-I','-B','-S',script],{cwd:workspace,env:process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{},windowsHide:true,stdio:['pipe','pipe','pipe']})
    const stop=(failure: Error)=>{ if(!error)error=failure; if(stopping)return
      stopping=process.platform==='win32'&&child.pid&&child.exitCode===null&&child.signalCode===null
        ? new Promise<void>(done=>execFile(join(process.env.SystemRoot??'C:/Windows','System32/taskkill.exe'),['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},()=>{if(!closed)child.kill();done()}))
        : Promise.resolve().then(()=>{if(!closed)child.kill()})
    }
    const abort=()=>stop(new PythonFailure('CANCELLED'))
    const timer=setTimeout(()=>stop(new PythonFailure('DEADLINE_EXCEEDED')),timeout)
    signal.addEventListener('abort',abort,{once:true})
    child.once('error',failure=>{error=new PythonFailure('PYTHON_BACKEND_START_FAILED',failure.message)})
    child.stdin.on('error',()=>{ if(!closed)stop(new PythonFailure('PYTHON_BACKEND_PROTOCOL_ERROR')) })
    child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{size+=Buffer.byteLength(chunk);if(size>65536)stop(new PythonFailure('OUTPUT_BYTE_LIMIT'));else output+=chunk})
    // Consume but never return arbitrary interpreter tracebacks/host secrets.
    child.stderr.on('data',()=>{})
    child.once('close',async code=>{closed=true;clearTimeout(timer);signal.removeEventListener('abort',abort)
      await stopping
      if(error)return reject(error)
      if(code!==0)return reject(new PythonFailure('PYTHON_BACKEND_START_FAILED','Pinned backend or fixed adapter could not initialize; no lexical fallback'))
      try { const result=JSON.parse(output); if(!result || typeof result.ok!=='boolean' || result.backend!=='jedi')throw Error();resolveResult(result) } catch {reject(new PythonFailure('PYTHON_BACKEND_PROTOCOL_ERROR'))}
    })
    if(signal.aborted)abort(); else child.stdin.end(JSON.stringify({...payload,site}))
  })
}
export async function pythonCodeServiceCapabilities(signal?: AbortSignal) {
  const home=join(getPromaHome(),'software-code-service');let workspace: string | undefined
  try { const config=configuration();await mkdir(home,{recursive:true});workspace=await mkdtemp(join(home,'probe-'))
    const result=await bridge(config,workspace,{probe:true},signal??new AbortController().signal,5000)
    if(!result.ok)throw new PythonFailure('PYTHON_BACKEND_UNAVAILABLE')
    return {available:true,backend:'jedi',protocol:'fixed-one-request-stdio-not-LSP',jediVersion:result.jediVersion,parsoVersion:result.parsoVersion,pythonVersion:result.pythonVersion,extensions:['.py'],diagnostics:'syntax-only',external_dependencies:false,reference_write_access:'unknown',hard_heap_limit:false}
  } catch(error) {return {available:false,backend:'unavailable',reason:error instanceof PythonFailure?error.code:'PYTHON_BACKEND_UNAVAILABLE'}}
  finally {if(workspace)await rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:50})}
}
export async function executePythonCodeService(root: string, request: CodeServiceRequest, options: {signal?:AbortSignal;timeoutMs?:number}={}): Promise<PythonCodeServiceResult> {
  const started=performance.now(), timeout=options.timeoutMs??15000, controller=new AbortController(), abort=()=>controller.abort();let workspace:string|undefined, timer:ReturnType<typeof setTimeout>|undefined
  const check=()=>{if(options.signal?.aborted)throw new PythonFailure('CANCELLED');if(controller.signal.aborted || performance.now()-started>=timeout)throw new PythonFailure('DEADLINE_EXCEEDED')}
  try {
    if(!Number.isInteger(timeout)||timeout<1||timeout>30000)throw new PythonFailure('INVALID_OPTIONS')
    check();const config=configuration()
    if(!request||!['definition','references','diagnostics','symbol'].includes(request.kind)||typeof request.path!=='string'||!request.path.toLowerCase().endsWith('.py')||request.path.length>2048 || (request.limit!==undefined&&(!Number.isInteger(request.limit)||request.limit<1||request.limit>200)) || (request.query!==undefined&&(typeof request.query!=='string'||request.query.length>120)) || [request.expectedFileVersion,request.expectedIndexVersion].some(v=>v!==undefined&&!/^sha256:[a-f0-9]{64}$/.test(v)))throw new PythonFailure('INVALID_REQUEST')
    if(['definition','references'].includes(request.kind)&&(!Number.isInteger(request.line)||!Number.isInteger(request.column)||request.line!<1||request.column!<1))throw new PythonFailure('INVALID_POSITION')
    options.signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>controller.abort(),timeout)
    const base=await realpath(root),target=await realpath(resolve(base,request.path))
    if(!inside(base,target))throw new PythonFailure('PYTHON_PATH_OUTSIDE_PROJECT')
    const path=relative(base,target).split(sep).join('/'),view=await image(root,check),file=view.files.get(path)
    if(!file)throw new PythonFailure('PYTHON_FILE_NOT_INDEXED')
    const fileVersion=hash(file);if(request.expectedFileVersion&&request.expectedFileVersion!==fileVersion)throw new PythonFailure('STALE_FILE_VERSION')
    const home=join(getPromaHome(),'software-code-service');await mkdir(home,{recursive:true});workspace=await mkdtemp(join(home,'python-'))
    for(const [label,bytes] of view.files){check();const dest=join(workspace,'source',label);await mkdir(resolve(dest,'..'),{recursive:true});await writeFile(dest,bytes,{flag:'wx'})}
    const result=await bridge(config,workspace,{query:{...request,path},files:[...view.files.keys()]},controller.signal,Math.max(1,timeout-(performance.now()-started)))
    check();if(!result.ok)throw new PythonFailure(result.error?.code??'PYTHON_BACKEND_QUERY_FAILED')
    if(!Array.isArray(result.items)||result.items.length>200||typeof result.truncated!=='boolean'||result.jediVersion!=='0.19.2'||result.parsoVersion!=='0.8.4')throw new PythonFailure('PYTHON_BACKEND_PROTOCOL_ERROR')
    for(const item of result.items){if(!['definition','reference','diagnostic','symbol'].includes(item.kind))throw new PythonFailure('PYTHON_BACKEND_PROTOCOL_ERROR');if(item.location){const loc=item.location,bytes=view.files.get(loc.path);if(!bytes||loc.version!==hash(bytes)||!['start','end'].every(k=>Number.isInteger(loc[k]?.line)&&loc[k].line>0&&Number.isInteger(loc[k]?.column)&&loc[k].column>0))throw new PythonFailure('PYTHON_BACKEND_PROTOCOL_ERROR')}}
    const analyzed=await image(join(workspace,'source'),check)
    if(analyzed.files.size!==view.files.size || [...view.files].some(([p,b])=>!analyzed.files.get(p)?.equals(b)))throw new PythonFailure('PYTHON_SNAPSHOT_CHANGED')
    const fresh=await image(root,check);if(view.signature!==fresh.signature)throw new PythonFailure('STALE_INDEX_VERSION')
    const indexVersion=hash(JSON.stringify({snapshot:view.signature,jedi:result.jediVersion,parso:result.parsoVersion,python:result.pythonVersion,site:await realpath(config.site),executable:await realpath(config.executable),adapter:hash(await readFile(join(mainRootDir(),'templates/tools/python-code-service.py')))}))
    if(request.expectedIndexVersion&&request.expectedIndexVersion!==indexVersion)throw new PythonFailure('STALE_INDEX_VERSION')
    const answer: PythonCodeServiceSuccess = {ok:true,backend:'jedi',language:'python',jediVersion:result.jediVersion,parsoVersion:result.parsoVersion,pythonVersion:result.pythonVersion,kind:request.kind,path,fileVersion,indexVersion,
      config:{mode:'bounded-snapshot',files:[...view.files.keys()].filter(p=>!p.endsWith('.py')),filesTruncated:false},items:result.items,truncated:result.truncated,boundary:result.boundary,observed:{files:view.files.size,bytes:view.bytes,projectFiles:[...view.files.keys()].filter(p=>p.endsWith('.py')).length},timings:{totalMs:performance.now()-started,backendImportMs:Number(result.timings?.backendImportMs),queryMs:Number(result.timings?.queryMs)},cache:'fresh-jedi-snapshot',limitations:[
        'Real pinned Jedi static analysis through a fixed stdio adapter, not LSP, type checking, formal verification or business PASS. Diagnostics are syntax only; reference read/write access is unknown.',
        'Only a fresh bounded UTF-8 .py/config copy is indexed. No site/project execution, project interpreter/venv, extensions, external dependencies, plugins, .pth, networking or environment discovery. Missing imports reduce semantic scope.',
        'Host-owned process is terminated/awaited on cancellation/deadline. Python audit guards are defense-in-depth, not an OS sandbox or a hard heap limit.',
        'Snapshot and final byte/directory validation are not an atomic filesystem transaction. Index identity covers the copied project/config, adapter bytes and declared backend identity, not all trusted interpreter/stdlib/package bytes.'
      ]}
    while(Buffer.byteLength(JSON.stringify(answer))>65536 && answer.items.length){answer.items.pop();answer.truncated=true}
    while(Buffer.byteLength(JSON.stringify(answer))>65536 && answer.config.files.length){answer.config.files.pop();answer.config.filesTruncated=true}
    if(Buffer.byteLength(JSON.stringify(answer))>65536)throw new PythonFailure('OUTPUT_BYTE_LIMIT')
    return answer
  } catch(error){const code=options.signal?.aborted?'CANCELLED':controller.signal.aborted||performance.now()-started>=timeout?'DEADLINE_EXCEEDED':error instanceof PythonFailure?error.code:'PYTHON_SNAPSHOT_FAILED';return {ok:false,backend:code==='PYTHON_BACKEND_UNAVAILABLE'?'unavailable':'jedi',error:{code,message:error instanceof PythonFailure?error.message.slice(0,800):'Python snapshot/backend unavailable; no partial or cached result returned'}}}
  finally {clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(workspace)await rm(workspace,{recursive:true,force:true,maxRetries:5,retryDelay:50})}
}
