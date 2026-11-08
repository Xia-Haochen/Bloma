import {createHash,randomUUID} from 'node:crypto'
import {existsSync,readFileSync,writeFileSync,mkdirSync,openSync,closeSync,unlinkSync,realpathSync,lstatSync} from 'node:fs'
import {join,dirname,resolve,relative,isAbsolute} from 'node:path'
import {getPromaHome} from '../../storage/config-paths'
import {writeTextFileAtomic} from '../../storage/json-store'
import {findProject} from '../project/project-service'
import {readPrdBackplane} from '../project/prd-store'
import {prdScopeFingerprint,trustedAcceptance} from '../project/requirement-contract'
import {guiSuitePath,parseGuiSuite} from '../desktop/gui-acceptance'
import {readProjectStages} from './project-stages'
import {freezeNativeGuiTests,frozenNativeGuiVersion,nativeCheckExecuted,type NativeGuiTests} from './native-gui-tests'

const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const pathOf=(n:NativeGuiTests,p:string)=>n.layout==='project'?p:n.directory+'/'+p
interface Proposal {id:string;scope:string;before:NativeGuiTests;after:NativeGuiTests;file:string;old_hash:string;new_hash:string;replacement:string;reason:string;
  expected_sources:Record<string,string>;status:'pending'|'approved'|'rejected';at:string;applied_at?:string;
  decision?:{reviewer:'independent_operator'|'independent_model';reason:string;at:string;evidence:Array<{path:string;sha256:string}>}}
interface State{version:1;proposals:Proposal[]}
function base(id:string){if(!/^[A-Za-z0-9_-]+$/.test(id))throw Error('TEST_CORRECTION_PROJECT_INVALID');return join(getPromaHome(),'software-test-corrections',id)}
function scope(id:string){const b=readPrdBackplane(id);if(!b.user_confirmed_at)throw Error('TEST_CORRECTION_SCOPE_UNCONFIRMED');return prdScopeFingerprint(b)}
function read(id:string):State{
  const file=join(base(id),'state.json');if(!existsSync(file))return{version:1,proposals:[]}
  const {checksum,...state}=JSON.parse(readFileSync(file,'utf8'))
  if(state.version!==1||!Array.isArray(state.proposals)||hash(JSON.stringify(state))!==checksum)throw Error('TEST_CORRECTION_STATE_INVALID')
  return state
}
function mutate<T>(id:string,fn:(state:State)=>T):T{
  mkdirSync(base(id),{recursive:true});const lock=join(base(id),'state.lock'),fd=openSync(lock,'wx')
  try{const state=read(id),result=fn(state);writeTextFileAtomic(join(base(id),'state.json'),JSON.stringify({...state,checksum:hash(JSON.stringify(state))}));return result}
  finally{closeSync(fd);unlinkSync(lock)}
}
/** Contract identity is a registration fact. Execution success is not permission
 * to read or propose a correction; approval and actual re-verification stay separate. */
function registeredContracts(id:string){
  const current=scope(id),contracts=new Map<string,{native:NativeGuiTests;origin:string;execution:string}>()
  for(const a of readProjectStages(id).attempts.filter(a=>a.scope===current))
    contracts.set(a.native.digest,{native:a.native,origin:a.executed===true?'executed_stage':'registered_stage',execution:a.executed===false?'not_started':a.executed===true?'attempted':'unknown'})
  if(existsSync(guiSuitePath(id))){
    const bytes=readFileSync(guiSuitePath(id)),suite=parseGuiSuite(JSON.parse(bytes.toString('utf8')))
    if(suite.scope_hash===current&&suite.native_tests){
      let execution='not_observed'
      try{const r=JSON.parse(readFileSync(join(getPromaHome(),'software-verification',id+'.json'),'utf8'))
        if(r.state==='complete'&&r.result_hash===hash(JSON.stringify(r.result))&&r.result?.native_plan?.suite_hash===hash(bytes))execution=r.result.native_plan.execution==='attempted'?(nativeCheckExecuted(r.result.core?.host_gui)?'observed':'incomplete'):'not_started'
      }catch{/* Contract remains readable without a trustworthy execution receipt. */}
      contracts.set(suite.native_tests.digest,{native:suite.native_tests,origin:execution==='observed'?'executed_formal':'registered_formal',execution})
    }
  }
  return contracts
}
function contract(id:string,digest:string){
  const entry=registeredContracts(id).get(digest)
  if(!entry)throw Error('TEST_CONTRACT_NOT_REGISTERED_IN_CURRENT_SCOPE')
  frozenNativeGuiVersion(id,entry.native)
  return entry.native
}
export function readTestContractFile(id:string,digest:string,path:string){
  const n=contract(id,digest),file=n.files.find(f=>pathOf(n,f.path)===path);if(!file)throw Error('TEST_CORRECTION_FILE_NOT_IN_CONTRACT')
  frozenNativeGuiVersion(id,n)
  return{contract_digest:digest,file:path,sha256:file.sha256,text:readFileSync(join(getPromaHome(),'gui-native-tests',id,n.digest,file.path),'utf8'),source:'host_frozen_test',verification:'not_issued'}
}
/** Maker may propose an exact edit. It cannot approve it, alter the frozen
 * archive or waive a failure. The proposed contract is parsed but never run. */
export function proposeTestCorrection(id:string,input:{contract_digest:string;file:string;old_text:string;new_text:string;feature_ids:string[];reason:string}){
  const before=contract(id,input.contract_digest),original=readTestContractFile(id,before.digest,input.file),brief=readPrdBackplane(id)
  if(typeof input.old_text!=='string'||typeof input.new_text!=='string'||!input.old_text||!input.new_text||input.old_text===input.new_text||input.old_text.length>16000||input.new_text.length>16000||typeof input.reason!=='string'||!input.reason.trim()||input.reason.length>3000
    ||!Array.isArray(input.feature_ids)||!input.feature_ids.length||input.feature_ids.some(f=>!before.cases.some(c=>c.feature===f)||!brief.requirements.some(r=>r.id===f)))throw Error('TEST_CORRECTION_PROPOSAL_INVALID')
  if(original.text.split(input.old_text).length!==2)throw Error('TEST_CORRECTION_EXACT_MATCH_REQUIRED')
  const replacement=original.text.replace(input.old_text,input.new_text),newHash=hash(replacement),current=scope(id)
  const duplicate=read(id).proposals.find(p=>p.scope===current&&p.before.digest===before.digest&&p.file===input.file&&p.new_hash===newHash)
  if(duplicate)return{id:duplicate.id,status:duplicate.status,verification:'not_issued'}
  const pid=randomUUID(),root=join(base(id),pid,'proposal');mkdirSync(root,{recursive:true})
  for(const f of before.files){const dest=join(root,pathOf(before,f.path));mkdirSync(dirname(dest),{recursive:true});writeFileSync(dest,readFileSync(join(getPromaHome(),'gui-native-tests',id,before.digest,f.path)))}
  writeFileSync(join(root,input.file),replacement)
  const after=freezeNativeGuiTests(id,root,pathOf(before,before.entry),[...new Set(before.cases.map(c=>c.feature))],before.restart)
  if(JSON.stringify(before.cases.map(c=>[c.name,c.feature]).sort())!==JSON.stringify(after.cases.map(c=>[c.name,c.feature]).sort()))throw Error('TEST_CORRECTION_CASE_SET_CHANGED')
  const changed=before.cases.filter(c=>after.cases.find(a=>a.name===c.name)?.signature!==c.signature)
  if(changed.some(c=>!input.feature_ids.includes(c.feature)))throw Error('TEST_CORRECTION_UNDECLARED_CASE_CHANGED')
  if(after.files.length!==before.files.length||before.files.some(f=>!after.files.some(a=>pathOf(after,a.path)===pathOf(before,f.path))))throw Error('TEST_CORRECTION_INPUT_SET_CHANGED')
  const proposal:Proposal={id:pid,scope:current,before,after,file:input.file,old_hash:original.sha256,new_hash:newHash,replacement,reason:input.reason,status:'pending',at:new Date().toISOString(),
    expected_sources:Object.fromEntries(input.feature_ids.map(f=>{const expected=trustedAcceptance(brief,brief.requirements.find(r=>r.id===f)!);if(!expected?.trim())throw Error('TEST_CORRECTION_EXPECTED_SOURCE_REQUIRED');return[f,expected]}))}
  mutate(id,state=>{state.proposals.push(proposal)})
  return{id:pid,status:'pending',old_hash:proposal.old_hash,new_hash:newHash,expected_sources:proposal.expected_sources,verification:'not_issued',next:'独立宿主裁定前不写回测试、不继续付费重试；原失败记录保留。'}
}
export function testCorrectionView(id:string){
  const current=scope(id),contracts=registeredContracts(id)
  return{contracts:[...contracts.values()].map(({native:n,origin,execution})=>({origin,execution,contract_digest:n.digest,entry:pathOf(n,n.entry),files:n.files.map(f=>({path:pathOf(n,f.path),sha256:f.sha256})),cases:n.cases.map(c=>({name:c.name,feature:c.feature}))})),
    proposals:read(id).proposals.filter(p=>p.scope===current).map(({replacement,before,after,...p})=>({...p,contract_digest:before.digest,replacement_digest:after.digest})),verification:'not_issued'}
}
export function pendingTestCorrection(id:string){return read(id).proposals.some(p=>p.scope===scope(id)&&p.status==='pending')}
/** Exact, host-owned inputs for a separate adjudication. No maker conversation. */
export function pendingTestCorrectionInputs(id:string){
  return read(id).proposals.filter(p=>p.scope===scope(id)&&p.status==='pending').map(p=>({
    id:p.id,scope:p.scope,file:p.file,reason:p.reason,expected_sources:p.expected_sources,
    before:readTestContractFile(id,p.before.digest,p.file),after:{text:p.replacement,sha256:p.new_hash},
    cases:p.before.cases,proposed_cases:p.after.cases,native:p.after,
  }))
}
export function testCorrectionGate(id:string){
  if(pendingTestCorrection(id))return 'TEST_CORRECTION_REVIEW_REQUIRED'
  if(approved(id).some(p=>!p.applied_at))return 'TEST_CORRECTION_APPLY_REQUIRED'
}
export function testCorrectionVersion(id:string){
  const rows=read(id).proposals;if(!rows.length)return 'none'
  approved(id) // Evidence changes must invalidate receipt reuse, not just new registration.
  return hash(JSON.stringify(rows.filter(p=>p.scope===scope(id)).map(p=>[p.id,p.status,p.new_hash,Boolean(p.applied_at),p.decision])))
}
/** Host-only independent decision. Not exposed in model tools. Evidence is
 * immutable by hash; approval permits exact test bytes, never product PASS. */
export function decideTestCorrection(id:string,proposalId:string,input:{verdict:'approve'|'reject';reviewer:'independent_operator'|'independent_model';reason:string;expected_sources:Record<string,string>;evidence:Array<{path:string;sha256:string}>}){
  return mutate(id,state=>{
    const p=state.proposals.find(p=>p.id===proposalId)
    if(!p||p.status!=='pending'||p.scope!==scope(id))throw Error('TEST_CORRECTION_DECISION_STALE')
    if(!['independent_operator','independent_model'].includes(input.reviewer)||!input.reason?.trim()||!['approve','reject'].includes(input.verdict)||!Array.isArray(input.evidence)||!input.evidence.length
      ||!input.expected_sources||Object.keys(input.expected_sources).length!==Object.keys(p.expected_sources).length||Object.entries(p.expected_sources).some(([k,v])=>input.expected_sources[k]!==v))throw Error('TEST_CORRECTION_INDEPENDENT_EVIDENCE_REQUIRED')
    for(const e of input.evidence)if(!isAbsolute(e.path)||hash(readFileSync(e.path))!==e.sha256)throw Error('TEST_CORRECTION_EVIDENCE_CHANGED')
    if(input.verdict==='approve'&&state.proposals.some(q=>q.id!==p.id&&q.scope===p.scope&&q.status==='approved'&&q.file===p.file&&q.old_hash===p.old_hash))throw Error('TEST_CORRECTION_CONFLICT')
    p.status=input.verdict==='approve'?'approved':'rejected';p.decision={reviewer:input.reviewer,reason:input.reason,at:new Date().toISOString(),evidence:input.evidence};return{id:p.id,status:p.status,verification:'not_issued'}
  })
}
function approved(id:string){return read(id).proposals.filter(p=>p.scope===scope(id)&&p.status==='approved').map(p=>{
  if(!p.decision||!['independent_operator','independent_model'].includes(p.decision.reviewer)||hash(p.replacement)!==p.new_hash)throw Error('TEST_CORRECTION_APPROVAL_INVALID')
  for(const e of p.decision.evidence)if(hash(readFileSync(e.path))!==e.sha256)throw Error('TEST_CORRECTION_EVIDENCE_CHANGED')
  frozenNativeGuiVersion(id,p.before);frozenNativeGuiVersion(id,p.after);return p
})}
export function applyTestCorrection(id:string,proposalId:string){
  const p=approved(id).find(p=>p.id===proposalId);if(!p)throw Error('TEST_CORRECTION_NOT_APPROVED')
  const root=realpathSync(findProject(id).root_path),file=resolve(root,p.file),rel=relative(root,file),parent=relative(root,realpathSync(dirname(file)))
  if(!rel||rel.startsWith('..')||isAbsolute(rel)||parent.startsWith('..')||isAbsolute(parent)||lstatSync(file).isSymbolicLink())throw Error('TEST_CORRECTION_PATH_INVALID')
  const live=hash(readFileSync(file));if(live!==p.old_hash&&live!==p.new_hash)throw Error('TEST_CORRECTION_WORKING_BYTES_CHANGED')
  if(live!==p.new_hash)writeTextFileAtomic(file,p.replacement)
  mutate(id,state=>{state.proposals.find(q=>q.id===p.id)!.applied_at=new Date().toISOString()})
  return{applied:true,file:p.file,new_hash:p.new_hash,verification:'not_issued',next:'重新执行全部保留案例；批准修订不等于关闭旧失败或通过交付。'}
}
/** Exact independently approved revisions only. Other assertions, dependencies,
 * case names, entry composition and restart requirements remain protected. */
export function filterApprovedTestChanges(id:string,before:NativeGuiTests,after:NativeGuiTests,changes:string[]){
  const decisions=approved(id),chains:Array<{file:string;revisions:Proposal[]}>=[]
  for(const old of before.files){
    const file=pathOf(before,old.path),next=after.files.find(f=>pathOf(after,f.path)===file);if(!next||next.sha256===old.sha256)continue
    let current=old.sha256;const revisions:Proposal[]=[],seen=new Set<string>()
    while(current!==next.sha256&&revisions.length<32&&!seen.has(current)){
      seen.add(current);const matches=decisions.filter(p=>p.file===file&&p.old_hash===current)
      if(matches.length>1)throw Error('TEST_CORRECTION_CONFLICT')
      if(!matches.length)break
      revisions.push(matches[0]);current=matches[0].new_hash
    }
    if(current===next.sha256)chains.push({file,revisions})
  }
  return changes.filter(change=>!chains.some(chain=>{
    if(change===chain.file)return true
    const old=before.cases.find(c=>change===`case:${c.feature}:${c.name}`);if(!old)return false
    let signature=old.signature
    for(const p of chain.revisions){const a=p.before.cases.find(c=>c.name===old.name),b=p.after.cases.find(c=>c.name===old.name);if(!a||!b||a.signature!==signature)return false;signature=b.signature}
    return after.cases.some(c=>c.name===old.name&&c.feature===old.feature&&c.signature===signature)
  }))
}

/** Host recovery: apply only exact approved revisions; never infer approval. */
export function applyApprovedTestCorrections(id:string,signal?:AbortSignal){
  signal?.throwIfAborted()
  if(pendingTestCorrection(id))throw Error('TEST_CORRECTION_REVIEW_REQUIRED')
  const pending=approved(id).filter(p=>!p.applied_at)
  for(const proposal of pending){signal?.throwIfAborted();applyTestCorrection(id,proposal.id)}
  return pending.length
}
