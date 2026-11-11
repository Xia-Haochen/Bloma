import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mainRootDir } from '../platform/paths'
import { execFileDriverSpawn, buildDriverEnv } from '../desktop/process-driver'
import { redactSoftwareOutput } from './process-manager'

export const NATIVE_UI_CAPABILITIES = {
  backend: 'Windows UIAutomation via fixed owned-process adapter', supported: process.platform === 'win32',
  availability: 'Live ownership, system assemblies and provider access are checked on use; no desktop-wide permission claim',
  native_screenshot: 'PrintWindow of selected owned HWND; may be unavailable/incomplete for GPU surfaces; no desktop fallback',
  actions: ['invoke','fill','toggle','select','expand','collapse'], physical_input: false,
  ownership: 'live debug child process tree + process start time; HWND + RuntimeId + observed-view fingerprint',
  input_lease: 'single native action per host plus same-session Windows named mutex; not an OS-wide lock against other applications',
  limits: { windows:16, nodes:1000, depth:24, returned:80, timeout_ms:15000, output_bytes:262144 },
  gaps: ['not a complete desktop AX tree','provider hangs fail at deadline','no foreground keyboard/mouse or automatic first-name match',
    'virtualized/unexposed controls and omitted nodes are not observed','not an atomic UI or OS sandbox guarantee'],
} as const
export interface NativeQuery { role?:string; name?:string; automation_id?:string; query?:string; limit?:number }
export interface NativeControl { ref:string; kind:'invoke'|'fill'|'toggle'|'select'|'expand'|'collapse'; value?:string }
export interface NativeRequest { window_ref?:string; query?:NativeQuery; control?:NativeControl }
interface NativeWindow { Handle:string; Started:string; Name:string; Pid:number; Dpi:number; Enabled:boolean; Minimized:boolean; Modal:boolean; Bounds:number[] }
interface NativeRow { Runtime:string; Name:string; Role:string; AutomationId:string; Value:string|null; Depth:number; Enabled:boolean; Offscreen:boolean; Password:boolean; TextTruncated:boolean; State:string; Bounds:number[]; Patterns:string[] }
interface NativeView { Windows:NativeWindow[]; Selected:string|null; Fingerprint:string|null; Nodes:NativeRow[]; Truncated:boolean }
interface Reply { ok:boolean; root_started:string; view:NativeView; method?:string; error?:string; capture_error?:string; screenshot?:string }
let activeNativeAction = false
const kinds = new Set(NATIVE_UI_CAPABILITIES.actions)
export function validateNativeRequest(request:NativeRequest) {
  if(!request || typeof request!=='object' || Array.isArray(request) || Object.keys(request).some(k=>!['window_ref','query','control'].includes(k)))throw Error('NATIVE_REQUEST_INVALID')
  if(request.window_ref!==undefined && (typeof request.window_ref!=='string'||request.window_ref.length>160))throw Error('NATIVE_WINDOW_REF_INVALID')
  if(request.query!==undefined){const q=request.query;if(!q||typeof q!=='object'||Array.isArray(q)||Object.keys(q).some(k=>!['role','name','automation_id','query','limit'].includes(k)))throw Error('NATIVE_QUERY_INVALID')
    for(const key of ['role','name','automation_id','query'] as const)if(q[key]!==undefined&&(typeof q[key]!=='string'||q[key]!.length>512))throw Error('NATIVE_QUERY_INVALID')
    if(q.limit!==undefined&&(!Number.isInteger(q.limit)||q.limit<1||q.limit>80))throw Error('NATIVE_QUERY_INVALID')
  }
  if(request.control!==undefined){const c=request.control;if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).some(k=>!['kind','ref','value'].includes(k))||typeof c.ref!=='string'||c.ref.length>160||!kinds.has(c.kind))throw Error('NATIVE_CONTROL_INVALID')
    if(c.kind==='fill'?(typeof c.value!=='string'||c.value.length>4096):c.value!==undefined)throw Error('NATIVE_CONTROL_INVALID')
    if(request.window_ref!==undefined)throw Error('NATIVE_CONTROL_WINDOW_MIXED')
  }
}
/** Internal host capability only. A model cannot provide the PID, a process
 * start time, native HWND, RuntimeId, script or arbitrary adapter command. */
export class OwnedNativeUi {
  private started?:string
  private observation?: { id:string; view:NativeView; offered:Set<number> }
  private closed=false
  private busy=false
  private inFlight?:Promise<unknown>
  private readonly cancellation=new AbortController()
  constructor(private readonly rootPid:number, private readonly isLive:()=>boolean,private readonly evidenceDirectory?:string){
    if(!Number.isSafeInteger(rootPid)||rootPid<=0)throw Error('NATIVE_OWNER_INVALID')
  }
  invalidate(){this.observation=undefined}
  async close(){this.closed=true;this.invalidate();this.cancellation.abort();await this.inFlight?.catch(()=>{})}
  private assertLive(){if(this.closed||!this.isLive())throw Error('NATIVE_OWNER_NOT_LIVE')}
  private async invoke(request:Record<string,unknown>,signal:AbortSignal):Promise<Reply>{
    signal=AbortSignal.any([signal,this.cancellation.signal])
    this.assertLive();signal.throwIfAborted()
    if(process.platform!=='win32')throw Error('NATIVE_PLATFORM_UNSUPPORTED')
    const temporary=mkdtempSync(join(tmpdir(),'bloma-owned-uia-')),file=join(temporary,'request.json')
    try{
      writeFileSync(file,JSON.stringify({...request,root_pid:this.rootPid,root_started:this.started,...(this.evidenceDirectory&&request.kind==='observe'?{capture_path:join(temporary,'native.png')}:{})}),{flag:'wx'})
      const result=await execFileDriverSpawn({command:[join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),'-NoProfile','-NonInteractive','-File',join(mainRootDir(),'templates/tools/owned_native_ui.ps1'),'-RequestPath',file],cwd:temporary,
        env:{...buildDriverEnv({env_whitelist:[]} as never,process.env),TEMP:temporary,TMP:temporary},signal,timeoutMs:15000})
      this.assertLive();signal.throwIfAborted()
      const reply=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)??'{}') as Reply
      if(result.code!==0||reply.ok!==true)throw Error(/^NATIVE_[A-Z_]+$/.test(reply.error??'')?reply.error:'NATIVE_ADAPTER_ERROR')
      if(!/^\d+$/.test(reply.root_started)||!reply.view||!Array.isArray(reply.view.Windows)||reply.view.Windows.length>16||!Array.isArray(reply.view.Nodes)||reply.view.Nodes.length>1000)throw Error('NATIVE_PROTOCOL_INVALID')
      if(this.started&&this.started!==reply.root_started)throw Error('NATIVE_PROCESS_IDENTITY_CHANGED')
      if(reply.view.Selected&&!/^[a-f0-9]{64}$/.test(reply.view.Fingerprint??''))throw Error('NATIVE_PROTOCOL_INVALID')
      if(this.evidenceDirectory&&request.kind==='observe'&&existsSync(join(temporary,'native.png'))){
        const bytes=readFileSync(join(temporary,'native.png'))
        if(bytes.length<24||bytes.length>20*1024*1024||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.readUInt32BE(16)>3840||bytes.readUInt32BE(20)>2160)throw Error('NATIVE_SCREENSHOT_INVALID')
        mkdirSync(this.evidenceDirectory,{recursive:true});reply.screenshot=join(this.evidenceDirectory,`native-${randomUUID()}.png`);writeFileSync(reply.screenshot,bytes,{flag:'wx'})
      }
      this.started=reply.root_started;return reply
    }finally{rmSync(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
  }
  async inspect(request:NativeRequest,signal:AbortSignal){
    validateNativeRequest(request);this.assertLive();signal.throwIfAborted()
    if(this.busy)throw Error('NATIVE_SESSION_BUSY')
    this.busy=true
    try{const pending=this.inspectUnlocked(request,signal);this.inFlight=pending;return await pending}finally{this.busy=false;this.inFlight=undefined}
  }
  private async inspectUnlocked(request:NativeRequest,signal:AbortSignal){
    const previous=this.observation
    let window:string|undefined
    if(request.window_ref){const index=previous?.view.Windows.findIndex((_,i)=>request.window_ref===`${previous.id}:w:${i}`)??-1;if(index<0)throw Error('NATIVE_WINDOW_REFERENCE_STALE');window=previous!.view.Windows[index]!.Handle}
    let method:string|undefined
    this.invalidate()
    if(request.control){
      if(activeNativeAction)throw Error('NATIVE_INPUT_BUSY')
      const index=previous?.view.Nodes.findIndex((_,i)=>request.control!.ref===`${previous.id}:e:${i}`)??-1
      if(index<0||!previous?.view.Selected||!previous.offered.has(index))throw Error('NATIVE_REFERENCE_STALE')
      activeNativeAction=true
      try{
        const reply=await this.invoke({kind:'act',window:previous.view.Selected,expected:previous.view.Fingerprint,runtime:previous.view.Nodes[index]!.Runtime,control:{kind:request.control.kind,...(request.control.kind==='fill'?{value:request.control.value}:{})}},signal)
        method=reply.method;window=previous.view.Selected
      }catch(error){
        // UIA can dispatch input before the client dies. Never retry an unknown
        // mutation, nor treat an adapter timeout as proof that no input occurred.
        if(signal.aborted||this.cancellation.signal.aborted||/timeout|timed out|deadline|cancelled|aborted/i.test(String(error)))throw Error('NATIVE_CONTROL_CANCELLED_OUTCOME_UNKNOWN')
        if(/NATIVE_(?:REFERENCE_STALE|PROCESS_IDENTITY_CHANGED|WINDOW_NOT_OWNED|WINDOW_BLOCKED|MODAL_REQUIRES_SELECTION|CONTROL_DISABLED_OR_STALE|VALUE_READONLY|PATTERN_UNSUPPORTED|INPUT_BUSY)\b/.test(String(error)))throw error
        throw Error(`NATIVE_CONTROL_OUTCOME_UNKNOWN: do not replay; ${String(error)}`)
      }finally{activeNativeAction=false}
    }
    let reply:Reply
    try{reply=await this.invoke({kind:'observe',window},signal)}catch(error){
      // Closing a modal can legitimately remove its HWND. Only re-observe the
      // remaining owned windows; never repeat the successful mutation.
      if(method&&String(error).includes('NATIVE_WINDOW_NOT_OWNED'))reply=await this.invoke({kind:'observe'},signal)
      else {if(method)throw Error(`NATIVE_ACTION_DISPATCHED_OBSERVATION_FAILED: ${method}; do not replay; ${String(error)}`);throw error}
    }
    const view=reply.view,id=randomUUID(),offered=new Set<number>();this.observation={id,view,offered}
    const q=request.query??{},limit=q.limit??40
    const matching=view.Nodes.map((node,i)=>({node,i})).filter(({node})=>(!q.role||node.Role.toLowerCase()===q.role.toLowerCase())&&(!q.name||node.Name===q.name)&&(!q.automation_id||node.AutomationId===q.automation_id)&&(!q.query||`${node.Name} ${node.Role} ${node.AutomationId}`.toLowerCase().includes(q.query.toLowerCase())))
    let size=0,omitted=matching.length>limit
    const nodes:Array<Record<string,unknown>>=[]
    for(const {node,i} of matching.slice(0,limit)){
      const row={ref:`${id}:e:${i}`,role:node.Role,name:redactSoftwareOutput(node.Name).slice(0,1000),automation_id:redactSoftwareOutput(node.AutomationId).slice(0,512),value:node.Password?'[password not read]':node.Value===null?undefined:redactSoftwareOutput(node.Value).slice(0,2000),enabled:node.Enabled,offscreen:node.Offscreen,state:node.State,text_truncated:node.TextTruncated,depth:node.Depth,bounds:node.Bounds,patterns:node.Patterns}
      const bytes=Buffer.byteLength(JSON.stringify(row));if(size+bytes>32000){omitted=true;break}size+=bytes;nodes.push(row);offered.add(i)
    }
    return {snapshot_id:id,backend:'Windows.UIAutomation',windows:view.Windows.map((w,i)=>({ref:`${id}:w:${i}`,name:redactSoftwareOutput(w.Name).slice(0,1000),text_truncated:w.Name.length>1000,dpi:w.Dpi,bounds:w.Bounds,enabled:w.Enabled,minimized:w.Minimized,modal:w.Modal})),
      selected: view.Selected?`${id}:w:${view.Windows.findIndex(w=>w.Handle===view.Selected)}`:undefined,needs_window_selection:!view.Selected&&view.Windows.length>1,nodes,
      screenshot:reply.screenshot,screenshot_error:reply.capture_error,visual_review:'not_reviewed_by_model',screenshot_binding:'selected owned HWND at capture time; image pixels are not UIA screen coordinates; not atomic with UIA tree; never desktop fallback',
      truncated:view.Truncated||omitted||nodes.some(n=>n.text_truncated)||view.Windows.some(w=>w.Name.length>1000),matching:matching.length,method,verification:'not_applicable',gaps:NATIVE_UI_CAPABILITIES.gaps}
  }
}
