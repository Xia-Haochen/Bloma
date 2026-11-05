import {afterAll,beforeAll,expect,it} from 'vitest'
import {chromium,type Browser} from '@playwright/test'
import {existsSync} from 'node:fs'
import {checkMuteContrast,requireMuteContrast,setDoodleMuted} from '../../scripts/doodle-mute-check'

let browser:Browser
beforeAll(async()=>{browser=await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required'],...(existsSync(chromium.executablePath())?{}:{channel:process.platform==='win32'?'msedge':'chrome'})})})
afterAll(async()=>{await browser?.close()})

for(const kind of ['checkbox','switch','button'])it(`checks real PCM contrast using a ${kind}`,async()=>{
  const page=await browser.newPage()
  try{
    await page.setContent(kind==='checkbox'?'<input id="mute" type="checkbox">':kind==='switch'?'<button id="mute" role="switch" aria-checked="false">Mute</button>':'<button id="mute" aria-pressed="false">Mute</button>')
    await page.evaluate(()=>{const el=document.querySelector('#mute')!;if(!(el instanceof HTMLInputElement))el.addEventListener('click',()=>{const key=el.hasAttribute('aria-checked')?'aria-checked':'aria-pressed';el.setAttribute(key,String(el.getAttribute(key)!=='true'))})})
    const observe=()=>page.evaluate(async()=>{
      const el=document.querySelector('#mute')!,muted=el instanceof HTMLInputElement?el.checked:(el.getAttribute('aria-checked')??el.getAttribute('aria-pressed'))==='true'
      const ctx=new AudioContext();await ctx.resume()
      const oscillator=ctx.createOscillator(),gain=ctx.createGain(),analyser=ctx.createAnalyser()
      gain.gain.value=muted?0:.2;oscillator.connect(gain);gain.connect(analyser);analyser.connect(ctx.destination);oscillator.start()
      let samples=0,peak=0,sum=0;const buffer=new Float32Array(analyser.fftSize)
      for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,20));analyser.getFloatTimeDomainData(buffer);if(ctx.state==='running')for(const v of buffer){samples++;peak=Math.max(peak,Math.abs(v));sum+=v*v}}
      oscillator.stop();await ctx.close();return{samples,peak,rms:Math.sqrt(sum/Math.max(samples,1))}
    })
    const result=await checkMuteContrast(page,'#mute',observe)
    expect(result.audible.peak).toBeGreaterThan(.1);expect(result.silent.peak).toBe(0)
    // The scenario deliberately leaves mute on for save/restart acceptance.
    await setDoodleMuted(page,'#mute',true)
    expect((await observe()).peak).toBe(0)
  }finally{await page.close()}
})

it.each(['always silent','inert mute','missing observation','cannot restore'])('rejects %s rather than a false PASS',async(fault)=>{
  const page=await browser.newPage();let calls=0
  try{
    await page.setContent('<input id="mute" type="checkbox">')
    await expect(checkMuteContrast(page,'#mute',async()=>{
      calls++;const muted=await page.locator('#mute').isChecked()
      const silent=fault==='always silent'||fault==='cannot restore'&&calls===3||fault!=='inert mute'&&muted
      return{samples:fault==='missing observation'&&muted?0:2048,peak:silent?0:.2,rms:silent?0:.1}
    })).rejects.toThrow()
  }finally{await page.close()}
})

it('requires an explicit contrast and observable control state',async()=>{
  expect(()=>requireMuteContrast('#mute')).toThrow('MUTE_CONTRAST_REQUIRED')
  expect(()=>requireMuteContrast(undefined,'#sound')).toThrow('MUTE_CONTRAST_REQUIRED')
  expect(()=>requireMuteContrast()).not.toThrow()
  const page=await browser.newPage()
  try{await page.setContent('<button id="mute">Mute</button>');await expect(setDoodleMuted(page,'#mute',true)).rejects.toThrow('MUTE_STATE_UNOBSERVABLE')}
  finally{await page.close()}
})
