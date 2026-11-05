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
export async function prepareObservation(root,compile){
  const descriptor=join(root,'runtime.json')
  if(existsSync(descriptor)||existsSync(join(root,'home'))||existsSync(join(root,'run-claimed.json')))throw Error('OBSERVATION_ROOT_NOT_FRESH')
  mkdirSync(root,{recursive:true})
  const runtime=join(repo,'run-artifacts/observation-runtime',randomUUID(),'main')
  mkdirSync(runtime,{recursive:true})
  // Compile failure leaves no runnable descriptor and never starts Electron.
  await compile({entryPoints:[join(repo,'scripts/software-observation-trial.ts')],outfile:join(runtime,'runner.mjs'),bundle:true,platform:'node',format:'esm',packages:'external'})
  cpSync(join(repo,'main/templates'),join(runtime,'templates'),{recursive:true,filter:p=>!p.includes('__pycache__')})
  const frozen={runtime,digest:runtimeDigest(runtime)}
  writeFileSync(descriptor,JSON.stringify(frozen),{flag:'wx'});return frozen
}
export function readObservationRuntime(root){
  const frozen=JSON.parse(readFileSync(join(root,'runtime.json'),'utf8'))
  if(typeof frozen.runtime!=='string'||runtimeDigest(frozen.runtime)!==frozen.digest)throw Error('OBSERVATION_RUNTIME_CHANGED')
  return frozen
}
async function main(){
  const phase=process.argv[2],root=process.env.BLOMA_OBSERVATION_ROOT
  if(!root||!['prepare','preflight','run'].includes(phase))throw Error('Usage: set BLOMA_OBSERVATION_ROOT; node scripts/software-observation-trial.mjs prepare|preflight|run')
  if(phase==='prepare'){
    if(process.versions.electron)throw Error('PREPARE_REQUIRES_NODE')
    const {build}=await import('esbuild');console.log(JSON.stringify(await prepareObservation(resolve(root),build)));return
  }
  const frozen=readObservationRuntime(resolve(root))
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
