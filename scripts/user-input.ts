import {setTimeout as delay} from 'node:timers/promises'
import type {Page} from 'playwright'
import type {UserAction} from './user-action'
import {UserInteractionError,validateUserAction} from './user-action'

/** Real page input only. Every attempted down is paired with up, including cancellation. */
export async function performUserInput(page:Page,action:UserAction,boxFor:(ref:number)=>Promise<{x:number;y:number;width:number;height:number}|null>,signal?:AbortSignal){
  validateUserAction(action);signal?.throwIfAborted()
  const held:string[]=[],pointer=action.pointer
  let mouseDown=false,failure:unknown
  try{
    if(pointer){
      const box=await boxFor(pointer.ref)
      if(!box)throw new UserInteractionError('action','画布不可见，请重新观察。')
      await page.mouse.move(box.x+pointer.x*Math.max(0,box.width-1),box.y+pointer.y*Math.max(0,box.height-1))
    }
    for(const key of action.keys??[]){signal?.throwIfAborted();held.push(key);await page.keyboard.down(key)}
    if(pointer?.button){signal?.throwIfAborted();mouseDown=true;await page.mouse.down({button:pointer.button})}
    await delay(action.milliseconds!,undefined,{signal})
  }catch(error){failure=error}
  finally{
    const releases=await Promise.allSettled([
      ...held.reverse().map(key=>page.keyboard.up(key)),
      ...(mouseDown?[page.mouse.up({button:pointer!.button})]:[])
    ])
    if(failure)throw failure
    const failed=releases.find(r=>r.status==='rejected');if(failed?.status==='rejected')throw failed.reason
  }
}
