import {createHash} from 'node:crypto'
import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {findProject} from '../project/project-service'
import {runSecurityScan} from '../verification/security-scan'
import {parseGuiSuite} from '../desktop/gui-acceptance'
import {prepareSoftwareRelease,runtimeInventory} from './release-store'
import {runNativeGuiTests} from './native-gui-observer'
import {pendingTestCorrectionInputs} from './test-corrections'

/** Execute the exact proposal in a disposable candidate before adjudication.
 * Its release manifest intentionally stays invalid: this is diagnosis, never
 * an accepted test registration or a publishable release. */
export async function probeTestCorrection(projectId:string,proposal:ReturnType<typeof pendingTestCorrectionInputs>[number],signal:AbortSignal){
  const root=findProject(projectId).root_path
  const candidate=await prepareSoftwareRelease(projectId,root,signal)
  const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
  const file=join(candidate.root,proposal.file)
  if(sha(readFileSync(file,'utf8'))!==proposal.before.sha256||sha(proposal.after.text)!==proposal.after.sha256)throw Error('TEST_CORRECTION_PROBE_INPUT_CHANGED')
  writeFileSync(file,proposal.after.text)
  const expected=await runtimeInventory(candidate.root,signal,candidate.dependencies)
  const security=runSecurityScan({project_id:projectId,root_path:candidate.root,profile:'local-software'})
  if(!security.passed)throw Error('TEST_CORRECTION_PROBE_SECURITY_FAILED')
  const suite=parseGuiSuite({version:1,scope_hash:proposal.scope,design_hash:findProject(projectId).ux_confirmation?.design_hash,
    covers:[...new Set(proposal.native.cases.map(c=>c.feature))],steps:[],native_tests:proposal.native})
  let result:unknown
  try{result=await runNativeGuiTests({projectId,root:candidate.root,launch:candidate.launch,suite,signal})}
  catch(error){signal.throwIfAborted();result={status:'unverified',error:String(error)}}
  signal.throwIfAborted()
  if((await runtimeInventory(root,signal)).digest!==candidate.source.digest||(await runtimeInventory(candidate.root,signal,candidate.dependencies)).digest!==expected.digest)throw Error('TEST_CORRECTION_PROBE_BYTES_CHANGED')
  return{purpose:'proposal_adjudication_only',candidate:candidate.id,source:candidate.source.digest,proposal:proposal.id,
    proposed_test:proposal.after.sha256,product_verified:false,source_unchanged:true,result}
}
