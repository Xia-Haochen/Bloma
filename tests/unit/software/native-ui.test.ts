import { beforeAll, afterAll, expect, it } from 'vitest'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnedNativeUi, NATIVE_UI_CAPABILITIES } from '../../../main/software/native-ui'

let directory:string,child:ChildProcess
const signal=()=>new AbortController().signal
const native=()=>new OwnedNativeUi(child.pid!,()=>child.exitCode===null&&child.signalCode===null,join(directory,'evidence'))
beforeAll(async()=>{
 if(process.platform!=='win32')return
 directory=mkdtempSync(join(tmpdir(),'bloma-native-ui-fixture-'))
 const script=join(directory,'fixture.ps1')
 writeFileSync(script,'\uFEFF'+String.raw`
param([string]$Data)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
public class BackgroundForm : System.Windows.Forms.Form { protected override bool ShowWithoutActivation { get { return true; } } }
'@
$form=New-Object BackgroundForm
$form.Text='Bloma owned native test'
$form.StartPosition='Manual';$form.Location=New-Object Drawing.Point(([Windows.Forms.SystemInformation]::VirtualScreen.Right+600),60)
$form.Size=New-Object Drawing.Size(420,300);$form.ShowInTaskbar=$false
$entry=New-Object Windows.Forms.TextBox;$entry.Name='Entry';$entry.Location=New-Object Drawing.Point(20,20);$entry.Width=300
$save=New-Object Windows.Forms.Button;$save.Name='Save';$save.Text='Save';$save.Location=New-Object Drawing.Point(20,60)
$status=New-Object Windows.Forms.Label;$status.Name='Status';$status.Text='Not saved';$status.Location=New-Object Drawing.Point(20,100);$status.Width=300
$check=New-Object Windows.Forms.CheckBox;$check.Name='Switch';$check.Text='Switch';$check.Location=New-Object Drawing.Point(20,140)
foreach($x in @(140,240)) { $duplicate=New-Object Windows.Forms.Button;$duplicate.Text='Duplicate';$duplicate.Location=New-Object Drawing.Point($x,60);$form.Controls.Add($duplicate) }
$slow=New-Object Windows.Forms.Button;$slow.Name='Slow';$slow.Text='Slow';$slow.Location=New-Object Drawing.Point(140,140)
$slow.Add_Click({[IO.File]::WriteAllText((Join-Path $Data 'late-started'),'started');Start-Sleep -Milliseconds 2500;$script:lateCount++;[IO.File]::WriteAllText((Join-Path $Data 'late-count'),[string]$script:lateCount)})
$form.Controls.AddRange(@($entry,$save,$status,$check,$slow))
$save.Add_Click({[IO.File]::WriteAllText((Join-Path $Data 'saved.txt'),$entry.Text);$status.Text='Saved '+$entry.Text})
$form.Add_Shown({[IO.File]::WriteAllText((Join-Path $Data 'ready'),'ready')})
$timer=New-Object Windows.Forms.Timer;$timer.Interval=150
$timer.Add_Tick({
 $trigger=Join-Path $Data 'modal'
 if([IO.File]::Exists($trigger)){
  [IO.File]::Delete($trigger)
  $modal=New-Object BackgroundForm;$modal.Text='Owned modal';$modal.StartPosition='Manual';$modal.Location=$form.Location;$modal.ShowInTaskbar=$false
  $cancel=New-Object Windows.Forms.Button;$cancel.Name='CancelModal';$cancel.Text='Cancel modal';$cancel.DialogResult='Cancel';$modal.Controls.Add($cancel);$modal.CancelButton=$cancel
  [void]$modal.ShowDialog($form);$modal.Dispose()
 }
})
$timer.Start();[Windows.Forms.Application]::Run($form);$timer.Dispose()
`)
 let output=''
 child=spawn(join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-STA','-File',script,'-Data',directory],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,TEMP:directory,TMP:directory}})
 child.stderr!.on('data',b=>output+=b)
 const deadline=Date.now()+15000
 while(!existsSync(join(directory,'ready'))){if(child.exitCode!==null||Date.now()>deadline)throw Error('Owned fixture failed: '+output);await new Promise(r=>setTimeout(r,100))}
},20000)
afterAll(async()=>{
 if(child?.pid&&child.exitCode===null)await new Promise<void>(resolve=>execFile('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,timeout:5000},()=>resolve()))
 if(directory)rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100})
})
it('validates internal capabilities and never takes a persisted foreign PID/ref as authority',async()=>{
 expect(NATIVE_UI_CAPABILITIES.physical_input).toBe(false)
 expect(()=>new OwnedNativeUi(-1,()=>true)).toThrow('NATIVE_OWNER_INVALID')
 const dead=new OwnedNativeUi(process.pid,()=>false)
 await expect(dead.inspect({},signal())).rejects.toThrow('NATIVE_OWNER_NOT_LIVE')
 const invalid=new OwnedNativeUi(process.pid,()=>true)
 await expect(invalid.inspect({root_pid:process.pid} as never,signal())).rejects.toThrow('NATIVE_REQUEST_INVALID')
 await expect(invalid.inspect({control:{ref:'old',kind:'press'}} as never,signal())).rejects.toThrow('NATIVE_CONTROL_INVALID')
 await expect(invalid.inspect({control:{ref:'old',kind:'invoke'}},signal())).rejects.toThrow('NATIVE_REFERENCE_STALE')
})
it.runIf(process.platform==='win32')('uses actual background WinForms UIA values/invoke with one-shot refs and actual persisted bytes',async()=>{
 const ui=native()
 try{
  const limited=await ui.inspect({query:{limit:1}},signal());expect(limited.nodes).toHaveLength(1)
  await expect(ui.inspect({control:{ref:`${limited.snapshot_id}:e:1`,kind:'fill',value:'unobserved'}},signal())).rejects.toThrow('NATIVE_REFERENCE_STALE')
  let view=await ui.inspect({},signal())
  expect(view.backend).toBe('Windows.UIAutomation');expect(view.windows).toHaveLength(1);expect(view.windows[0]!.name).toBe('Bloma owned native test');expect(view.windows[0]!.dpi).toBeGreaterThan(0)
  expect(view.screenshot_error).toBeFalsy();expect(view.screenshot).toBeTruthy();expect(readFileSync(view.screenshot!).subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a')
  if(process.env.NATIVE_UI_SCREENSHOT_REPORT)copyFileSync(view.screenshot!,process.env.NATIVE_UI_SCREENSHOT_REPORT)
  expect(view.nodes.filter(n=>n.name==='Duplicate')).toHaveLength(2)
  const entry=view.nodes.find(n=>n.automation_id==='Entry')!;expect(entry).toBeTruthy()
  const foreign=native();await expect(foreign.inspect({control:{ref:String(entry.ref),kind:'fill',value:'wrong'}},signal())).rejects.toThrow('NATIVE_REFERENCE_STALE');foreign.close()
  view=await ui.inspect({control:{ref:String(entry.ref),kind:'fill',value:'saved-Ω'}},signal())
  expect(view.method).toBe('UIA.ValuePattern');expect(view.nodes.find(n=>n.automation_id==='Entry')?.value).toBe('saved-Ω')
  await expect(ui.inspect({control:{ref:String(entry.ref),kind:'fill',value:'duplicate'}},signal())).rejects.toThrow('NATIVE_REFERENCE_STALE')
  // A rejected old reference consumes the preceding observation conservatively.
  view=await ui.inspect({},signal());const save=view.nodes.find(n=>n.automation_id==='Save')!
  view=await ui.inspect({control:{ref:String(save.ref),kind:'invoke'}},signal())
  expect(view.method).toBe('UIA.InvokePattern');expect(readFileSync(join(directory,'saved.txt'),'utf8')).toBe('saved-Ω')
  expect(view.nodes.some(n=>n.name==='Saved saved-Ω')).toBe(true)
  ui.close();await expect(ui.inspect({},signal())).rejects.toThrow('NATIVE_OWNER_NOT_LIVE')
 }finally{ui.close()}
},60000)
it.runIf(process.platform==='win32')('rejects stale/new-observation refs, selects owned modal explicitly and never sends foreground input',async()=>{
 const ui=native()
 try{
  const old=await ui.inspect({},signal()),ref=old.nodes.find(n=>n.automation_id==='Save')!.ref
  await ui.inspect({},signal());await expect(ui.inspect({control:{ref:String(ref),kind:'invoke'}},signal())).rejects.toThrow('NATIVE_REFERENCE_STALE')
  const before=await ui.inspect({},signal()),entry=before.nodes.find(n=>n.automation_id==='Entry')!
  writeFileSync(join(directory,'modal'),'open modal');await new Promise(r=>setTimeout(r,400))
  await expect(ui.inspect({control:{ref:String(entry.ref),kind:'fill',value:'must not write'}},signal())).rejects.toThrow('NATIVE_REFERENCE_STALE')
  let modal=await ui.inspect({},signal());expect(modal.needs_window_selection).toBe(true);expect(modal.nodes).toHaveLength(0)
  const selected=modal.windows.find(w=>w.name==='Owned modal')!;expect(selected).toBeTruthy()
  modal=await ui.inspect({window_ref:selected.ref},signal());const cancel=modal.nodes.find(n=>n.automation_id==='CancelModal')!;expect(cancel).toBeTruthy()
  modal=await ui.inspect({control:{ref:String(cancel.ref),kind:'invoke'}},signal());expect(modal.windows).toHaveLength(1)
 }finally{ui.close()}
},60000)
it.runIf(process.platform==='win32')('checks actual toggle state and process start identity before input, not just label/geometry',async()=>{
 const first=native(),second=native()
 try{
  const old=await first.inspect({},signal()),other=await second.inspect({},signal())
  const original=old.nodes.find(n=>n.automation_id==='Switch')!,toggle=other.nodes.find(n=>n.automation_id==='Switch')!
  const changed=await second.inspect({control:{ref:String(toggle.ref),kind:'toggle'}},signal())
  expect(changed.method).toBe('UIA.TogglePattern');expect(changed.nodes.find(n=>n.automation_id==='Switch')?.state).not.toBe(original.state)
  await expect(first.inspect({control:{ref:String(original.ref),kind:'toggle'}},signal())).rejects.toThrow('NATIVE_REFERENCE_STALE')
  ;(first as unknown as {started:string}).started='1'
  await expect(first.inspect({},signal())).rejects.toThrow('NATIVE_PROCESS_IDENTITY_CHANGED')
 }finally{await first.close();await second.close()}
},45000)
it.runIf(process.platform==='win32')('serializes owned pattern dispatch and does not replay an actual late mutation after client cancellation',async()=>{
 const first=native(),second=native()
 try{
  const a=await first.inspect({},signal()),b=await second.inspect({},signal()),controller=new AbortController()
  const slow=a.nodes.find(n=>n.automation_id==='Slow')!,other=b.nodes.find(n=>n.automation_id==='Save')!
  const pending=first.inspect({control:{ref:String(slow.ref),kind:'invoke'}},controller.signal).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
  await expect(second.inspect({control:{ref:String(other.ref),kind:'invoke'}},signal())).rejects.toThrow('NATIVE_INPUT_BUSY')
  const deadline=Date.now()+15000
  while(!existsSync(join(directory,'late-started'))){if(Date.now()>deadline)throw Error('Actual UI action was never dispatched');await new Promise(r=>setTimeout(r,50))}
  controller.abort()
  expect(String((await pending).error)).toMatch(/NATIVE_(?:CONTROL_CANCELLED_OUTCOME_UNKNOWN|ACTION_DISPATCHED_OBSERVATION_FAILED)/)
  const end=Date.now()+5000
  while(!existsSync(join(directory,'late-count'))){if(Date.now()>end)throw Error('Late owned UI action did not complete');await new Promise(r=>setTimeout(r,50))}
  expect(readFileSync(join(directory,'late-count'),'utf8')).toBe('1')
  const fresh=await first.inspect({},signal());expect(fresh.windows).toHaveLength(1)
  expect(readFileSync(join(directory,'late-count'),'utf8')).toBe('1')
 }finally{await first.close();await second.close()}
},45000)
