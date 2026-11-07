/** Wallet observations describe account balance, never fabricate per-call usage
 * or release monetary reservations. Concurrent sampling shares one read. */
export function createTrialWallet(input:{read:()=>Promise<unknown>;record:(value:unknown)=>void;startBalance:number;now?:()=>number}) {
  let pending:Promise<void>|undefined
  let available=false
  let latest:{at:string;balance_rmb:number;balance_decrease_rmb:number}|undefined
  const record=(value:unknown)=>{try{input.record(value)}catch{/* Observation never interrupts production. */}}
  const sample=()=>{
    if(pending)return pending
    pending=(async()=>{
      try{
        const value=await input.read()
        if((typeof value!=='string'&&typeof value!=='number')||String(value).trim()===''||!Number.isFinite(Number(value))||Number(value)<0)throw Error('invalid balance')
        latest={at:new Date(input.now?.()??Date.now()).toISOString(),balance_rmb:Number(value),balance_decrease_rmb:Math.round((input.startBalance-Number(value))*1e6)/1e6}
        available=true
        record({...latest,source:'provider_balance_api',scope:'account_balance_change_not_per_request_bill'})
      }catch{available=false;record({at:new Date(input.now?.()??Date.now()).toISOString(),source:'provider_balance_api',status:'unavailable'})}
    })().finally(()=>{pending=undefined})
    return pending
  }
  return{sample,snapshot:()=>latest&&{...latest,available}}
}
