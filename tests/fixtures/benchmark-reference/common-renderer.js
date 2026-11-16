const $=id=>document.getElementById(id)
async function call(action,input={}) {
  const answer=await window.reference.action(action,input)
  $('status').textContent=answer.ok?'操作成功':answer.error
  $('status').dataset.ok=String(answer.ok)
  if(!answer.ok)throw Error(answer.error)
  return answer.result
}
async function filesFrom(input){
  const files=[]
  for(const file of input.files){
    const bytes=new Uint8Array(await file.arrayBuffer())
    let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte)
    files.push({name:file.webkitRelativePath||file.name,data:btoa(binary)})
  }
  return files
}
function download(result){
  $('status').textContent='已导出：'+result.file
  $('status').dataset.export=result.file
}
function settings(config){
  for(const name of ['endpoint','model','role'])if($(name))$(name).value=config?.[name]||''
  $('key').placeholder=config?.hasKey?'密钥已保存；留空保持':'输入密钥'
}
function error(error){$('status').textContent=error.message;$('status').dataset.ok='false'}
$('save-settings').onclick=()=>call('settings',Object.fromEntries(['endpoint','model','key','role'].filter(name=>$(name)).map(name=>[name,$(name).value]))).then(()=>{$('key').value='';$('key').placeholder='密钥已保存；留空保持'}).catch(error)
