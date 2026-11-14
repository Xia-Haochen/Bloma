import React from 'react'
import type { AssistedAcceptanceView, AssistedAcceptanceInput } from '../../shared/types'
import './AssistedAcceptancePanel.css'

export function AssistedAcceptancePanel({projectId,onChanged}:{projectId:string;onChanged:()=>void}) {
  const [view,setView]=React.useState<AssistedAcceptanceView|null>(null)
  const [opened,setOpened]=React.useState(false)
  const [device,setDevice]=React.useState('')
  const [error,setError]=React.useState('')
  const [pending,setPending]=React.useState(false)
  const alive=React.useRef(true)
  const changed=React.useRef(onChanged)
  changed.current=onChanged
  React.useEffect(()=>{
    alive.current=true
    let polling=false
    let previousPhase:AssistedAcceptanceView['phase']|undefined
    const poll=async()=>{
      if(polling)return
      polling=true
      try {
        const result=await window.electronAPI?.projectDeliverables.assistedAcceptance({request_id:crypto.randomUUID(),project_id:projectId,action:'query'})
        if(alive.current&&result?.ok){
          setView(result.data)
          if(previousPhase!==undefined&&previousPhase!==result.data?.phase)changed.current()
          previousPhase=result.data?.phase
        }
      } finally {polling=false}
    }
    void poll().catch(()=>{})
    const timer=setInterval(()=>void poll().catch(()=>{}),1000)
    return()=>{alive.current=false;clearInterval(timer)}
  },[projectId])
  const action=async(action:AssistedAcceptanceInput['action'])=>{
    if(!view)return
    setPending(true);setError('')
    try{
      const api=window.electronAPI?.projectDeliverables
      if(!api?.assistedAcceptance)throw Error('请重启 Bloma 加载实测接口。')
      const result=await api.assistedAcceptance({
        request_id:crypto.randomUUID(),project_id:projectId,action,candidate_id:view.candidate_id,
        attempt_id:view.attempt_id,...(action==='capture'?{device:Number(device)}:{}),...(action==='feedback'?{accepted:true}:{})})
      if(!alive.current)return
      if(result.ok){setView(result.data);onChanged()}
      else setError(result.error.user_visible_message || result.error.message)
    }catch(error){if(alive.current)setError(String(error))}
    finally{if(alive.current)setPending(false)}
  }
  if(!view)return null
  const active=['preparing','ready','recording','decoding','verifying'].includes(view.phase)
  return <section aria-label="继续验收" className="assisted-acceptance">
    <button className="assisted-toggle" type="button" onClick={()=>setOpened(!opened)} aria-expanded={opened}>继续验收 <span aria-hidden="true">{opened?'⌃':'⌄'}</span></button>
    {opened&&<div className="assisted-content">
      <h3>麦克风实测</h3>
      <p>本次录音 8 秒，用于核对设备采集和当前程序的语音识别入口。原始录音只在内存中处理。</p>
      <p role="status" className={'assisted-status assisted-status-'+view.phase}>{view.phase==='recording'&&<strong>● 录音中　</strong>}{view.detail}</p>
      {view.phase==='recording'&&<div>
        <p>剩余 {view.remaining_seconds??8} 秒，请保持平时的音量。</p>
        <label>实时输入音量<meter min={0} max={1} value={Math.min(1,Math.sqrt(Math.max(0,view.level??0))*4)} /></label>
      </div>}
      {view.observation&&<div>
        {view.observation.device_name&&<p>本次设备：{view.observation.device_name}</p>}
        <p>实际转写：{view.observation.text || '（没有识别到文字）'}</p>
        {view.observation.rms!==undefined&&<p>输入音量：{view.observation.rms<.001?'很低，请检查设备': '已检测到声音'}</p>}
      </div>}
      {error&&<p role="alert">{error}</p>}
      {view.phase==='ready'&&<>
        <label>麦克风<select value={device} onChange={event=>setDevice(event.target.value)}>
          <option value="">请选择设备</option>
          {view.devices?.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}
        </select></label>
        <p className="assisted-phrase">请用平时的音量读：<strong>我们下周四下午三点开会。</strong></p>
      </>}
      <div className="assisted-actions">
        {view.phase==='failed'&&view.can_confirm&&<button className="assisted-primary" disabled={pending} onClick={()=>void action('feedback')}>转写符合我刚才说的内容</button>}
        {view.phase==='ready'&&<button className="assisted-primary" disabled={pending||device===''} onClick={()=>void action('capture')}>开始录音</button>}
        {!active&&!['passed','stale'].includes(view.phase)&&<button className={view.can_confirm?'':'assisted-primary'} disabled={pending} onClick={()=>void action('start')}>准备麦克风测试</button>}
        {!active&&view.phase!=='stale'&&<button disabled={pending} onClick={()=>void action('open')}>打开这个版本试用</button>}
        {active&&<button disabled={pending} onClick={()=>void action('cancel')}>取消测试</button>}
      </div>
      <details><summary>测试版本与范围</summary><p>候选 {view.candidate_id.slice(0,12)}。本项验证设备采集与识别入口；成品内录音按钮和实际播放体验需要各自的检查证据。</p></details>
    </div>}
  </section>
}
