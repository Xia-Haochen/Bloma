import {mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync,statSync,copyFileSync,readdirSync,unlinkSync} from 'node:fs'
import {join,resolve,relative,isAbsolute,dirname} from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {getPromaHome} from '../../storage/config-paths'
import {runWithProjectRootOverride} from '../../shared/project-root-override'
import {buildAgentTools} from '../agent/tools/agent-tools'
import type {AgentLoopTool,ToolContext} from '../agent/loop/agent-loop'
import {executeSoftwareCommand} from './command-runtime'
import {softwareVerificationFingerprint} from '../desktop/verification-fingerprint'
import {redactSoftwareOutput} from './process-manager'
import type {DelegateAgentArgs} from '../agent/delegation/agent-collaboration'

const sha=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex')
function bounded(root:string,path:string){
  if(!path||path.length>1024||isAbsolute(path)||path.split(/[\\/]/).some(p=>p==='..'))throw Error('EXPERIMENT_PATH_INVALID')
  const file=realpathSync(resolve(root,path)),rel=relative(realpathSync(root),file)
  if(isAbsolute(rel)||rel.startsWith('..')||!statSync(file).isFile()||statSync(file).size>16*1024*1024)throw Error('EXPERIMENT_PATH_INVALID')
  return file
}
export function createExperiments(projectId:string,projectRoot:string,parent:string){
  const active=new Map<string,{root:string;folder:string;cancel:AbortController;source:string|undefined;question:string;criterion:string;inputsKey:string}>()
  const base=join(getPromaHome(),'software-experiments',projectId)
  const valid=(id:string)=>{if(!/^[\w-]+$/.test(id))throw Error('EXPERIMENT_ID_INVALID');return join(base,id)}
  const info=(id:string)=>{const x=active.get(id);if(!x||x.cancel.signal.aborted)throw Error('EXPERIMENT_NOT_ACTIVE');return x}
  const authorize=(ctx:ToolContext)=>{ctx.signal.throwIfAborted();if(ctx.projectId!==projectId)throw Error('EXPERIMENT_PROJECT_MISMATCH');return info(ctx.sessionId)}
  const read=(id:string)=>{
    const folder=valid(id),meta=JSON.parse(readFileSync(join(folder,'meta.json'),'utf8'))
    if(meta.parent!==parent)throw Error('EXPERIMENT_OWNER_MISMATCH')
    const result=existsSync(join(folder,'result.json'))?JSON.parse(readFileSync(join(folder,'result.json'),'utf8')):undefined
    const runs=readdirSync(folder).filter(name=>/^run-.*\.json$/.test(name)).map(name=>{const row=JSON.parse(readFileSync(join(folder,name),'utf8'));return{file:name,...row,stdout:row.stdout?.slice(-2000),stderr:row.stderr?.slice(-1000)}})
    const unfinished=existsSync(join(folder,'unfinished.json'))?JSON.parse(readFileSync(join(folder,'unfinished.json'),'utf8')):undefined
    return{...meta,result,unfinished,runs,source_changed:meta.source!==softwareVerificationFingerprint(projectRoot),product_verified:false}
  }
  const prepare=(child:string,args:DelegateAgentArgs)=>{
    const spec=args.experiment
    if(!spec||typeof spec.criterion!=='string'||!spec.criterion.trim()||spec.criterion.length>2000||['review','research','explore'].includes(args.role??'')||args.readOnly===true||args.writePaths?.length
      ||spec.inputs!==undefined&&(!Array.isArray(spec.inputs)||spec.inputs.length>32||spec.inputs.some(p=>typeof p!=='string')))throw Error('EXPERIMENT_CONTRACT_INVALID')
    if([...active.values()].some(x=>x.question===args.task&&x.criterion===spec.criterion&&x.inputsKey===JSON.stringify(spec.inputs??[])))throw Error('EXPERIMENT_DUPLICATE_ACTIVE')
    const folder=valid(child),root=join(folder,'work');mkdirSync(root,{recursive:true})
    const metaFile=join(folder,'meta.json')
    let source=softwareVerificationFingerprint(projectRoot)
    if(existsSync(metaFile)){
      const old=read(child);if(old.criterion!==spec.criterion)throw Error('EXPERIMENT_CRITERION_CHANGED');source=old.source
    }else{
      let bytes=0
      for(const path of spec.inputs??[]){
        if(/^(?:node_modules|\.git|\.venv|data-backups)(?:[/\\]|$)/i.test(path))throw Error('EXPERIMENT_INPUT_DENIED')
        const file=bounded(projectRoot,path);bytes+=statSync(file).size;if(bytes>32*1024*1024)throw Error('EXPERIMENT_INPUT_LIMIT')
        const target=resolve(root,path);mkdirSync(dirname(target),{recursive:true});copyFileSync(file,target)
      }
      writeFileSync(metaFile,JSON.stringify({projectId,parent,session:child,source,question:args.task,criterion:spec.criterion,inputs:spec.inputs??[]}),{flag:'wx'})
    }
    active.set(child,{root,folder,cancel:new AbortController(),source,question:args.task,criterion:spec.criterion,inputsKey:JSON.stringify(spec.inputs??[])})
    const sealUnfinished=()=>{
      if(existsSync(join(folder,'result.json')))return
      const id=randomUUID(),destination=join(folder,'evidence',id);mkdirSync(destination,{recursive:true})
      const artifacts:Array<{path:string;stored:string;sha256:string;bytes:number}>=[];let bytes=0
      const visit=(dir:string,prefix='',depth=0)=>{for(const item of readdirSync(dir,{withFileTypes:true})){
        if(artifacts.length>=32||item.isSymbolicLink()||['node_modules','.venv','.git'].includes(item.name))continue
        const path=prefix+item.name,file=join(dir,item.name)
        if(item.isDirectory()){if(depth<2)visit(file,path+'/',depth+1);continue}
        if(!item.isFile()||statSync(file).size>16*1024*1024||bytes+statSync(file).size>32*1024*1024)continue
        const target=join(destination,String(artifacts.length));copyFileSync(file,target);const data=readFileSync(target);bytes+=data.length
        artifacts.push({path,stored:`evidence/${id}/${artifacts.length}`,sha256:sha(data),bytes:data.length})
      }}
      visit(root);writeFileSync(join(folder,'unfinished.json'),JSON.stringify({id,status:'unverified',reason:'child ended without a sealed interpretation',artifacts,at:new Date().toISOString()}))
    }
    return{release:()=>{active.get(child)?.cancel.abort();sealUnfinished();active.delete(child)},completionNote:()=>{sealUnfinished();const saved=read(child);return '\n实验交接（Agent解释不签发产品PASS）：'+JSON.stringify({session:child,result:saved.result,unfinished:saved.unfinished,run_count:saved.runs.length,source_changed:saved.source_changed,read_tool:'read_experiment'})}}
  }
  const tools=(child:string):AgentLoopTool[]=>{
    const x=info(child)
    const check=(ctx:ToolContext)=>{authorize(ctx);if(ctx.sessionId!==child)throw Error('EXPERIMENT_OWNER_MISMATCH')}
    const invalidate=()=>{const file=join(x.folder,'result.json');if(existsSync(file))unlinkSync(file);const unfinished=join(x.folder,'unfinished.json');if(existsSync(unfinished))unlinkSync(unfinished)}
    const files=buildAgentTools({projectId,role:'implement',realFullstackVariant:true,software:true,assertFileWrite:(_path,ctx)=>check(ctx)})
      .filter(t=>['read_file','write_file','edit_file','list_files','find','grep','web_fetch'].includes(t.name))
      .map(t=>({...t,execute:async(input:Record<string,unknown>,ctx:ToolContext)=>{check(ctx);if(['write_file','edit_file'].includes(t.name))invalidate();return runWithProjectRootOverride(x.root,()=>t.execute(input,ctx))}}))
    return [...files,{name:'run_command',description:'在独立实验目录运行实际探针，返回真实输出；不修改正式项目，不签发验收。沿用项目执行授权，不是OS沙箱。每次最多60秒，取消会停止执行。',input_schema:{type:'object',required:['command'],additionalProperties:false,properties:{command:{type:'array',items:{type:'string'}},cwd:{type:'string'},timeout_ms:{type:'integer',minimum:100,maximum:60000}}},execute:async(input,ctx)=>{
      check(ctx);invalidate();const timeout=Number(input.timeout_ms??60000);if(!Number.isInteger(timeout)||timeout<100||timeout>60000)throw Error('EXPERIMENT_TIMEOUT_INVALID')
      const started=new Date().toISOString(),sourceBefore=softwareVerificationFingerprint(x.root);let row:Record<string,unknown>
      try{const result=await executeSoftwareCommand({projectId,root:x.root,dataDir:join(x.folder,'data'),command:input.command,cwd:input.cwd as string|undefined,timeoutMs:timeout,signal:AbortSignal.any([ctx.signal,x.cancel.signal])});row={started,cwd:input.cwd??'.',timeout_ms:timeout,source_before:sourceBefore,command:input.command,exit_code:result.code,code:result.code===0?undefined:'COMMAND_EXIT_FAILED',stdout:redactSoftwareOutput(result.stdout).slice(-24000),stderr:redactSoftwareOutput(result.stderr).slice(-12000)}}
      catch(error){row={started,cwd:input.cwd??'.',timeout_ms:timeout,source_before:sourceBefore,command:input.command,code:'COMMAND_EXECUTION_FAILED',error:redactSoftwareOutput(String(error))}}
      const id=randomUUID();writeFileSync(join(x.folder,'run-'+id+'.json'),JSON.stringify(row))
      return{output:JSON.stringify({...row,evidence:id,product_verified:false}),isError:row.exit_code!==0}
    }},{name:'record_experiment_result',description:'保存方法、结论和可复查产物。supports/refutes是你的解释，宿主只认证执行事实。原始失败不删除；证据在工作目录外封存。',input_schema:{type:'object',required:['method','finding','verdict','artifacts'],additionalProperties:false,properties:{method:{type:'string'},finding:{type:'string'},verdict:{enum:['supports','refutes','unresolved']},artifacts:{type:'array',maxItems:16,items:{type:'string'}}}},execute:async(input,ctx)=>{
      check(ctx)
      if(!['supports','refutes','unresolved'].includes(String(input.verdict))||typeof input.method!=='string'||typeof input.finding!=='string'||input.method.length>3000||input.finding.length>3000||!Array.isArray(input.artifacts)||input.artifacts.length>16)throw Error('EXPERIMENT_RESULT_INVALID')
      const runs=readdirSync(x.folder).filter(name=>/^run-.*\.json$/.test(name));if(input.verdict!=='unresolved'&&!runs.length)throw Error('EXPERIMENT_EXECUTION_REQUIRED')
      const id=randomUUID(),folder=join(x.folder,'evidence',id);mkdirSync(folder,{recursive:true})
      const artifacts=input.artifacts.map((path:unknown,index:number)=>{if(typeof path!=='string')throw Error('EXPERIMENT_PATH_INVALID');const file=bounded(x.root,path),target=join(folder,String(index));copyFileSync(file,target);return{path,stored:`evidence/${id}/${index}`,sha256:sha(readFileSync(target)),bytes:statSync(target).size}})
      const result={id,method:input.method,finding:input.finding,verdict:input.verdict,interpretation:'agent_claim',runs,artifacts,at:new Date().toISOString()}
      writeFileSync(join(folder,'result.json'),JSON.stringify(result));writeFileSync(join(x.folder,'result.json'),JSON.stringify(result))
      return{output:JSON.stringify({...result,product_verified:false})}
    }}]
  }
  const parentTool:AgentLoopTool={name:'read_experiment',description:'读取实验子任务的事实、结论和封存产物。可按artifact读取UTF-8代码再用正常文件工具集成；源版本变化时重新核对适用性，不将实验结论当产品验收。',input_schema:{type:'object',required:['session_id'],properties:{session_id:{type:'string'},artifact:{type:'string'}}},execute:async(input,ctx)=>{
    if(ctx.projectId!==projectId||ctx.sessionId!==parent)throw Error('EXPERIMENT_PARENT_REQUIRED')
    const id=String(input.session_id),result=read(id)
    if(input.artifact!==undefined){const artifact=(result.result??result.unfinished)?.artifacts.find((a:{path:string})=>a.path===input.artifact);if(!artifact||artifact.bytes>128*1024)throw Error('EXPERIMENT_ARTIFACT_UNAVAILABLE')
      const file=bounded(valid(id),artifact.stored),bytes=readFileSync(file);if(sha(bytes)!==artifact.sha256)throw Error('EXPERIMENT_EVIDENCE_CHANGED')
      return{output:JSON.stringify({path:artifact.path,sha256:artifact.sha256,text:bytes.toString('utf8'),source_changed:result.source_changed,product_verified:false})}}
    return{output:JSON.stringify(result)}
  }}
  return{prepare,tools,parentTool,has:(id:string)=>active.has(id),describe:(id:string)=>{const x=info(id);return JSON.stringify({question:x.question,criterion:x.criterion,workspace:x.root,source:x.source,boundary:'独立实验目录与数据，不是OS沙箱；不改变用户目标、预算或产品验收。'})}}
}
