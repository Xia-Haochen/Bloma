import {mkdirSync,cpSync,readFileSync,writeFileSync,readdirSync,lstatSync,existsSync} from 'node:fs'
import {resolve,join,dirname} from 'node:path'
import {spawn} from 'node:child_process'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {createHash,randomUUID} from 'node:crypto'

const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..')
export function runtimeDigest(directory){
  const digest=createHash('sha256')
  const visit=(dir,relative='')=>{
    for(const name of readdirSync(dir).sort()){
      const file=join(dir,name),key=relative+'/'+name,stat=lstatSync(file)
      if(stat.isSymbolicLink())throw Error('OBSERVATION_RUNTIME_LINK')
      if(stat.isDirectory())visit(file,key)
      else{digest.update(key+'\0');digest.update(createHash('sha256').update(readFileSync(file)).digest())}
    }
  };visit(directory);return digest.digest('hex')
}
export function userAttemptSuffix(){const id=process.env.BLOMA_OBSERVATION_RETEST??'';if(id&&!/^[a-z0-9-]{1,40}$/.test(id))throw Error('RETEST_ID_INVALID');return id?'-'+id:''}
export async function prepareObservation(root,compile,userAuthorization){
  const suffix=userAuthorization?userAttemptSuffix():''
  const descriptor=join(root,userAuthorization?'user-runtime'+suffix+'.json':'runtime.json')
  if(existsSync(descriptor)||!userAuthorization&&(existsSync(join(root,'home'))||existsSync(join(root,'run-claimed.json'))))throw Error('OBSERVATION_ROOT_NOT_FRESH')
  let migration
  if(userAuthorization){
    if(!userAuthorization.trim())throw Error('SIMULATED_USER_AUTHORIZATION_REQUIRED')
    const manifest=JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')),task=Object.keys(manifest.tasks)[0]
    const folder=join(root,task),reports=readdirSync(folder).filter(name=>suffix?/^user-run-.*\.json$/.test(name):/^run-.*\.json$/.test(name)).sort((a,b)=>Date.parse(JSON.parse(readFileSync(join(folder,b),'utf8')).started_at??0)-Date.parse(JSON.parse(readFileSync(join(folder,a),'utf8')).started_at??0))
    if(!reports.length||!suffix&&reports.length!==1||existsSync(join(root,'user-run-claimed'+suffix+'.json')))throw Error('SIMULATED_USER_BOUNDARY_REQUIRED')
    const report=JSON.parse(readFileSync(join(folder,reports[0]),'utf8'))
    let boundary
    if(suffix){
      if(report.status!=='failed'||!report.finished_at||!(typeof report.error==='string'&&(report.error==='Error: SIMULATED_USER_PREVIEW_NOT_LOCAL'||report.error==='Error: SIMULATED_USER_OBSERVATION_REQUIRED'||report.error==='Error: SIMULATED_USER_DECISION_MISSING'||report.error==='SyntaxError: Unexpected end of JSON input'||report.error==='Error: SIMULATED_USER_RESPONSE_EMPTY'||report.error.startsWith('SyntaxError: Expected property name')||report.error.startsWith('TimeoutError: elementHandle.'))))throw Error('RETEST_REQUIRES_RECORDED_PREVIEW_FAILURE')
      const ledger=JSON.parse(readFileSync(join(root,'monetary-policy.json.state.json'),'utf8'));if(ledger.entries.some(row=>row.status!=='reported'))throw Error('RETEST_UNSETTLED_REQUEST')
      const project=JSON.parse(readFileSync(join(root,'home/projects.json'),'utf8')).projects.find(p=>p.project_id===report.project_id)
      if(!project||project.current_stage!=='blocked_for_user_decision')throw Error('RETEST_NOT_AT_USER_BOUNDARY')
      boundary={project_id:project.project_id,session_id:report.session_id,current_stage:project.current_stage,project_status:project.status}
    }else if(report.status!=='awaiting_user')throw Error('SIMULATED_USER_BOUNDARY_REQUIRED')
    const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex')
    migration={authorization:userAuthorization,attempt:suffix,boundary,previous_runtime_digest:manifest.runtime_tree_sha256,
      manifest_sha256:sha(join(root,'manifest.json')),policy_sha256:sha(join(root,'monetary-policy.json')),
      report:join(task,reports[0]),report_sha256:sha(join(folder,reports[0])),project_sha256:sha(join(folder,'project.json'))}
  }
  mkdirSync(root,{recursive:true})
  const runtime=join(repo,'run-artifacts/observation-runtime',randomUUID(),'main')
  mkdirSync(runtime,{recursive:true})
  // Compile failure leaves no runnable descriptor and never starts Electron.
  await compile({entryPoints:[join(repo,'scripts/software-observation-trial.ts')],outfile:join(runtime,'runner.mjs'),bundle:true,platform:'node',format:'esm',packages:'external'})
  cpSync(join(repo,'main/templates'),join(runtime,'templates'),{recursive:true,filter:p=>!p.includes('__pycache__')})
  const frozen={runtime,digest:runtimeDigest(runtime),migration}
  writeFileSync(descriptor,JSON.stringify(frozen),{flag:'wx'});return frozen
}
export function readObservationRuntime(root,userMode=false){
  const frozen=JSON.parse(readFileSync(join(root,userMode?'user-runtime'+userAttemptSuffix()+'.json':'runtime.json'),'utf8'))
  if(typeof frozen.runtime!=='string'||runtimeDigest(frozen.runtime)!==frozen.digest)throw Error('OBSERVATION_RUNTIME_CHANGED')
  return frozen
}
async function main(){
  const phase=process.argv[2],root=process.env.BLOMA_OBSERVATION_ROOT
  if(!root||!['prepare','preflight','run','prepare-user','simulate'].includes(phase))throw Error('Usage: set BLOMA_OBSERVATION_ROOT; node scripts/software-observation-trial.mjs prepare|preflight|run|prepare-user|simulate')
  if(phase==='prepare'||phase==='prepare-user'){
    if(process.versions.electron)throw Error('PREPARE_REQUIRES_NODE')
    const authorization=phase==='prepare-user'?process.env.BLOMA_SIMULATED_USER_AUTHORIZATION_TEXT:undefined
    if(phase==='prepare-user'&&!authorization?.trim())throw Error('SIMULATED_USER_AUTHORIZATION_REQUIRED')
    const {build}=await import('esbuild');console.log(JSON.stringify(await prepareObservation(resolve(root),build,authorization)));return
  }
  const frozen=readObservationRuntime(resolve(root),phase==='simulate')
  process.env.BLOMA_OBSERVATION_PHASE=phase
  process.env.BLOMA_OBSERVATION_RUNTIME_DIGEST=frozen.digest
  if(!process.versions.electron){
    const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
    const child=spawn(join(repo,'node_modules/electron/dist',process.platform==='win32'?'electron.exe':'electron'),[fileURLToPath(import.meta.url),phase],{cwd:repo,env,windowsHide:true,stdio:'inherit'})
    await new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{process.exitCode=code??1;done()})})
  }else{
    const {app}=await import('electron')
    try{await (await import(pathToFileURL(join(frozen.runtime,'runner.mjs')).href)).main();app.exit(0)}
    catch(error){console.error(error.message);app.exit(1)}
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1})
