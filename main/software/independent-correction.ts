import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { reviewTestCorrectionDecision } from './test-correction-decision'
import type { SDKQuery } from '../orchestration/stages/orchestration-contracts'
import type { IndependentCases } from './independent-semantics'
import { qualityHash, readQualityLedger, saveQualityLedger } from './quality-store'
import type { QualityFinding } from './quality-ledger'
import { readFileSync } from 'node:fs'
import type { IndependentDesignRecord } from './independent-design'
import { isDeepStrictEqual } from 'node:util'

export interface IndependentCorrection {
  from: string
  review: string
  decisions: Array<{case_id:string; action:'correct'|'retain'; reason:string}>
}

/** Independently compare a proposed contract with its original business inputs
 * and host execution evidence. A maker's challenge is an untrusted claim. */
export async function reviewIndependentCorrection(input: {
  projectId:string; sessionId:string; before:IndependentCases; after:IndependentCases; from:string
  findings:QualityFinding[]; requirements:unknown; query:SDKQuery; env:Record<string,string>
  maxTokens:number; signal:AbortSignal
}):Promise<IndependentCorrection> {
  const changed = input.before.cases.filter(old => !isDeepStrictEqual(old,input.after.cases.find(row => row.id === old.id)))
  if (input.after.cases.length !== input.before.cases.length || input.before.cases.some(old =>
    !input.after.cases.some(row => row.id === old.id && row.feature === old.feature && isDeepStrictEqual(row.basis,old.basis)))) {
    throw Error('INDEPENDENT_CORRECTION_SCOPE_CHANGED: 保留原案例编号、所属需求和确认依据')
  }
  const ids = [...new Set([...changed.map(row => row.id), ...input.findings.filter(row => row.challenge).map(row => row.independent!.case_id)])]
  const expected_sources=Object.fromEntries(input.before.cases.filter(row=>ids.includes(row.id)).map(row=>[row.feature,row.basis?.expected_source]))
  const packet = {requirements:input.requirements,expected_sources,before:input.before,after:input.after,
    cases_to_assess:ids,findings:input.findings.map(row => ({case_id:row.independent!.case_id,
      claim:row.challenge,expected:row.expected_source,checks:row.checks.slice(-3)}))}
  const prompt = JSON.stringify(packet)
  if (Buffer.byteLength(prompt) > 256 * 1024) throw Error('INDEPENDENT_CORRECTION_INPUT_TOO_LARGE')
  const {decision,failure,response}=await reviewTestCorrectionDecision({...input,prompt,features:Object.keys(expected_sources),attempts:2,
    instructions:'独立裁定冻结案例更正。核对确认预期、完整修改前后案例与宿主checks。制作方claim是待核对主张。原步骤中的引用矛盾可由冻结字节和实测值证实；新增输入须走实际产品入口。依据不足时拒绝。保留真实业务目标及失败检测能力，文件语音证据不能替代实体麦克风，静态标签不能替代声音效果。批准更正仅允许宿主重新执行，不代表产品通过。原样保留有效案例可批准并说明争议不成立。'}
  )
  const decisions:IndependentCorrection['decisions']=decision?.verdict==='approve'?ids.map(case_id=>({
    case_id,action:changed.some(row=>row.id===case_id)?'correct':'retain',
    reason:decision.assessment.find(row=>row.feature===input.before.cases.find(item=>item.id===case_id)!.feature)!.reason,
  })):[]
  const evidence=JSON.stringify({packet,decision:decision??null,decisions,response,failure,at:new Date().toISOString()})
  const digest=createHash('sha256').update(evidence).digest('hex')
  const review=join(getPromaHome(),'software-independent-design',input.projectId,'correction-'+digest+'.json')
  writeTextFileAtomic(review,evidence)
  if(!decision)throw Error('INDEPENDENT_CORRECTION_REQUEST_FAILED: '+(failure?.detail??'独立裁定未完成')+'；证据 '+review)
  if(decision.verdict!=='approve')throw Error('INDEPENDENT_CORRECTION_REVIEW_REQUIRED: '+JSON.stringify(decision).slice(0,6000)+'；证据 '+review)
  return {from:input.from,review,decisions}
}

/** Replay the committed correction receipt after interruption. Only the
 * independently accepted invalid cases are superseded; real failures persist. */
export function settleIndependentCorrection(projectId:string,design:IndependentDesignRecord) {
  const correction=design.correction
  if(!correction)return
  const bytes=readFileSync(correction.review,'utf8'), evidence=JSON.parse(bytes)
  const digest=createHash('sha256').update(bytes).digest('hex')
  if(!correction.review.endsWith('correction-'+digest+'.json')||(evidence.decision?.verdict!=='approve'&&evidence.decision?.approve!==true)
    ||JSON.stringify(evidence.packet.after)!==JSON.stringify(design.contract)
    ||JSON.stringify(evidence.decisions??evidence.decision.decisions)!==JSON.stringify(correction.decisions)
    ||qualityHash(evidence.packet.before)!==correction.from)throw Error('INDEPENDENT_CORRECTION_EVIDENCE_INVALID')
  const ledger=readQualityLedger(projectId)
  let changed=false
  for(const finding of ledger.findings.filter(row=>row.independent?.design_digest===correction.from)){
    const decision=correction.decisions.find(row=>row.case_id===finding.independent!.case_id)
    if(!decision)continue
    if(finding.challenge?.resolution?.review===correction.review)continue
    if(finding.challenge) {
      const {resolution:_resolution,...claim}=finding.challenge
      const reviewed=evidence.packet.findings.find((row:{case_id:string})=>row.case_id===finding.independent!.case_id)?.claim
      if(qualityHash(claim)!==qualityHash(reviewed))continue
    }
    if(decision.action==='correct'&&finding.disposition==='superseded'&&finding.unknowns.endsWith(correction.review))continue
    if(finding.challenge)finding.challenge.resolution={review:correction.review,action:decision.action,reason:decision.reason}
    if(decision.action==='correct'){
      finding.disposition='superseded'
      finding.unknowns='独立核对确认原用例有误，修改后须重新实际执行。'+decision.reason+' '+correction.review
    }
    changed=true
  }
  if(changed)saveQualityLedger(projectId,ledger)
}

