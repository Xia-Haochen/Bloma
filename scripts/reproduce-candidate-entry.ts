import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { parseGuiSuite } from '../main/desktop/gui-acceptance'
import { sealGuiFixtures } from '../main/desktop/gui-fixtures'
import { readSoftwareCandidate } from '../main/software/release-store'
import { readDebugSession } from '../main/software/debug-sessions'
import { inspectCandidateReproduction, prepareCandidateReproduction, runCandidateReproduction } from '../main/software/candidate-reproduction'

function json(path:string){
 if(!path)throw Error('REPRODUCTION_CLI_JSON_REQUIRED')
 const fd=openSync(path,'r'),buffer=Buffer.allocUnsafe(256*1024+1)
 try {
  const before=fstatSync(fd);if(!before.isFile()||before.size>256*1024)throw Error('REPRODUCTION_CLI_JSON_LIMIT')
  let count=0;while(count<buffer.length){const size=readSync(fd,buffer,count,buffer.length-count,null);if(!size)break;count+=size}
  const after=fstatSync(fd)
  if(count>256*1024||count!==before.size||after.size!==before.size||after.ctimeMs!==before.ctimeMs||after.mtimeMs!==before.mtimeMs)throw Error('REPRODUCTION_CLI_JSON_CHANGED_OR_LIMIT')
  return JSON.parse(buffer.subarray(0,count).toString('utf8'))
 }finally{closeSync(fd)}
}
const [operation,projectId,id,pin,fifth]=process.argv.slice(2)
const controller=new AbortController(),cancel=()=>controller.abort()
process.once('SIGINT',cancel);process.once('SIGTERM',cancel)
const timer=setTimeout(cancel,300000);timer.unref()
try {
 let result:unknown
 if(operation==='export'){
  // export <projectId> <candidateId> <suite.json>. The operator explicitly
  // selects diagnostic data/journey; this never edits an independent C case.
  const candidate=await readSoftwareCandidate(projectId,id,controller.signal)
  const suite=sealGuiFixtures(projectId,candidate.root,parseGuiSuite(json(pin),{allowActionsOnly:true}))
  result=await prepareCandidateReproduction(projectId,id,suite,controller.signal)
 }else if(operation==='inspect'){
  const inspected=await inspectCandidateReproduction({projectId,id,manifestSha256:pin},controller.signal)
  result={protocol:inspected.manifest.protocol,origin:inspected.manifest.origin,producer:inspected.manifest.producer,
   app:{digest:inspected.manifest.app.digest,bytes:inspected.manifest.app.bytes,files:inspected.manifest.app.files.length},seed:inspected.manifest.seed,
   runtime_requirements:inspected.manifest.external_files,managed_runtime:inspected.manifest.runtime,verification:'not_applicable',os_reset:'not_attested'}
 }else if(operation==='evidence'){
  // Historical owner-checked read only; never adopt or resume an old process.
  result=readDebugSession(projectId,id,pin,Number(fifth??0),{limit:80})
 }else if(operation==='run'){
  // run <packageProjectId> <packageId> <pin> <executorProjectId> <runtime-paths.json>
  const runtimePaths=json(process.argv[7])
  if(!runtimePaths||Array.isArray(runtimePaths)||typeof runtimePaths!=='object')throw Error('REPRODUCTION_RUNTIME_MAP_INVALID')
  result=await runCandidateReproduction({projectId,id,manifestSha256:pin,executorProjectId:fifth,runtimePaths,signal:controller.signal})
 }else throw Error('Usage: export <project> <candidate> <suite.json> | inspect <package-project> <package-id> <manifest-sha256> | run <package-project> <package-id> <manifest-sha256> <executor-project> <runtime-paths.json> | evidence <executor-project> <execution-session> <debug-id> [since-seq]. Diagnostic observations only; never C/V/PASS or an OS sandbox.')
 process.stdout.write(JSON.stringify(result,null,2)+'\n')
 if(operation==='run'&&(result as {debug?:{error?:string;steps?:Array<{passed:boolean}>}}).debug?.error)process.exitCode=2
 if(operation==='run'&&(result as {debug?:{steps?:Array<{passed:boolean}>}}).debug?.steps?.some(step=>!step.passed))process.exitCode=2
}catch(error){process.stderr.write(String(error)+'\n');process.exitCode=1}
finally{clearTimeout(timer);process.off('SIGINT',cancel);process.off('SIGTERM',cancel)}
