import {ENGINEERING_PARTNER_WORKFLOW} from './engineering-partner-guidance'
import {buildSoftwareEnvironmentTool} from './environment-tool'
import { buildQualityFindingsTool } from './quality-findings-tool'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync, readdirSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { runWithProjectRootOverride } from '../../shared/project-root-override'
import { buildAgentTools } from '../agent/tools/agent-tools'
import type { ToolContext } from '../agent/loop/agent-loop'
import type { DelegateAgentArgs } from '../agent/delegation/agent-collaboration'
import { repositoryFiles } from './repository-context'
import { softwareWorkingContext } from './working-context'
import { buildProductionContextTool } from '../desktop/production-context'
import { readPrdBackplane } from '../project/prd-store'
import { prdScopeFingerprint } from '../project/requirement-contract'
import { executeSoftwareCommand } from './command-runtime'
import { redactSoftwareOutput } from './process-manager'
import { activeDebugSessionId, readDebugSession } from './debug-sessions'
import { buildSoftwareImageTool } from './image-tool'

const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex')
const excluded=(path:string)=>path.startsWith('.bloma/skills/')||path.split('/').some(p=>['data','.data','data-backups','.git','node_modules','.venv','venv'].includes(p)||/^\.env(?:\.|$)/i.test(p))||/\.(pem|key|p12)$/i.test(path)
export function engineeringObservations(projectId:string,parent:string) {
  try {
    const id=activeDebugSessionId(projectId,parent)
    if(!id)return{available:false}
    const state=readDebugSession(projectId,parent,id)
    return{available:true,source:state.source,version:state.version,stale:state.stale,
      observations:state.observations.slice(-6).map(row=>({kind:row.kind,message:redactSoftwareOutput(row.message).slice(0,4000),truncated:row.message.length>4000})),
      image_included:false,authority:'执行观察，不是制作方结论或产品PASS；截图未附入此文字材料。'}
  }catch(error){return{available:false,error:redactSoftwareOutput(String(error))}}
}
export const engineeringObservationVersion=(projectId:string,parent:string)=>hash(Buffer.from(JSON.stringify(engineeringObservations(projectId,parent))))
interface View { root:string; snapshot:string; files:Array<{path:string;sha256:string}>; active:boolean; target:string; contextHash:string; executions:Array<Record<string,unknown>>; executionCount:number; factProvider?:()=>unknown }
export function engineeringSourceVersion(root:string) {
  const files=repositoryFiles(root).filter(path=>!excluded(path))
  if(files.length>2048||files.reduce((bytes,path)=>bytes+statSync(join(root,path)).size,0)>32*1024*1024)throw Error('ENGINEERING_WORKSPACE_SOURCE_LIMIT')
  return hash(Buffer.from(JSON.stringify(files.map(path=>[path,hash(readFileSync(join(root,path)))]))))
}

/** Independent engineering notes + immutable source views. No product writes,
 * release votes or private producer conversation are provided to this role. */
export function createEngineeringWorkspaces(projectId:string,productRoot:string,parent:string) {
  const views=new Map<string,View>()
  const get=(child:string)=>{const view=views.get(child);if(!view?.active)throw Error('ENGINEERING_WORKSPACE_INACTIVE');return view}
  const changed=(view:View)=>{const current=repositoryFiles(productRoot).filter(path=>!excluded(path));return current.length!==view.files.length||view.files.some((file,index)=>{try{return current[index]!==file.path||hash(readFileSync(join(productRoot,file.path)))!==file.sha256}catch{return true}})}
  const prepare=(child:string,args:DelegateAgentArgs)=>{
    if(!args.independentWorkspace||args.experiment||args.writePaths?.length||!['research','explore'].includes(args.role??''))throw Error('ENGINEERING_WORKSPACE_ROLE_INVALID')
    if(![projectId,parent,child].every(id=>/^[\w-]+$/.test(id)))throw Error('ENGINEERING_WORKSPACE_ID_INVALID')
    const root=join(getPromaHome(),'software-engineering-workspaces',projectId,hash(Buffer.from(parent+'\0'+child)).slice(0,24))
    const files=repositoryFiles(productRoot).filter(path=>!excluded(path))
    if(files.length>2048)throw Error('ENGINEERING_WORKSPACE_SOURCE_LIMIT: 使用限定输入的独立实验核对局部问题。')
    const snapshot='sources/'+randomUUID(), manifest:View['files']=[];let bytes=0
    mkdirSync(join(root,snapshot),{recursive:true})
    for(const path of files){
      const source=join(productRoot,path);bytes+=statSync(source).size
      if(bytes>32*1024*1024)throw Error('ENGINEERING_WORKSPACE_SOURCE_LIMIT: 使用限定输入的独立实验核对局部问题。')
      const target=join(root,snapshot,path);mkdirSync(dirname(target),{recursive:true});copyFileSync(source,target)
      manifest.push({path,sha256:hash(readFileSync(target))})
    }
    mkdirSync(root,{recursive:true})
    const brief=readPrdBackplane(projectId),view:View={root,snapshot,files:manifest,active:true,target:prdScopeFingerprint(brief),contextHash:'',executions:[] as Array<Record<string,unknown>>,executionCount:0}
    if(changed(view))throw Error('ENGINEERING_WORKSPACE_SOURCE_CHANGED')
    const context=JSON.stringify({projectId,parent,child,at:new Date().toISOString(),snapshot,
      goal:brief.positioning,facts:softwareWorkingContext(projectId),development_observations:engineeringObservations(projectId,parent),
      quality_findings:{tool:'read_quality_findings',note:'读取当前问题原文与证据；编号和历史失败摘要不足以推断具体错因。'},
      host_responsibilities:'宿主维护副本完整性、版本、预算准入和执行回执；它们不是重复调查的待办。',
      requirements:brief.requirements,acceptance:brief.acceptance,constraints:brief.constraints,
      source_statements:brief.lean_brief?.intent_sources??brief.requirements_model?.sources,out_of_scope:brief.out_of_scope,assumptions:brief.assumptions,
      files:manifest,
      coverage:'代码和配置副本；排除依赖、约定业务数据目录和常见凭据文件；不包含全部视觉素材。未复制材料不能宣称已审阅。'},null,2)
    writeFileSync(join(root,snapshot+'.context.json'),context,{flag:'wx'})
    writeFileSync(join(root,'context.json'),context)
    view.contextHash=hash(Buffer.from(context))
    views.set(child,view)
    view.factProvider=()=>({engineering_workspace:root,snapshot,input_record:snapshot+'.context.json',input_intact:intact(view),source_changed:changed(view),target_changed:view.target!==prdScopeFingerprint(readPrdBackplane(projectId)),
      run_scope:'current_consultation',run_count:view.executionCount,recent_runs:view.executions,
      authority:'独立工程意见，不是交付凭据；负责人判断和整合，版本变化后需核对适用性。'})
    return{release:()=>{view.active=false},completionNote:()=>`\n独立工程材料：${root}；输入记录：${snapshot}.context.json（非交付通过）。`,facts:view.factProvider}
  }
  const intact=(view:View)=>{
    const expected=new Set(view.files.map(file=>file.path)),directories=new Set<string>()
    for(const file of expected){const parts=file.split('/');parts.pop();while(parts.length){directories.add(parts.join('/'));parts.pop()}}
    const exactTree=(dir:string,prefix=''):boolean=>readdirSync(dir,{withFileTypes:true}).every(entry=>{
      const path=prefix+entry.name
      return entry.isDirectory()?directories.has(path)&&exactTree(join(dir,entry.name),path+'/'):entry.isFile()&&expected.has(path)
    })
    try{return (!view.active||hash(readFileSync(join(view.root,'context.json')))===view.contextHash)
      &&hash(readFileSync(join(view.root,view.snapshot+'.context.json')))===view.contextHash
      &&exactTree(join(view.root,view.snapshot))
      &&view.files.every(file=>hash(readFileSync(join(view.root,view.snapshot,file.path)))===file.sha256)}catch{return false}
  }
  const tools=(child:string)=>{
    const view=get(child)
    const check=(ctx:ToolContext)=>{ctx.signal.throwIfAborted();if(ctx.projectId!==projectId||ctx.sessionId!==child||get(child)!==view)throw Error('ENGINEERING_WORKSPACE_OWNER_MISMATCH');if(!intact(view))throw Error('ENGINEERING_INPUT_CHANGED: 输入副本被改变，需要负责人刷新咨询，不能据此报告原版本结论。')}
    const files=buildAgentTools({projectId,role:'implement',realFullstackVariant:true,software:true,assertFileWrite:(path,ctx)=>{
      check(ctx);const p=relative(view.root,resolve(view.root,path)).replaceAll('\\','/').toLowerCase()
      if(p==='context.json'||p==='sources'||p.startsWith('sources/')||p==='runs'||p.startsWith('runs/'))throw Error('ENGINEERING_SNAPSHOT_READ_ONLY')
    }}).filter(t=>['read_file','write_file','edit_file','list_files','find','grep','web_fetch'].includes(t.name))
      .map(t=>({...t,execute:async(input:Record<string,unknown>,ctx:ToolContext)=>{check(ctx);return runWithProjectRootOverride(view.root,()=>t.execute(input,ctx))}}))
    const environment=buildSoftwareEnvironmentTool(projectId)
    const image=buildSoftwareImageTool(projectId)
    return [...files,buildProductionContextTool(projectId),buildQualityFindingsTool(projectId,check),{...environment,execute:async(input:Record<string,unknown>,ctx:ToolContext)=>{check(ctx);return environment.execute(input,ctx)}},{...image,execute:async(input:Record<string,unknown>,ctx:ToolContext)=>{check(ctx);return runWithProjectRootOverride(view.root,()=>image.execute(input,ctx))}},{
      name:'run_command',description:'在自己的工程研究工作区运行探针，数据使用独立目录；记录实际结果，不签发产品PASS。不要在sources副本或产品中做实验修改，先在本工作区创建探针副本。不是OS沙箱。',
      input_schema:{type:'object',additionalProperties:false,required:['command'],properties:{command:{type:'array',items:{type:'string'}},cwd:{type:'string'},timeout_ms:{type:'integer',minimum:100,maximum:60000}}},
      execute:async(input:Record<string,unknown>,ctx:ToolContext)=>{
        check(ctx)
        const started=new Date().toISOString(),timeout=Number(input.timeout_ms??60000)
        if(!Number.isSafeInteger(timeout)||timeout<100||timeout>60000)throw Error('ENGINEERING_COMMAND_TIMEOUT_INVALID')
        let result:Record<string,unknown>
        try{const executed=await executeSoftwareCommand({projectId,root:view.root,dataDir:join(view.root,'.data'),command:input.command,cwd:input.cwd as string|undefined,timeoutMs:timeout,signal:ctx.signal});
          result={exit_code:executed.code,code:executed.code===0?undefined:'COMMAND_EXIT_FAILED',stdout_truncated:executed.stdout.length>24000,stderr_truncated:executed.stderr.length>12000,stdout:redactSoftwareOutput(executed.stdout).slice(-24000),stderr:redactSoftwareOutput(executed.stderr).slice(-12000)}}
        catch(error){result={code:'COMMAND_EXECUTION_FAILED',error:redactSoftwareOutput(String(error))}}
        const inputIntact=intact(view)
        const record={started,cwd:input.cwd??'.',timeout_ms:timeout,command:input.command,...result,source_snapshot:view.snapshot,input_intact:inputIntact,...(!inputIntact?{code:'ENGINEERING_INPUT_CHANGED'}:{}),product_verified:false}
        const path=join(view.root,'runs',randomUUID()+'.json');mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(record))
        view.executionCount++;view.executions.push({record:path,record_sha256:hash(Buffer.from(JSON.stringify(record))),command:redactSoftwareOutput(JSON.stringify(input.command)).slice(0,500),exit_code:result.exit_code,code:record.code,input_intact:inputIntact,stdout:String(result.stdout??'').slice(-800),stdout_truncated:result.stdout_truncated||String(result.stdout??'').length>800,stderr_truncated:result.stderr_truncated||String(result.stderr??result.error??'').length>500,stderr:String(result.stderr??result.error??'').slice(-500),product_verified:false});view.executions=view.executions.slice(-3)
        return{output:JSON.stringify(record),isError:result.exit_code!==0||!inputIntact}
      },
    }]
  }
  return{prepare,tools,facts:(child:string)=>views.get(child)?.factProvider?.(),has:(child:string)=>views.has(child),root:(child:string)=>get(child).root,
    describe:(child:string)=>`${ENGINEERING_PARTNER_WORKFLOW}\n独立工作区：${get(child).root}。先读context.json；sources/为只读输入，笔记和探针放其他位置。文件工具限制在本工作区；命令不是OS沙箱，不得修改产品、输入副本或执行回执。`}
}
