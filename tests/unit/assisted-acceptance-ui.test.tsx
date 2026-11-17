// @vitest-environment jsdom
import React from 'react'
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react'
import {afterEach,it,expect,vi} from 'vitest'
import {AssistedAcceptancePanel} from '../../renderer/components/AssistedAcceptancePanel'
afterEach(()=>{cleanup();delete window.electronAPI})
it('requires a deliberate capture click after device selection and exposes cancellation',async()=>{
  let state:any={candidate_id:'a'.repeat(64),phase:'available',detail:'待实测'}
  const api=vi.fn(async(input:any)=>{
    if(input.action==='start')state={...state,attempt_id:'run',phase:'ready',devices:[{id:3,name:'USB microphone'}],detail:'设备已准备'}
    if(input.action==='capture')state={...state,phase:'recording',detail:'正在录音'}
    if(input.action==='cancel')state={...state,phase:'cancelled',detail:'已取消'}
    return {ok:true,data:state}
  })
  window.electronAPI={projectDeliverables:{assistedAcceptance:api}} as never
  render(<AssistedAcceptancePanel projectId="p" onChanged={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:'继续验收'}))
  expect(api.mock.calls.every(([input])=>input.action==='query')).toBe(true)
  fireEvent.click(screen.getByRole('button',{name:'准备麦克风测试'}))
  const select=await screen.findByRole('combobox',{name:'麦克风'})
  expect((screen.getByRole('button',{name:'开始录音'}) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.change(select,{target:{value:'3'}})
  fireEvent.click(screen.getByRole('button',{name:'开始录音'}))
  await screen.findByText('正在录音')
  expect(api.mock.calls.find(([input])=>input.action==='capture')?.[0]).toMatchObject({device:3,candidate_id:state.candidate_id,attempt_id:'run'})
  fireEvent.click(screen.getByRole('button',{name:'取消测试'}))
  await waitFor(()=>expect(screen.getByRole('status').textContent).toBe('已取消'))
})
it('only presents human confirmation for a confirmable observation and binds the feedback to that attempt',async()=>{
  const state:any={candidate_id:'b'.repeat(64),attempt_id:'observed',phase:'failed',can_confirm:true,
    observation:{text:'嗯下周四下午3点开会。',rms:.003,device_name:'Headset'},detail:'自动整句比对不一致'}
  const api=vi.fn(async(input:any)=>({ok:true,data:input.action==='feedback'?{...state,phase:'verifying',can_confirm:false}:state}))
  window.electronAPI={projectDeliverables:{assistedAcceptance:api}} as never
  render(<AssistedAcceptancePanel projectId="p" onChanged={()=>{}}/>)
  fireEvent.click(await screen.findByRole('button',{name:/继续验收/}))
  expect(screen.getByText('实际转写：嗯下周四下午3点开会。')).toBeDefined()
  fireEvent.click(screen.getByRole('button',{name:'转写符合我刚才说的内容'}))
  await waitFor(()=>expect(api.mock.calls.some(([input])=>input.action==='feedback')).toBe(true))
  expect(api.mock.calls.find(([input])=>input.action==='feedback')?.[0]).toMatchObject({accepted:true,attempt_id:'observed',candidate_id:state.candidate_id})
})
