let queue=Promise.resolve(),capture
function render(state){
  $('history').replaceChildren()
  for(const message of state.messages){
    const article=document.createElement('article');article.dataset.role=message.role
    article.textContent=(message.role==='user'?'我：':'助手：')+message.content
    $('history').append(article)
  }
}
function enqueue(file){
  queue=queue.then(async()=>{
    $('phase').textContent='转写中'
    const {text}=await call('transcribe',file)
    if(!text.trim()){$('phase').textContent='没有检测到语音';return}
    $('phase').textContent='等待回复和合成语音'
    const state=await call('send',{text});render(state)
    const audio=$('audio')
    audio.src='data:audio/wav;base64,'+state.audio.data
    const start=Date.now()
    $('phase').textContent='播放中'
    const result=await new Promise((resolve,reject)=>{
      audio.onended=()=>resolve({text:state.audio.text,duration:audio.duration,
        played_seconds:audio.currentTime,elapsed_seconds:(Date.now()-start)/1000,
        muted:audio.muted||audio.volume===0,ended:true})
      audio.onerror=()=>reject(Error('音频播放失败'))
      audio.play().catch(reject)
    })
    await call('playback',result)
    $('phase').textContent='本轮完成'
  }).catch(e=>{error(e);$('phase').textContent='本轮失败，可重试'})
}
$('import').onclick=async()=>{try{const files=await filesFrom($('files'));if(files[0])enqueue(files[0])}catch(e){error(e)}}
$('reset').onclick=()=>queue.then(()=>call('reset')).then(render).catch(error)
function wav(chunks,rate){
  const samples=chunks.reduce((n,chunk)=>n+chunk.length,0),buffer=new ArrayBuffer(44+samples*2),view=new DataView(buffer)
  function text(offset,text){for(let i=0;i<text.length;i++)view.setUint8(offset+i,text.charCodeAt(i))}
  text(0,'RIFF');view.setUint32(4,36+samples*2,true);text(8,'WAVE');text(12,'fmt ')
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true)
  view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true)
  text(36,'data');view.setUint32(40,samples*2,true)
  let offset=44
  for(const chunk of chunks)for(const value of chunk){view.setInt16(offset,Math.max(-1,Math.min(1,value))*32767,true);offset+=2}
  let binary='';for(const byte of new Uint8Array(buffer))binary+=String.fromCharCode(byte)
  return {name:'microphone.wav',data:btoa(binary)}
}
$('record').onclick=async()=>{
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true})
    const context=new AudioContext(),source=context.createMediaStreamSource(stream),processor=context.createScriptProcessor(4096,1,1),mute=context.createGain()
    mute.gain.value=0
    const chunks=[]
    processor.onaudioprocess=event=>chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
    source.connect(processor);processor.connect(mute);mute.connect(context.destination)
    capture={stream,context,processor,chunks}
    $('record').disabled=true;$('stop').disabled=false;$('cancel').disabled=false;$('phase').textContent='录音中'
  }catch(e){error(e)}
}
async function finish(cancel){
  if(!capture)return
  const {stream,context,processor,chunks}=capture;capture=null
  processor.disconnect();stream.getTracks().forEach(track=>track.stop());await context.close()
  $('record').disabled=false;$('stop').disabled=true;$('cancel').disabled=true
  if(cancel)$('phase').textContent='已取消录音'
  else enqueue(wav(chunks,context.sampleRate))
}
$('stop').onclick=()=>finish(false).catch(error)
$('cancel').onclick=()=>finish(true).catch(error)
call('read').then(state=>{settings(state.config);render(state)}).catch(error)
