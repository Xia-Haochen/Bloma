import { startDelegation, findDelegation, getDelegationSummary } from '../agent/delegation/agent-collaboration'
import type { ToolContext } from '../agent/loop/agent-loop'

interface Update {session_id:string;turn:number;text:string;truncated:boolean;at:string;facts?:()=>unknown}
/** Short independent consultations, not a parallel full audit or release gate. */
export function createEngineeringPartner(enabled:boolean,knownChild?:(session:string)=>boolean) {
  let id:string|undefined,child:string|undefined,activated=false,delivered=false,unavailable:string|undefined
  let updates:Update[]=[],hadMessage=false
  const packet=()=>({source:'independent_engineering',verification:'not_issued',
    delegation_id:id,authority:'伙伴建议，不是用户新需求或交付凭据；负责人核对依据并决定，必要时用既有continue_delegation追问。',
    updates:updates.map(({facts,...message})=>({...message,...(facts?{workspace_facts:(()=>{try{return facts()}catch{return{available:false}}})()}: {})}))})
  const takeUpdates=()=>{if(!updates.length)return;const value=packet();updates=[];return '【工程伙伴阶段交接】\n'+JSON.stringify(value)}
  return{
    begin(ctx:ToolContext){
      if(!enabled||activated)return
      activated=true
      try{
        const result=startDelegation(ctx,{role:'research',readOnly:true,independentWorkspace:true,
          task:'先核对context.json中的当前阻断、质量发现及既有调查，围绕尚缺的证据调查；缺关键事实时先交接缺口，不猜阻断原因。没有待解问题则结束。',
          expectedOutput:'当前判断、实际依据、影响、建议和未验证点。重要发现及时交接，不必等全部调查结束。'})
        id=result.delegation_id;child=result.child_session_id
      }catch(error){ctx.signal.throwIfAborted();unavailable=String(error)}
    },
    receive(session:string,message:{turn:number;text:string;truncated:boolean},facts?:()=>unknown){
      if(!(knownChild?knownChild(session):activated&&session===child)||!message.text.trim())return
      if(updates.at(-1)?.session_id===session&&updates.at(-1)?.text===message.text)return
      if(session===child)hadMessage=true
      updates.push({session_id:session,...message,at:new Date().toISOString(),facts})
    },
    latest:()=>updates.length?packet():undefined,
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
