import type { SDKQuery, SDKQueryOptions } from '../../orchestration/stages/orchestration-contracts'

/** A single reservation is the conservative budget fallback. Priority only
 * orders waiting requests; it never cancels an owner or grants extra money. */
export function serializeModelQueries(query:SDKQuery,priority:(options:SDKQueryOptions)=>number=()=>0, admit:(options:SDKQueryOptions)=>void=()=>{}):SDKQuery {
  let busy=false,sequence=0
  const waiting:Array<{rank:number;sequence:number;grant:()=>void}>=[]
  const dispatch=()=>{if(busy||!waiting.length)return;waiting.sort((a,b)=>a.rank-b.rank||a.sequence-b.sequence);busy=true;waiting.shift()!.grant()}
  return async function*(prompt,options){
    options.signal.throwIfAborted()
    let acquired=false
    await new Promise<void>((resolve,reject)=>{
      const item={rank:priority(options),sequence:sequence++,grant:()=>{options.signal.removeEventListener('abort',abort);acquired=true;resolve()}}
      const abort=()=>{const index=waiting.indexOf(item);if(index>=0)waiting.splice(index,1);reject(options.signal.reason??Error('cancelled'))}
      options.signal.addEventListener('abort',abort,{once:true});waiting.push(item);dispatch()
    })
    try{
      options.signal.throwIfAborted()
      admit(options) // Recheck eligibility after waiting, before any physical send.
      const {refreshMessages,...rest}=options
      yield* query(prompt,refreshMessages?{...rest,messages:refreshMessages()}:rest)
    }finally{if(acquired){busy=false;dispatch()}}
  }
}
