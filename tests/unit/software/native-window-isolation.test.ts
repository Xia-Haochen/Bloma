import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {it,expect} from 'vitest'
import {_electron} from 'playwright'
import {isolateNativeTestWindows} from '../../../main/software/native-window-isolation'

it('rejects unowned/invalid identifiers and respects cancellation before moving any window',async()=>{
  await expect(isolateNativeTestWindows(0)).rejects.toThrow('OWNER_INVALID')
  await expect(isolateNativeTestWindows(NaN)).rejects.toThrow('OWNER_INVALID')
  const abort=new AbortController();abort.abort();await expect(isolateNativeTestWindows(process.pid,abort.signal)).rejects.toThrow()
})
it.skipIf(process.platform!=='win32')('isolates only the owned native window, preserves its dimensions, and real pointer input still works',async()=>{
  const root=mkdtempSync(join(tmpdir(),'native-window-isolation-'))
  writeFileSync(join(root,'package.json'),JSON.stringify({main:'main.cjs'}))
  writeFileSync(join(root,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({x:10,y:10,width:500,height:400});w.loadURL('data:text/html,<button id="b" onclick="this.textContent=String(Number(this.textContent)+1)">0</button>')});app.on('window-all-closed',()=>app.quit())`)
  const entry={executablePath:join(process.cwd(),'node_modules/electron/dist/electron.exe'),args:['.']},env=Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>typeof e[1]==='string'));delete env.ELECTRON_RUN_AS_NODE
  const owner=await _electron.launch({...entry,cwd:root,env}),other=await _electron.launch({...entry,cwd:root,env})
  try{
    const page=await owner.firstWindow(),otherPage=await other.firstWindow();await page.locator('#b').waitFor();await otherPage.locator('#b').waitFor()
    const window=await owner.browserWindow(page),otherWindow=await other.browserWindow(otherPage),before=await window.evaluate(w=>w.getBounds()),untouched=await otherWindow.evaluate(w=>w.getBounds()),viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}))
    const nativeOwner=await owner.evaluate(()=>process.pid)
    const visibility=await window.evaluate(w=>({visible:w.isVisible(),destroyed:w.isDestroyed(),handle:w.getNativeWindowHandle().toString('hex')}))
    let receipt:Awaited<ReturnType<typeof isolateNativeTestWindows>>
    try{receipt=await isolateNativeTestWindows(owner.process().pid!)}catch(error){throw Error(JSON.stringify({root:owner.process().pid,nativeOwner,visibility})+' '+String(error))}
    expect(receipt.method).toBe('owned_visible_windows_outside_virtual_desktop');expect(receipt.windows.length).toBeGreaterThan(0)
    expect(receipt.windows.every((w:any)=>w.ProcessId===nativeOwner)).toBe(true)
    const after=await window.evaluate(w=>w.getBounds());expect(after.x).toBeGreaterThan(before.x)
    // Native physical dimensions are enforced by the helper; fractional DPI can
    // round Electron's outer DIP rectangle by one pixel after a position change.
    expect(Math.abs(after.width-before.width)).toBeLessThanOrEqual(1);expect(Math.abs(after.height-before.height)).toBeLessThanOrEqual(1)
    expect(await page.evaluate(()=>({width:innerWidth,height:innerHeight}))).toEqual(viewport)
    expect(await otherWindow.evaluate(w=>w.getBounds())).toEqual(untouched)
    await page.locator('#b').click();expect(await page.locator('#b').innerText()).toBe('1')
    expect(await window.evaluate(w=>w.isMinimized())).toBe(false)
    expect((await page.screenshot()).length).toBeGreaterThan(100)
  }finally{await owner.close();await other.close();rmSync(root,{recursive:true,force:true})}
},45000)
