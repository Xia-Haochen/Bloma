let current,selection=new Set()
function render(state){
  current=state
  $('import-errors').textContent=state.importErrors.map(row=>row.name+'：'+row.error).join('\n')
  $('documents').replaceChildren()
  for(const doc of state.documents){
    const label=document.createElement('label'),box=document.createElement('input')
    box.type='checkbox';box.value=doc.name;box.checked=selection.has(doc.name)
    box.onchange=()=>box.checked?selection.add(doc.name):selection.delete(doc.name)
    label.append(box,document.createTextNode(doc.name));$('documents').append(label)
  }
  $('tasks').replaceChildren()
  for(const task of state.tasks){
    const article=document.createElement('article');article.dataset.id=task.id;article.dataset.state=task.status
    const title=document.createElement('div');title.textContent=task.id+' | '+task.files.join('、')+' | '+task.status
    const pre=document.createElement('pre');pre.textContent=task.result||task.error
    article.append(title,pre)
    for(const [action,text]of [['cancel','取消'],['retry','重试']]){
      const button=document.createElement('button');button.textContent=text;button.dataset.action=action
      button.disabled=task.status!==(action==='cancel'?'queued':'failed')
      button.onclick=()=>call(action,{id:task.id}).then(render).catch(error);article.append(button)
    }
    $('tasks').append(article)
  }
}
$('import').onclick=async()=>{try{render(await call('import',{files:await filesFrom($('files'))}))}catch(e){error(e)}}
$('search').onclick=()=>{
  $('search-results').replaceChildren()
  for(const doc of current.documents)for(const line of doc.lines){
    if(!$('query').value||!line.text.includes($('query').value))continue
    const li=document.createElement('li'),button=document.createElement('button')
    Object.assign(li.dataset,{file:doc.name,location:line.location,text:line.text})
    button.textContent=doc.name+' '+line.location+' '+line.text
    button.onclick=()=>{$('source').textContent=doc.name+'\n'+doc.lines.map(row=>row.location+' '+row.text).join('\n')}
    li.append(button);$('search-results').append(li)
  }
}
$('clear').onclick=()=>{$('query').value='';$('search-results').replaceChildren();$('source').textContent=''}
for(const action of ['queue','aggregate'])$(action).onclick=()=>call('queue',{files:[...selection],aggregate:action==='aggregate'}).then(render).catch(error)
for(const format of ['md','csv'])$('export-'+format).onclick=()=>call('export',{format}).then(download).catch(error)
call('read').then(state=>{settings(state.config);render(state)}).catch(error)
setInterval(async()=>{try{const answer=await window.reference.action('read');if(answer.ok)render(answer.result)}catch{}},300)
