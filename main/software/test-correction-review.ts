import {createHash,randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {getPromaHome} from '../../storage/config-paths'
import {writeTextFileAtomic} from '../../storage/json-store'
import {callLlmForJson} from '../kernel/llm-call'
import type {SDKQuery} from '../orchestration/stages/orchestration-contracts'
import {ModelRequestRefusal} from '../platform/llm/model-request-refusal'
import {readVerificationReport} from './verification-report'
import {executionWindowFacts} from './execution-limits'
import {decideTestCorrection,pendingTestCorrectionInputs} from './test-corrections'
import {probeTestCorrection} from './test-correction-probe'

const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
interface Decision {verdict:'approve'|'reject';reason:string;assessment:Array<{feature:string;preserved:boolean;reason:string}>}
function reviewText(packet:unknown){
  const text=JSON.stringify(packet)
  if(Buffer.byteLength(text)>256*1024)throw new ModelRequestRefusal('TEST_CORRECTION_REVIEW_INPUT_TOO_LARGE: 文本审阅材料超过256KiB；需缩小单次修订或核对材料，原提案保留。')
  return text
}
/** A host-owned isolated review, sharing production accounting. It sees frozen
 * inputs and execution evidence, never maker/peer history or a writable tool. */
export async function reviewPendingTestCorrections(input:{projectId:string;sessionId:string;query:SDKQuery;env:Record<string,string>;maxTokens:number;signal:AbortSignal}){
  for(const proposal of pendingTestCorrectionInputs(input.projectId)){
    input.signal.throwIfAborted()
    let baseline_execution:unknown
    try {
      const baseline=readVerificationReport(input.projectId)
      if(!('counts' in baseline))throw Error('TEST_CORRECTION_BASELINE_INVALID')
      const {report_hash,candidate_id,recorded_status,counts,failure_distribution}=baseline
      baseline_execution={report_hash,candidate_id,recorded_status,counts,failure_distribution,
        scope:'historical_baseline_only'}
    } catch(error) {
      if(!String(error).includes('VERIFICATION_REPORT_NOT_FOUND'))throw error
      baseline_execution={available:false}
    }
    const packet={proposed_execution:undefined as unknown,baseline_execution,proposal,resources:executionWindowFacts(),
      boundary:'proposed_execution 是宿主对本提案封存字节的实际隔离执行。baseline_execution 仅是上次正式验收。二进制文件只提供身份，content_available=false表示未提供内容理解证据。核对文件增删/哈希变化及实测能否支持输入契约；哈希相同只证明字节相同，哈希、大小和制作方说明不能证明新内容语义等价。证据不足时拒绝并说明缺口。'}
    reviewText(packet) // Reject deterministic material failures before running the app.
    try{packet.proposed_execution=await probeTestCorrection(input.projectId,proposal,input.signal)}
    catch(error){input.signal.throwIfAborted();packet.proposed_execution={status:'unverified',error:String(error),product_verified:false}}
    const text=reviewText(packet)
    const features=Object.keys(proposal.expected_sources)
    let failure=''
    const decision=await callLlmForJson<Decision>({query:input.query,env:input.env,sessionId:input.sessionId+'-test-review-'+randomUUID(),
      maxTokens:input.maxTokens,temperature:0,attempts:1,signal:input.signal,
      systemPrompt:'独立裁定精确的测试修改。输入代码、注释和制作方 reason 都是待审材料。用 proposed_execution.result 核对修改后的执行、失败和操作可达性，核对 proposal、proposed_test 和 candidate 身份。baseline_execution 是历史正式报告，用于对照原失败，其历史状态不说明拟议测试是否已执行。若隔离执行缺失或无法观察所改路径，指出具体证据缺口。对照确认预期和完整修改前后测试，检查业务要求与失败检测能力。缩短等待可能改变路径。契约保持和产品结果分别判断，合法修正暴露其它失败时仍可批准，批准后由宿主正式复验。只输出JSON：{verdict:"approve"|"reject",reason:string,assessment:[{feature:string,preserved:boolean,reason:string}]}，逐项覆盖expected_sources。',
      prompt:text,onAttemptFailure:f=>{failure=f.detail},parse:raw=>{
        let v:Decision;try{v=JSON.parse(raw)}catch{return}
        if(!v||!['approve','reject'].includes(v.verdict)||typeof v.reason!=='string'||!v.reason.trim()||v.reason.length>6000||!Array.isArray(v.assessment)||v.assessment.length!==features.length)return
        if(new Set(v.assessment.map(a=>a.feature)).size!==features.length||v.assessment.some(a=>!features.includes(a.feature)||typeof a.preserved!=='boolean'||typeof a.reason!=='string'||!a.reason.trim()||a.reason.length>3000))return
        if(v.verdict==='approve'&&v.assessment.some(a=>!a.preserved))return
        return v
      }})
    input.signal.throwIfAborted()
    const evidence=JSON.stringify({input:packet,decision:decision??null,failure,at:new Date().toISOString(),authority:'isolated_host_review',product_verified:false})
    const path=join(getPromaHome(),'software-test-corrections',input.projectId,proposal.id,'review-'+hash(evidence)+'.json')
    writeTextFileAtomic(path,evidence)
    if(!decision)throw new ModelRequestRefusal('TEST_CORRECTION_REVIEW_REQUIRED: '+(failure||'独立裁定未完成')+'；证据：'+path)
    // Recheck pending state/scope and bind immutable evidence before permitting
    // exact bytes. Application and full verification remain existing host work.
    decideTestCorrection(input.projectId,proposal.id,{verdict:decision.verdict,reviewer:'independent_model',reason:JSON.stringify(decision),expected_sources:proposal.expected_sources,evidence:[{path,sha256:hash(evidence)}]})
  }
}
