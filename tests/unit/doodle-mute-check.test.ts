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
      // Wall-clock timers/state=running do not prove an audio render quantum.
      // Wait for the actual context clock, then sample distinct rendered times.
      const deadline=performance.now()+3000,start=ctx.currentTime
      try{
        while(ctx.currentTime-start<.05){if(performance.now()>deadline)throw Error('AUDIO_CLOCK_NOT_ADVANCING');await new Promise(r=>setTimeout(r,10))}
        let previous=ctx.currentTime;const measured=previous
        while(ctx.currentTime-measured<.2||samples<2048){
          if(performance.now()>deadline)throw Error('AUDIO_OBSERVATION_INCOMPLETE')
          await new Promise(r=>setTimeout(r,20));const current=ctx.currentTime
          if(current<=previous)continue
          previous=current;analyser.getFloatTimeDomainData(buffer)
          for(const v of buffer){samples++;peak=Math.max(peak,Math.abs(v));sum+=v*v}
        }
        return{samples,peak,rms:Math.sqrt(sum/Math.max(samples,1))}
      }finally{oscillator.stop();await ctx.close()}

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
