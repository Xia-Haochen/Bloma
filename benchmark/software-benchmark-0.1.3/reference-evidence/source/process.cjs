const {spawn}=require('node:child_process')
module.exports=function run(python,script,input,env={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(python,[script],{env:{...process.env,PYTHONIOENCODING:'utf-8',...env},windowsHide:true})
    let output='',error=''
    const timer=setTimeout(()=>{child.kill();reject(Error('处理超时'))},120000)
    child.stdout.on('data',chunk=>output+=chunk)
    child.stderr.on('data',chunk=>error+=chunk)
    child.on('error',e=>{clearTimeout(timer);reject(e)})
    child.on('close',code=>{
      clearTimeout(timer)
      if(code!==0)return reject(Error(error.trim().split('\n').at(-1)||'处理失败'))
      try{resolve(JSON.parse(output.trim().split('\n').at(-1)))}catch(e){reject(Error('处理结果无效 '+output.slice(-200)))}
    })
    child.stdin.end(JSON.stringify(input))
  })
}
