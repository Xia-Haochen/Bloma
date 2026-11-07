import { startDelegation, continueDelegation, findDelegation, getDelegationSummary } from '../agent/delegation/agent-collaboration'
import type { AgentLoopToolCallRecord, ToolContext } from '../agent/loop/agent-loop'

/** Optional peer, using the existing delegation lifecycle and shared budgets.
 * It works on initial feasibility and new observed failures, never polls a model
 * on a timer and never votes to approve/reject a release. */
export function createEngineeringPartner(enabled:boolean,version:()=>string=()=> 'current',observation?:()=>string) {
  let id:string|undefined, pending:string|undefined, delivered=false, unavailable:string|undefined, closeoutVersion:string|undefined
  const seen=new Set<string>()
  const dispatch=(ctx:ToolContext)=>{
    if(!pending)return
    const current=id?findDelegation(ctx.sessionId,id):undefined
    if(current?.status==='running')return
    const task=pending
    try {
      const result=id?continueDelegation(ctx,id,task):startDelegation(ctx,{role:'research',readOnly:true,independentWorkspace:true,
        task,expectedOutput:'具体依据、不同解释、最小可判定实验与建议；未验证项如实保留，意见不是用户新需求或交付批准。'})
      id=result.delegation_id;pending=undefined;delivered=false
    } catch(error) { ctx.signal.throwIfAborted(); pending=undefined;unavailable=String(error) }
  }
  return{
    begin(ctx:ToolContext){if(!enabled)return;pending='独立核对确认目标、交付与验证路径及关键未知。读取你自己的 context.json 和版本化材料，自主调查并提出最小实验；保留自己的工作记录，负责人负责产品实现。';dispatch(ctx)},
    closeout(ctx:ToolContext){
      if(!enabled)return
      let current:string
      try{current=version()}catch(error){ctx.signal.throwIfAborted();const key='unavailable:'+String(error);if(closeoutVersion!==key)unavailable=String(error);closeoutVersion=key;return}
      if(current!==closeoutVersion){closeoutVersion=current;pending='负责人提出了当前候选。独立核对设计决定、实际入口、验收依据和未完成项是否一致，指出证据缺口或遗漏的替代解释。不要重做C/V，不签发批准，由负责人判断并收尾。'}
      if(delivered)dispatch(ctx)
    },
    observe(ctx:ToolContext,calls:AgentLoopToolCallRecord[]){
      if(!enabled)return
      const keys=calls.filter(c=>c.status==='error'&&c.failureKey&&!seen.has(c.failureKey)).map(c=>c.failureKey!)
      if(observation&&calls.some(c=>c.name==='inspect_app'&&!c.pending)){const key='observation:'+observation();if(!seen.has(key))keys.push(key)}
      if(keys.length){keys.forEach(key=>seen.add(key));pending='出现新的执行/观察反馈：'+JSON.stringify(keys)+ '。从当前版本化材料和公开诊断独立判断：反馈能证明什么、还有哪些解释、哪个小实验能区分它们；没有新的不确定性可简短说明。不要把执行失败直接等同产品缺陷，也不要把工具返回成功等同验收通过。'}
      // Hand back an earlier opinion before beginning another consultation.
      if(delivered)dispatch(ctx)
    },
    take(ctx:ToolContext){
      if(unavailable){const error=unavailable;unavailable=undefined;delivered=true;return '独立工程咨询未启动，不能推断已有意见：'+error}
      const record=id?findDelegation(ctx.sessionId,id):undefined
      if(!record||record.status==='running'||delivered)return
      delivered=true
      try{return '【独立工程搭档意见：非用户新需求，非交付凭据】\n'+JSON.stringify(getDelegationSummary(record))}
      catch(error){ctx.signal.throwIfAborted();return '独立工程咨询交接不可读，不能推断已有可用意见：'+String(error)}
    },
    owns:(delegation:string)=>id===delegation,
  }
}
