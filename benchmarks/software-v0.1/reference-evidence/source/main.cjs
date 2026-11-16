const {app,BrowserWindow,ipcMain,safeStorage}=require('electron')
const fs=require('node:fs')
const path=require('node:path')
const equipment=require('./equipment.cjs')
const mode=process.env.REFERENCE_MODE||'equipment'
const moduleForMode=mode==='equipment'?equipment:require('./'+mode+'.cjs')
const data=process.env.APP_DATA_DIR
if(!data)throw Error('APP_DATA_DIR required')
fs.mkdirSync(data,{recursive:true})
const stateFile=path.join(data,'state.json')
app.setPath('userData',path.join(data,'electron'))
let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):moduleForMode.initial()
let pending
function save(next=state){
  const temp=stateFile+'.tmp'
  fs.writeFileSync(temp,JSON.stringify(next))
  fs.renameSync(temp,stateFile);state=next
}
app.whenReady().then(()=>{
  const ctx={state:()=>state,save,data,
    publicState:()=>({...state,config:state.config?{...state.config,encryptedKey:undefined,hasKey:!!state.config.encryptedKey}:undefined}),
    request:async(messages)=>{
      const config=state.config
      if(!config?.encryptedKey)throw Error('请先保存服务配置')
      const key=safeStorage.decryptString(Buffer.from(config.encryptedKey,'base64'))
      const response=await fetch(config.endpoint.replace(/\/$/,'')+'/chat/completions',{
        method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},
        body:JSON.stringify({model:config.model,messages,thinking:{type:'enabled'},reasoning_effort:'high',max_tokens:4096}),
        signal:AbortSignal.timeout(90000)})
      if(!response.ok)throw Error(response.status===401?'鉴权失败 (401)':response.status===503?'服务暂时不可用 (503)':'服务错误 '+response.status)
      const result=await response.json(),text=result.choices?.[0]?.message?.content
      if(!text)throw Error('服务未返回文本')
      return text
    }}
  const handler=mode==='equipment'?null:moduleForMode.create(ctx)
  ipcMain.handle('reference:action',async(_event,action,input={})=>{
    try{
      let result
      if(action==='settings'){
        const previous=state.config||{}
        if(!/^https?:\/\//.test(input.endpoint)||!input.model)throw Error('服务地址或模型无效')
        if(!safeStorage.isEncryptionAvailable())throw Error('系统密钥保护不可用')
        state.config={endpoint:input.endpoint,model:input.model,role:input.role||'中文助手',
          encryptedKey:input.key?safeStorage.encryptString(input.key).toString('base64'):previous.encryptedKey}
        save();return {ok:true,result:ctx.publicState()}
      }
      if(handler)result=await handler(action,input)
      else if(action==='read')result=equipment.summary(state,input.date)
      else if(action==='preview'){
        pending=undefined
        pending=equipment.importRows(state,input.files)
        result={preview:equipment.summary(pending)}
      }else if(action==='cancel'){pending=undefined;result={cancelled:true}}
      else if(action==='commit'){if(!pending)throw Error('没有有效导入');save(pending);pending=undefined;result=equipment.summary(state)}
      else if(action==='export'){result={name:'equipment-backup.csv',text:equipment.backup(state)}}
      else{save(equipment.execute(state,action,input));result=equipment.summary(state)}
      if(action==='export'){
        const target=path.join(data,'exports');fs.mkdirSync(target,{recursive:true})
        result.file=path.join(target,result.name);fs.writeFileSync(result.file,result.text)
      }
      return {ok:true,result}
    }catch(error){return {ok:false,error:error.message}}
  })
  const window=new BrowserWindow({width:980,height:760,webPreferences:{preload:path.join(__dirname,'preload.cjs')}})
  window.loadFile(path.join(__dirname,mode+'.html'))
})
app.on('window-all-closed',()=>app.quit())
