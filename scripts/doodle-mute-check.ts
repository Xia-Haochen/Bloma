import {expect,type Page} from '@playwright/test'

/** Select the action from the confirmed scope; drawing may already be silent. */
export function requireMuteContrast(control?:string,action?:string){
  if(Boolean(control)!==Boolean(action))throw Error('MUTE_CONTRAST_REQUIRED: provide both the mute control and an audible action covered by the confirmed requirement')
}

export async function setDoodleMuted(page:Page,selector:string,muted:boolean){
  const control=page.locator(selector)
  await expect(control).toHaveCount(1)
  const read=()=>control.evaluate(el=>{
    if(el instanceof HTMLInputElement&&el.type==='checkbox')return el.checked
    const value=el.getAttribute('aria-checked')??el.getAttribute('aria-pressed')
    if(value!=='true'&&value!=='false')throw Error('MUTE_STATE_UNOBSERVABLE: adapt the real UI before acceptance')
    return value==='true'
  })
  if(await read()!==muted)await control.click()
  await expect.poll(read).toBe(muted)
}

export interface AudioObservation {samples:number;peak:number;rms:number}
export async function checkMuteContrast(page:Page,selector:string,observe:()=>Promise<AudioObservation>){
  await setDoodleMuted(page,selector,false)
  const audible=await observe()
  const expectSound=(a:AudioObservation)=>{
    expect(a.samples,'audio observation must actually run').toBeGreaterThan(1024)
    expect(a.peak,'positive sound control').toBeGreaterThan(.0001)
    expect(a.rms,'positive sound control').toBeGreaterThan(.00001)
  }
  expectSound(audible)
  await setDoodleMuted(page,selector,true)
  const silent=await observe()
  expect(silent.samples,'silence must not mean missing observation').toBeGreaterThan(1024)
  expect(silent.peak,'same action must become silent').toBeLessThan(.00001)
  expect(silent.rms).toBeLessThan(.00001)
  await setDoodleMuted(page,selector,false)
  const restored=await observe();expectSound(restored)
  await setDoodleMuted(page,selector,true)
  return {audible,silent,restored}
}
