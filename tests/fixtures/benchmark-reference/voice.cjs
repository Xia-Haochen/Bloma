const fs=require('node:fs'),path=require('node:path')
const run=require('./process.cjs')
const initial=()=>({config:{},messages:[],playback:[]})
module.exports={initial,create(ctx){
  let busy=false
  const python=(input)=>run(process.env.REFERENCE_VOICE_PYTHON,path.join(__dirname,'voice.py'),input)
  return async function(action,input){
    const state=ctx.state()
    if(action==='read')return ctx.publicState()
    if(action==='reset'){if(busy)throw Error('请等待当前轮完成');state.messages=[];state.playback=[];ctx.save();return ctx.publicState()}
    if(action==='transcribe'){
      const file=path.join(ctx.data,'input.wav');fs.writeFileSync(file,Buffer.from(input.data,'base64'))
      return python({action:'asr',file})
    }
    if(action==='send'){
      if(busy)throw Error('上一轮仍在处理')
      if(!input.text?.trim())throw Error('没有有效语音')
      busy=true
      try{
        const user={role:'user',content:input.text}
        const text=await ctx.request([{role:'system',content:state.config.role||'中文助手'},...state.messages,user])
        state.messages.push(user,{role:'assistant',content:text})
        ctx.save()
        const file=path.join(ctx.data,'reply-'+state.messages.length+'.wav')
        const audio=await python({action:'tts',text,file})
        return {...ctx.publicState(),audio:{data:fs.readFileSync(file).toString('base64'),duration:audio.duration,text}}
      }finally{busy=false}
    }
    if(action==='playback'){state.playback.push(input);ctx.save();return {saved:true}}
    throw Error('未知操作')
  }
}}
