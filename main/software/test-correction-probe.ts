import {createHash} from 'node:crypto'
import {writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {findProject} from '../project/project-service'
import {runSecurityScan} from '../verification/security-scan'
import {parseGuiSuite} from '../desktop/gui-acceptance'
import {prepareSoftwareRelease,runtimeInventory} from './release-store'
import {runNativeGuiTests} from './native-gui-observer'
import {pendingTestCorrectionInputs,stageTestCorrectionCandidate} from './test-corrections'

/** Execute the exact proposal in a disposable candidate before adjudication.
 * Its release manifest intentionally stays invalid: this is diagnosis, never
 * an accepted test registration or a publishable release. */
export async function probeTestCorrection(projectId:string,proposal:ReturnType<typeof pendingTestCorrectionInputs>[number],signal:AbortSignal){
  const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
  if(sha(proposal.before.text)!==proposal.before.sha256||sha(proposal.after.text)!==proposal.after.sha256)throw Error('TEST_CORRECTION_PROBE_INPUT_CHANGED')
  const root=findProject(projectId).root_path
  const candidate=await prepareSoftwareRelease(projectId,root,signal)
  const file=join(candidate.root,proposal.file)
  // The host proposal, not the maker's current editable test, owns probe input.
  // Stage only the exact proposed bytes in the disposable candidate. Native
  // execution still verifies every frozen dependency; application to the live
  // tree remains separately gated by independent approval and byte identity.
  if(proposal.transaction)stageTestCorrectionCandidate(projectId,proposal.native,candidate.root)
  else writeFileSync(file,proposal.after.text)
  const expected=await runtimeInventory(candidate.root,signal,candidate.dependencies)
  const security=runSecurityScan({project_id:projectId,root_path:candidate.root,profile:'local-software'})
  const suite=parseGuiSuite({version:1,scope_hash:proposal.scope,design_hash:findProject(projectId).ux_confirmation?.design_hash,
    covers:[...new Set(proposal.native.cases.map(c=>c.feature))],steps:[],native_tests:proposal.native})
  let result:unknown
  try{result=security.passed
    ? await runNativeGuiTests({projectId,root:candidate.root,launch:candidate.launch,suite,signal})
    : {status:'unverified',error:'TEST_CORRECTION_PROBE_SECURITY_FAILED',execution:'not_started',security}}
  catch(error){signal.throwIfAborted();result={status:'unverified',error:String(error)}}
  signal.throwIfAborted()
  if((await runtimeInventory(root,signal)).digest!==candidate.source.digest||(await runtimeInventory(candidate.root,signal,candidate.dependencies)).digest!==expected.digest)throw Error('TEST_CORRECTION_PROBE_BYTES_CHANGED')
  return{purpose:'proposal_adjudication_only',candidate:candidate.id,source:candidate.source.digest,proposal:proposal.id,
    proposed_test:proposal.after.sha256,product_verified:false,source_unchanged:true,result}
}
