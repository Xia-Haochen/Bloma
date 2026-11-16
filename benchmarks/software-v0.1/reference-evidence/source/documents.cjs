const path=require('node:path')
const run=require('./process.cjs')
const {stringify}=require('./csv.cjs')
const initial=()=>({documents:[],tasks:[],config:{},importErrors:[]})
module.exports={initial,create(ctx){
  let processing=false
  // A process exit must never silently convert an in-flight task into success.
  for(const task of ctx.state().tasks)if(['running','queued'].includes(task.status)){task.status='failed';task.error='上次运行中断，请重试'}
  ctx.save()
  async function pump(){
    if(processing)return
    processing=true
    try{
      let task
      while((task=ctx.state().tasks.find(row=>row.status==='queued'))){
        task.status='running';ctx.save()
        try{
          const content=task.files.map(name=>{
            const doc=ctx.state().documents.find(doc=>doc.name===name)
            return name+'\n'+doc.lines.map(line=>line.location+' '+line.text).join('\n')
          }).join('\n\n')
          task.result=await ctx.request([{role:'system',content:'请仅根据给出的资料生成中文摘要，保留关键事实与来源名称；未提供的事实不得补充。'},{role:'user',content}])
          task.status='completed';task.error=''
        }catch(error){task.status='failed';task.error=error.message}
        ctx.save()
      }
    }finally{processing=false}
  }
  return async function(action,input){
    const state=ctx.state()
    if(action==='read')return ctx.publicState()
    if(action==='import'){
      state.importErrors=[]
      for(const file of input.files){
        try{
          if(!/\.(txt|md|pdf)$/i.test(file.name))throw Error('不支持的文件类型')
          const lines=await run(process.env.REFERENCE_DOCUMENT_PYTHON||'python',path.join(__dirname,'documents.py'),file)
          state.documents=state.documents.filter(row=>row.name!==file.name)
          state.documents.push({name:file.name,lines})
        }catch(error){
          const message=/UnicodeDecodeError|不支持的编码|UTF-8/.test(error.message)?'不支持的文本编码，请使用 UTF-8':
            /Pdf|PDF|EOF|Stream has ended/.test(error.message)?'PDF文件损坏，无法读取文本':'读取失败：'+error.message
          state.importErrors.push({name:file.name,error:message})
        }
      }
      ctx.save();return ctx.publicState()
    }
    if(action==='queue'){
      const selected=input.files
      if(!selected?.length||selected.some(name=>!state.documents.some(doc=>doc.name===name)))throw Error('请选择有效文档')
      for(const files of (input.aggregate?[selected]:selected.map(name=>[name])))state.tasks.push({id:'T'+(state.tasks.length+1),files,status:'queued',result:'',error:''})
      ctx.save();void pump();return ctx.publicState()
    }
    if(action==='cancel'||action==='retry'){
      const task=state.tasks.find(row=>row.id===input.id)
      if(!task)throw Error('任务不存在')
      if(action==='cancel'){
        if(task.status!=='queued')throw Error('只能取消尚未开始的任务')
        task.status='cancelled'
      }else{
        if(task.status!=='failed')throw Error('只能重试失败任务')
        task.status='queued';task.error=''
      }
      ctx.save();if(action==='retry')void pump();return ctx.publicState()
    }
    if(action==='export'){
      const tasks=state.tasks.filter(task=>!input.ids?.length||input.ids.includes(task.id))
      const rows=tasks.map(task=>[task.id,task.files.join(';'),task.status,task.status==='completed'?task.result:task.error])
      return {name:'results.'+input.format,text:input.format==='csv'?stringify([['id','sources','status','result'],...rows]):
        rows.map(([id,files,status,result])=>'## '+id+'\n\n来源：'+files+'\n\n状态：'+status+'\n\n'+result).join('\n\n')}
    }
    throw Error('未知操作')
  }
}}
