import type { SDKQuery } from '../../orchestration/stages/orchestration-contracts'
import { withAbort } from './agent-loop'

/** Agents may work concurrently, but share one model reservation at a time.
 * This queue grants no money and leaves all existing physical-request guards
 * in place. A cancelled waiter cannot release another request's active slot. */
export function serializeModelQueries(query:SDKQuery):SDKQuery {
  let tail=Promise.resolve()
  return async function*(prompt,options){
    options.signal.throwIfAborted()
    const previous=tail
    let release!:()=>void
    tail=new Promise<void>(resolve=>{release=resolve})
    let acquired=false
    try{
      await withAbort(previous,options.signal);acquired=true;options.signal.throwIfAborted()
      const {refreshMessages,...rest}=options
      yield* query(prompt,refreshMessages?{...rest,messages:refreshMessages()}:rest)
    }finally{
      if(acquired)release()
      else void previous.then(release,release)
    }
  }
}
