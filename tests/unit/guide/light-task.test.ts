import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {beforeEach,afterEach,it,expect} from 'vitest'
import {createProject} from '../../../main/project/project-service'
import {readPrdBackplane} from '../../../main/project/prd-store'
import {parseLeanBrief} from '../../../main/guide/lean-brief'
import {handleGuideMessage} from '../../../main/guide/stages/guide-pipeline'
import {prdScopeFingerprint,requirementEvidenceHash} from '../../../main/project/requirement-contract'
import type {AgentEvent} from '../../../shared/types'
import type {SDKQuery} from '../../../main/orchestration/stages/orchestration-contracts'
let home:string,old:string|undefined
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-light-task-'));process.env.PROMA_HOME=home})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true})})
const source='做一个本机小视频剪辑台，导入预览、按秒选两段并指定顺序，可静音，核对后导出浏览器可播放的新文件。原视频不变，不登录、不联网。'
const data={action:'brief',goal:'本机视频选段与导出',ui:'required',requirements:[{description:'导入和预览本机视频',expected:'视频可预览，坏文件明确提示且界面可继续操作'},{description:'按秒选两段并调整顺序',expected:'按指定起止时间和顺序保留两段'},{description:'核对后导出新视频',expected:'顺序、总时长和声音设置可核对；新文件可播放，原视频不变'}],constraints:['不登录、不联网','原视频保持不变'],out_of_scope:['云上传'],work_items:['检查素材和本机环境','先验证两段视频处理能跑通','实现完整使用流程','用真实文件检查错误和导出结果']}
it('reaches confirmation in one model call without graph routing or scenario quotas',async()=>{
 const p=createProject({request_id:'r',mode:'quick'},{workflowVersion:'software-v1'}),events:AgentEvent[]=[];let calls=0
 const query:SDKQuery=async function*(){calls++;yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:JSON.stringify(data)}]}};yield{type:'result',subtype:'success'}}
 await handleGuideMessage({project_id:p.project_id,session_id:'s',request_id:'r',mode:'quick',current_stage:'clarifying',content:source},e=>events.push(e),{query,env:{},signal:new AbortController().signal,sessionId:'s',history:[],maxTokens:8192,persistAssistant:()=>{}})
 expect(calls).toBe(1);expect(events.filter(e=>e.type==='user_decision_required').map(e=>e.payload.kind)).toEqual(['lean_scope'])
 const saved=readPrdBackplane(p.project_id)
 expect(saved.requirements_model).toBeUndefined();expect(saved.project_plan).toBeUndefined()
 expect(saved.lean_brief?.work_items).toEqual(data.work_items)
 expect(saved.lean_brief?.intent_sources?.[0].text).toBe(source)
 expect(saved.constraints).toEqual(data.constraints);expect(saved.user_confirmed_at).toBeUndefined()
})
it('working steps are advisory while acceptance and business boundaries remain bound',()=>{
 const p=createProject({request_id:'r',mode:'quick'},{workflowVersion:'software-v1'}),previous=readPrdBackplane(p.project_id)
 const result=parseLeanBrief(JSON.stringify(data),{projectId:p.project_id,sessionId:'s',source,previous,software:true})!
 if(result.action!=='brief')throw Error('fixture')
 const before=prdScopeFingerprint(result.brief);result.brief.lean_brief!.work_items=['先调查新发现的编码问题','再做最小实验']
 expect(prdScopeFingerprint(result.brief)).toBe(before)
 const behavior=requirementEvidenceHash(result.brief,result.brief.requirements[0])
 result.brief.lean_brief!.intent_sources!.push({id:'S-002',text:'新增一段用户说明'})
 expect(prdScopeFingerprint(result.brief)).not.toBe(before)
 expect(requirementEvidenceHash(result.brief,result.brief.requirements[0])).toBe(behavior)
 result.brief.constraints!.push('新增业务约束');expect(prdScopeFingerprint(result.brief)).not.toBe(before)
})
it('reports the actual remaining business-field error after bounded automatic retry',async()=>{
 const p=createProject({request_id:'r',mode:'quick'},{workflowVersion:'software-v1'}),events:AgentEvent[]=[];let calls=0
 const query:SDKQuery=async function*(){calls++;yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:JSON.stringify({...data,requirements:[{description:'导出视频',expected:''}]})}]}};yield{type:'result',subtype:'success'}}
 await handleGuideMessage({project_id:p.project_id,session_id:'s',request_id:'r',mode:'quick',current_stage:'clarifying',content:source},e=>events.push(e),{query,env:{},signal:new AbortController().signal,sessionId:'s',history:[],maxTokens:8192,persistAssistant:()=>{}})
 expect(calls).toBe(2);expect(events.filter(e=>e.type==='message_delta').map(e=>e.payload.text).join('')).toContain('第1项需要说明能力和可观察的完成标准')
 expect(events.some(e=>e.type==='user_decision_required')).toBe(false)
})
