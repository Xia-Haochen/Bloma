// Evaluator-only relay: secrets remain in this process; every paid request uses
// the existing, explicitly selected monetary ledger without resetting it.
const {app,safeStorage}=require('electron')
const fs=require('node:fs'),path=require('node:path'),http=require('node:http')
for(const name of ['REFERENCE_LIVE_OUT','REFERENCE_CHANNELS','REFERENCE_PROFILE','REFERENCE_BUDGET_MODULE','BLOMA_MONETARY_POLICY'])if(!process.env[name])throw Error('Missing '+name)
const out=path.resolve(process.env.REFERENCE_LIVE_OUT)
fs.mkdirSync(out,{recursive:true})
app.setPath('userData',process.env.REFERENCE_PROFILE)
const {readMonetaryBudget,fetchWithMonetaryBudget}=require(process.env.REFERENCE_BUDGET_MODULE)
let server,count=0
app.whenReady().then(async()=>{
  const before=readMonetaryBudget(process.env.BLOMA_MONETARY_POLICY)
  const channel=JSON.parse(fs.readFileSync(process.env.REFERENCE_CHANNELS,'utf8')).channels.find(row=>row.enabled&&new URL(row.base_url).host==='api.deepseek.com')
  if(!channel)throw Error('No enabled DeepSeek channel')
  const key=safeStorage.decryptString(Buffer.from(channel.api_key,'hex'))
  const balanceResponse=await fetch('https://api.deepseek.com/user/balance',{headers:{authorization:'Bearer '+key},signal:AbortSignal.timeout(20000)})
  if(!balanceResponse.ok)throw Error('Balance check failed '+balanceResponse.status)
  const balance=await balanceResponse.json()
  fs.writeFileSync(path.join(out,'preflight.json'),JSON.stringify({at:new Date().toISOString(),channel_id:channel.id,provider:'https://api.deepseek.com',model:'deepseek-flash',thinking:'enabled',effort:'high',max_tokens:4096,maximum_calls:8,budget_before:before,balance},null,2))
  if(!balance.is_available||!before.some(row=>row.model==='deepseek-flash'&&row.remaining_rmb>2.13))throw Error('Insufficient spendable reserve')
  server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json')
    try{
      if(req.url!=='/v1/chat/completions'||req.method!=='POST'){res.writeHead(404);res.end('{}');return}
      if(req.headers.authorization!=='Bearer reference-live-session'){res.writeHead(401);res.end('{}');return}
      if(++count>8)throw Error('Calibration call limit reached')
      let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)throw Error('Input too large')}
      const input=JSON.parse(body)
      if(input.model!=='deepseek-flash'||input.reasoning_effort!=='high'||input.thinking?.type!=='enabled'||input.max_tokens!==4096)throw Error('Model configuration mismatch')
      const response=await fetchWithMonetaryBudget('https://api.deepseek.com/v1/chat/completions',{
        method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body,signal:AbortSignal.timeout(90000)})
      const result=await response.json()
      fs.appendFileSync(path.join(out,'requests.jsonl'),JSON.stringify({sequence:count,at:new Date().toISOString(),status:response.status,request:input,response:result})+'\n')
      fs.writeFileSync(path.join(out,'budget-after.json'),JSON.stringify(readMonetaryBudget(process.env.BLOMA_MONETARY_POLICY),null,2))
      res.writeHead(response.status);res.end(JSON.stringify(result))
    }catch(error){res.writeHead(502);res.end(JSON.stringify({error:{message:error.message}}))}
  })
  await new Promise(done=>server.listen(0,'127.0.0.1',done))
  fs.writeFileSync(path.join(out,'endpoint.json'),JSON.stringify({base_url:'http://127.0.0.1:'+server.address().port+'/v1',model:'deepseek-flash',test_key:'reference-live-session'},null,2))
  console.log('Live reference relay ready; monetary ledger retained')
}).catch(error=>{console.error(error.message);app.exit(1)})
app.on('before-quit',()=>server?.close())
