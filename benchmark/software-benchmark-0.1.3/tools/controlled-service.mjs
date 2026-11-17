import http from 'node:http'
import {mkdirSync,existsSync,readFileSync,writeFileSync,appendFileSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {pathToFileURL} from 'node:url'

export async function startService(directory,port=0) {
  mkdirSync(directory,{recursive:true})
  const controlFile=join(directory,'control.json')
  if(!existsSync(controlFile))writeFileSync(controlFile,JSON.stringify({fail_next:0,delay_ms:0,auth_key:'benchmark-test-key'},null,2))
  let sequence=0
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json; charset=utf-8')
    res.setHeader('access-control-allow-origin','*')
    res.setHeader('access-control-allow-headers','authorization,content-type')
    if(req.method==='OPTIONS'){res.end();return}
    if(req.url==='/health'){res.end('{"ok":true}');return}
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){res.writeHead(404);res.end('{"error":{"message":"not found"}}');return}
    let body=''
    for await(const chunk of req){
      body+=chunk
      if(body.length>2_000_000){res.writeHead(413);res.end();return}
    }
    let input,control
    try{input=JSON.parse(body);control=JSON.parse(readFileSync(controlFile,'utf8'))}
    catch{res.writeHead(400);res.end('{"error":{"message":"invalid json"}}');return}
    const id=++sequence
    const messages=Array.isArray(input.messages)?input.messages:[]
    let status=200
    if(req.headers.authorization!=='Bearer '+control.auth_key)status=401
    else if(control.fail_next>0){
      status=503;control.fail_next--;writeFileSync(controlFile,JSON.stringify(control,null,2))
    }
    appendFileSync(join(directory,'requests.jsonl'),JSON.stringify({id,at:new Date().toISOString(),status,
      model:input.model,messages})+'\n')
    if(status!==200){res.writeHead(status);res.end(JSON.stringify({error:{message:status===401?'invalid test credential':'temporary test service failure'}}));return}
    const delay=Math.min(10000,Math.max(0,Number(control.delay_ms)||0))
    await new Promise(done=>setTimeout(done,delay))
    const current=messages.filter(m=>m.role==='user').at(-1)?.content??''
    const text='收到本轮内容：'+String(current).slice(0,160)+'。此前用户轮次：'+Math.max(0,messages.filter(m=>m.role==='user').length-1)+'。'
    if(input.stream){
      res.setHeader('content-type','text/event-stream')
      res.write('data: '+JSON.stringify({id:'bench-'+id,object:'chat.completion.chunk',choices:[{index:0,delta:{content:text},finish_reason:null}]})+'\n\n')
      res.end('data: '+JSON.stringify({id:'bench-'+id,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')
    }else res.end(JSON.stringify({id:'bench-'+id,object:'chat.completion',model:'benchmark-model',
      choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}))
  })
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',done)})
  const endpoint={base_url:'http://127.0.0.1:'+server.address().port+'/v1',model:'benchmark-model',test_key:'benchmark-test-key'}
  writeFileSync(join(directory,'endpoint.json'),JSON.stringify(endpoint,null,2))
  return {server,endpoint}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {endpoint}=await startService(resolve(process.argv[2]??'results/service'),Number(process.argv[3]??0))
  console.log(JSON.stringify(endpoint))
}
