import type {AgentLoopTool} from '../agent/loop/agent-loop'
import type {createSoftwareCollaborationPolicy} from './collaboration-policy'
import {applyTestCorrection,proposeTestTransaction,readTestContractFile,testCorrectionView} from './test-corrections'
import {verificationRefusalFeedback} from './verification-report'

export function buildTestCorrectionTools(id:string,policy:ReturnType<typeof createSoftwareCollaborationPolicy>):AgentLoopTool[]{
  const tool=(name:string,description:string,properties:Record<string,unknown>,required:string[],execute:(input:any)=>unknown):AgentLoopTool=>({name,description,
    input_schema:{type:'object',additionalProperties:false,properties,required},execute:async(input,ctx)=>{
      try{(name==='read_test_contract'?policy.assertRead:policy.assertCommand)(ctx);if(ctx.projectId!==id||Object.keys(input).some(k=>!Object.hasOwn(properties,k)))throw Error('TEST_CORRECTION_INPUT_INVALID');return{output:JSON.stringify(execute(input))}}
      catch(error){return{isError:true,output:String(error),feedback:verificationRefusalFeedback(error)}}
    }})
  return[
    tool('read_test_contract','读取当前确认范围内已登记的冻结原文或纠正提案状态，不要求先执行成功。只读；用于恢复误改的旧入口、核对预期争议。不能改断言或签发PASS。',
      {contract_digest:{type:'string'},file:{type:'string'},offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:16000}},[],input=>{
        if(Boolean(input.contract_digest)!==Boolean(input.file))throw Error('TEST_CORRECTION_INPUT_INVALID')
        if(!input.contract_digest)return testCorrectionView(id)
        const value=readTestContractFile(id,input.contract_digest,input.file),offset=input.offset??0,limit=input.limit??12000
        if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>16000)throw Error('TEST_CORRECTION_PAGE_INVALID')
        const end=Math.min(offset+limit,value.text.length)
        return{...value,text:value.text.slice(offset,end),offset,total_characters:value.text.length,truncated:offset>0||end<value.text.length,
          next:end<value.text.length?{tool:'read_test_contract',arguments:{contract_digest:input.contract_digest,file:input.file,offset:end,limit}}:undefined}
      }),
    tool('propose_test_correction','提交当前工作版本的完整测试修正：宿主封存入口、依赖和声明资源，计算与冻结基线的差异并独立裁定。提交不批准、不签发PASS；后续工作区修改不会改变待审候选。',
      {contract_digest:{type:'string'},script:{type:'string'},working_digest:{type:'string'},reason:{type:'string',maxLength:3000}},
      ['contract_digest','script','reason'],input=>proposeTestTransaction(id,input)),
    tool('apply_test_correction','仅应用已经独立宿主批准的精确测试修改；模型不能批准。若工作文件另被修改，先从read_test_contract恢复原字节。应用不等于通过，随后重跑保留案例。',
      {proposal_id:{type:'string'}},['proposal_id'],input=>applyTestCorrection(id,input.proposal_id)),
  ]
}
