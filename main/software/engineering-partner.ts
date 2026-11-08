import { startDelegation, continueDelegation, findDelegation, getDelegationSummary } from '../agent/delegation/agent-collaboration'
import type { AgentLoopToolCallRecord, ToolContext } from '../agent/loop/agent-loop'

interface Update {session_id:string;turn:number;text:string;truncated:boolean;at:string;facts?:()=>unknown}
/** Short independent consultations, not a parallel full audit or release gate. */
export function createEngineeringPartner(enabled:boolean,version:()=>string=()=> 'current',observation?:()=>string,knownChild?:(session:string)=>boolean) {
  let id:string|undefined,child:string|undefined,pending:string|undefined,activated=false,delivered=false,unavailable:string|undefined,closeoutVersion:string|undefined
  let updates:Update[]=[],hadMessage=false
  const seen=new Set<string>()
  const packet=()=>({source:'independent_engineering',verification:'not_issued',
    authority:'伙伴建议，不是用户新需求或交付凭据；负责人核对依据并决定。',
    updates:updates.map(({facts,...message})=>({...message,...(facts?{workspace_facts:(()=>{try{return facts()}catch{return{available:false}}})()}: {})}))})
  const takeUpdates=()=>{if(!updates.length)return;const value=packet();updates=[];return '【工程伙伴阶段交接】\n'+JSON.stringify(value)}
  const dispatch=(ctx:ToolContext)=>{
    if(!pending)return
    const current=id?findDelegation(ctx.sessionId,id):undefined
    if(current?.status==='running')return
    try{
      const result=id?continueDelegation(ctx,id,pending):startDelegation(ctx,{role:'research',readOnly:true,independentWorkspace:true,
        task:pending,expectedOutput:'当前判断、实际依据、影响、建议和未验证点。重要发现及时交接，不必等全部调查结束。'})
      id=result.delegation_id;child=result.child_session_id;pending=undefined;delivered=false;updates=updates.filter(update=>update.session_id!==child);hadMessage=false
    }catch(error){ctx.signal.throwIfAborted();pending=undefined;unavailable=String(error)}
  }
  return{
    begin(ctx:ToolContext){
      if(!enabled||activated)return
      activated=true;pending='先核对context.json中的当前阻断、质量发现及既有调查，围绕尚缺的证据调查；缺关键事实时先交接缺口，不猜阻断原因。没有待解问题则结束。';dispatch(ctx)
    },
    receive(session:string,message:{turn:number;text:string;truncated:boolean},facts?:()=>unknown){
      if(!(knownChild?knownChild(session):activated&&session===child)||!message.text.trim())return
      if(updates.at(-1)?.session_id===session&&updates.at(-1)?.text===message.text)return
      if(session===child)hadMessage=true
      updates.push({session_id:session,...message,at:new Date().toISOString(),facts})
    },
    latest:()=>updates.length?packet():undefined,
    closeout(ctx:ToolContext){
      if(!enabled||!activated)return
      let current:string
      try{current=version()}catch(error){ctx.signal.throwIfAborted();const key='unavailable:'+String(error);if(closeoutVersion!==key)unavailable=String(error);closeoutVersion=key;return}
      if(current!==closeoutVersion){closeoutVersion=current;pending='核对当前候选与已有决定、验证依据及未完成项是否一致。只追查会改变当前判断的缺口；不重做C/V，不签发批准。'}
      if(delivered)dispatch(ctx)
    },
    observe(ctx:ToolContext,calls:AgentLoopToolCallRecord[]){
      if(!enabled||!activated)return
      const keys=calls.filter(c=>c.status==='error'&&c.failureKey&&!seen.has(c.failureKey)).map(c=>c.failureKey!)
      if(observation&&calls.some(c=>c.name==='inspect_app'&&!c.pending)){const key='observation:'+observation();if(!seen.has(key))keys.push(key)}
      if(keys.length){keys.forEach(key=>seen.add(key));pending='宿主有新的执行或观察反馈。先看当前facts与实际观察，判断是否推翻已有结论或暴露关键未知；只针对新增问题调查，已有结论不重复通读。'}
      if(delivered)dispatch(ctx)
    },
    take(ctx:ToolContext){
      if(unavailable){const error=unavailable;unavailable=undefined;delivered=true;return '独立工程咨询不可用，不能推断已有意见：'+error}
      const record=id?findDelegation(ctx.sessionId,id):undefined
      if(!record||record.status==='running'||delivered)return takeUpdates()
      delivered=true
      if(hadMessage)return takeUpdates()
      // A stopped optional investigation with no actual conclusion is not a
      // product repair task. The original delegation record remains available.
      if(record.loopStatus&&record.loopStatus!=='completed')return takeUpdates()
      try{return [takeUpdates(),'【独立工程搭档意见：非用户新需求，非交付凭据】\n'+JSON.stringify(getDelegationSummary(record))].filter(Boolean).join('\n')}
      catch(error){ctx.signal.throwIfAborted();return '独立工程咨询交接不可读，不能推断已有可用意见：'+String(error)}
    },
    owns:(delegation:string)=>id===delegation,
  }
}
