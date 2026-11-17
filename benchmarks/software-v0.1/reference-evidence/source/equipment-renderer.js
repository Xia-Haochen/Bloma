const status=document.querySelector('#status')
function table(id,rows,fields){
  const node=document.querySelector(id);node.replaceChildren()
  const table=document.createElement('table'),head=document.createElement('tr')
  for(const key of fields){const cell=document.createElement('th');cell.textContent=key;head.appendChild(cell)}
  table.appendChild(head)
  for(const row of rows){const tr=document.createElement('tr');for(const key of fields){const td=document.createElement('td');td.textContent=row[key];tr.appendChild(td)}table.appendChild(tr)}
  node.appendChild(table)
}
function show(value){
  table('#members',value.members,['id','name'])
  table('#inventory',value.equipment,['id','name','total','outstanding','available'])
  table('#loans',value.loans,['id','member','equipment','quantity','returned','due'])
  table('#overdue',value.overdue,['member','equipment','quantity','returned','due'])
  const member=document.querySelector('#filter-member').value
  table('#outstanding',value.loans.filter(row=>(!member||row.member===member)&&row.quantity>row.returned).map(row=>({...row,outstanding:row.quantity-row.returned})),['member','equipment','outstanding','due'])
  window.lastObserved=value
}
async function call(action,input={}){
  const answer=await window.reference.action(action,input)
  status.textContent=answer.ok?'操作成功':answer.error
  status.dataset.ok=String(answer.ok)
  if(answer.result?.equipment)show(answer.result)
  return answer
}
for(const action of ['borrow','return','rename','add-member','rename-member','add-equipment'])document.querySelector('#'+action).onclick=()=>call(action,
  Object.fromEntries(['equipment','member','quantity','due','name'].map(id=>[id,document.querySelector('#'+id).value])))
document.querySelector('#refresh').onclick=()=>call('read',{date:document.querySelector('#date').value})
document.querySelector('#cancel').onclick=()=>call('cancel')
document.querySelector('#filter').onclick=()=>{
  show(window.lastObserved)
}
document.querySelector('#commit').onclick=()=>call('commit')
document.querySelector('#preview').onclick=async()=>{
  const files=[]
  for(const file of document.querySelector('#files').files){
    const bytes=new Uint8Array(await file.arrayBuffer())
    let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte)
    files.push({name:file.name,data:btoa(binary)})
  }
  const answer=await call('preview',{files})
  if(answer.ok)status.textContent='导入检查通过，请确认或取消'
}
document.querySelector('#export').onclick=async()=>{
  const answer=await call('export')
  if(answer.ok){status.textContent='已导出：'+answer.result.file;status.dataset.export=answer.result.file}
}
call('read')
