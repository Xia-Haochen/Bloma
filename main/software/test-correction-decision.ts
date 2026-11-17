import { randomUUID } from 'node:crypto'
import { callLlmForJson, type LlmAttemptFailure } from '../kernel/llm-call'
import type { SDKQuery } from '../orchestration/stages/orchestration-contracts'

export interface TestCorrectionDecision {
  verdict:'approve'|'reject'
  reason:string
  assessment:Array<{feature:string;preserved:boolean;reason:string}>
}

/** Both native scripts and independent cases use the same correction decision.
 * The supplied evidence determines which claims can actually be adjudicated. */
export async function reviewTestCorrectionDecision(input:{
  sessionId:string;query:SDKQuery;env:Record<string,string>;maxTokens:number;signal:AbortSignal
  prompt:string;features:string[];instructions:string;attempts?:number
}) {
  let failure:LlmAttemptFailure|undefined, response=''
  const decision=await callLlmForJson<TestCorrectionDecision>({query:input.query,env:input.env,
    sessionId:input.sessionId+'-test-review-'+randomUUID(),maxTokens:input.maxTokens,
    temperature:0,attempts:input.attempts??1,signal:input.signal,prompt:input.prompt,
    systemPrompt:input.instructions+'\n只输出JSON {verdict:"approve"|"reject",reason:string,assessment:[{feature:string,preserved:boolean,reason:string}]}，逐项覆盖expected_sources。批准要求每项preserved=true。',
    retryFeedback:'裁定格式无效，请保留原审查意见，用规定JSON字段返回。assessment须逐项覆盖expected_sources中的全部功能编号。',
    onAttemptFailure:value=>{failure=value},parse:raw=>{
      response=raw.slice(0,64000)
      const text=raw.trim(),fenced=text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i)
      let value:TestCorrectionDecision
      try{value=JSON.parse(fenced?.[1]??text)}catch{return}
      if(!value||!['approve','reject'].includes(value.verdict)||typeof value.reason!=='string'||!value.reason.trim()
        ||value.reason.length>6000||!Array.isArray(value.assessment)||value.assessment.length!==input.features.length)return
      if(new Set(value.assessment.map(row=>row.feature)).size!==input.features.length
        ||value.assessment.some(row=>!input.features.includes(row.feature)||typeof row.preserved!=='boolean'
          ||typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>3000))return
      if(value.verdict==='approve'&&value.assessment.some(row=>!row.preserved))return
      return value
    },
  })
  input.signal.throwIfAborted()
  return {decision,failure,response}
}
