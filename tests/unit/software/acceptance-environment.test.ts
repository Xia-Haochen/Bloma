import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { prepareAcceptanceEnvironment } from '../../../main/software/acceptance-environment'
import { observeSoftwareGui } from '../../../main/software/gui-observer'
import type { GuiAcceptanceSuite } from '../../../main/desktop/gui-acceptance'
import { verificationFailure } from '../../../main/software/verification-diagnostics'
import type { Page } from 'playwright'
import { freezeNativeGuiTests } from '../../../main/software/native-gui-tests'
import { runNativeGuiTests } from '../../../main/software/native-gui-observer'

let home:string,previous:string|undefined,project:ReturnType<typeof createProject>,port:number
const settings={endpoint:'#service',model:'#model',api_key:'#key',save:'#configure',ready:{selector:'#ready',contains:'saved'}}
const spec=(protocol='openai-chat')=>({runtime:'node',module:'client.cjs',factory:'Client',method:'run',protocol,covers:['F-001'],settings})
beforeEach(async()=>{
  previous=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-acceptance-env-'));process.env.PROMA_HOME=home
  project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})
  const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()))
  writeFileSync(join(project.root_path,'CORE_CHECK.json'),JSON.stringify({llm:spec()}))
  writeFileSync(join(project.root_path,'server.cjs'),`
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const file=path.join(process.env.APP_DATA_DIR,'settings.json');fs.mkdirSync(process.env.APP_DATA_DIR,{recursive:true});
let config=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):null;
http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;
try{
 if(req.url==='/configure'){config=JSON.parse(body);fs.writeFileSync(file,body);res.end('{}');return}
 if(req.url==='/reply'){const value=JSON.parse(body);const r=await fetch(config.endpoint+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.key},body:JSON.stringify({model:config.model,messages:[{role:'user',content:value.text}]})});res.end(JSON.stringify(await r.json()));return}
 res.setHeader('Content-Type','text/html');res.end(fs.readFileSync('index.html'));
}catch{res.statusCode=400;res.end('{}')}}).listen(${port},'127.0.0.1');`)
  writeFileSync(join(project.root_path,'index.html'),`<input id="service"><input id="model"><input id="key" type="password"><button id="configure">Configure</button><p id="ready"></p><input id="say"><button id="send">Send</button><output id="reply"></output><script>
const el=id=>document.getElementById(id);el('reply').textContent=localStorage.getItem('reply')||'';
el('configure').onclick=async()=>{await fetch('/configure',{method:'POST',body:JSON.stringify({endpoint:el('service').value,model:el('model').value,key:el('key').value})});el('ready').textContent='saved'};
el('send').onclick=async()=>{const r=await(await fetch('/reply',{method:'POST',body:JSON.stringify({text:el('say').value})})).json();el('reply').textContent=r.choices?.[0]?.message.content||'missing';localStorage.setItem('reply',el('reply').textContent)};</script>`)
})
afterEach(()=>{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const prepare=(signal?:AbortSignal)=>prepareAcceptanceEnvironment({root:project.root_path,features:['F-001'],requiresLlm:true,signal})
const suite=():GuiAcceptanceSuite=>({version:1,scope_hash:'a'.repeat(64),covers:['F-001'],steps:[
  {id:'input',kind:'fill',selector:'#say',value:'first input'}, {id:'send',kind:'click',selector:'#send'},
  {id:'reply',kind:'expect',selector:'#reply',nonempty:true},
]})
const observe=(environment:Awaited<ReturnType<typeof prepare>>,rules=suite(),signal?:AbortSignal)=>observeSoftwareGui({projectId:project.project_id,root:project.root_path,
  launch:{schema_version:2,ui:'browser',command:['node','server.cjs'],url:'http://127.0.0.1:'+port},suite:rules,temporary:join(home,'case'),environment,signal:signal??AbortSignal.timeout(30000),purpose:'acceptance',comparisons:{reopened:'reply'}})

it.each([false, true])('restores the normal entry and keeps service across restart (fixed model %s)', async (fixedModel) => {
  const root = project.root_path
  const app = join(root, 'index.html')
  const html = readFileSync(app, 'utf8')
  let entry = html
    .replace('<input id="service">', '<button id="settings">Settings</button><section id="panel" hidden><input id="service">')
    .replace('<input id="say">', '</section><input id="say">')
    .replace("el('configure').onclick", "el('settings').onclick=()=>{el('panel').hidden=false;el('say').hidden=true;el('send').hidden=true};el('configure').onclick")
  const binding = { ...settings, open: '#settings', notes: 'extra settings metadata' } as Record<string, unknown>
  if (fixedModel) {
    delete binding.model
    entry = entry.replace('<input id="model">', '').replace("el('model').value", "'deepseek-flash'")
  }
  writeFileSync(app, entry)
  writeFileSync(join(root, 'CORE_CHECK.json'), JSON.stringify({ llm: { ...spec(), covers: undefined, settings: binding } }))
  mkdirSync(join(root,'tests'))
  writeFileSync(join(root,'tests/acceptance.mjs'), `export default async ({test,page,expect,phase}) => {
    const run=async()=> {
      await page.locator('#say').fill('acceptance voice text');
      await page.locator('#send').click();
      await expect(page.locator('#reply')).toContainText('验收服务回复');
    };
    if(phase==='reopened') { await test('F-001 same service after reopen',async()=>{await run()}); return; }
    await test('F-001 host service before first input',async()=>{await run()});
  }`)
  const launch = {schema_version:2 as const,ui:'browser' as const,command:['node','server.cjs'],url:'http://127.0.0.1:'+port}
  writeFileSync(join(root,'LAUNCH.json'),JSON.stringify(launch))
  const native_tests=freezeNativeGuiTests(project.project_id,root,'tests/acceptance.mjs',['F-001'],true)
  const result=await runNativeGuiTests({projectId:project.project_id,root,launch,suite:{...suite(),steps:[],native_tests},signal:AbortSignal.timeout(45000)})
  expect(result.status,JSON.stringify(result)).toBe('passed')
  expect(result.environment).toMatchObject({mode:'controlled_service',external_model_effects:'unverified'})
  expect(result.environment.requests.filter(row=>row.phase==='case'&&row.valid)).toHaveLength(2)
},60000)

it('prepares through normal settings, keeps settings/data through restart, records actual traffic and closes its endpoint',async()=>{
  const env=await prepare(),rules=suite();rules.steps.push({id:'restart',kind:'restart'},{id:'reopened',kind:'expect',selector:'#reply',nonempty:true},
    {id:'second-input',kind:'fill',selector:'#say',value:'second input'},{id:'second-send',kind:'click',selector:'#send'},{id:'second-reply',kind:'expect',selector:'#reply',nonempty:true})
  let endpoint=''
  try{
    const result=await observe(env,rules);expect(result.status,JSON.stringify(result)).toBe('passed')
    const evidence=env.evidence();expect(evidence).toMatchObject({mode:'controlled_service',readiness:'ready',external_model_effects:'unverified'})
    expect(evidence.requests.filter(row=>row.phase==='case'&&row.valid)).toHaveLength(2)
    const config=JSON.parse(readFileSync(join(home,'case/data/settings.json'),'utf8'));endpoint=config.endpoint
    expect(JSON.stringify(evidence)).not.toContain(config.key)
    expect(JSON.stringify(evidence)).not.toContain('first input')
    expect(result.steps.find(row=>row.id==='reopened')?.actual).toBe(result.steps.find(row=>row.id==='reply')?.actual)
  } finally {await env.close();await env.close()}
  await expect(fetch(endpoint)).rejects.toThrow()
},45000)
it('does not accept a static nonempty reply without actually calling the prepared service',async()=>{
  const html=readFileSync(join(project.root_path,'index.html'),'utf8')
  writeFileSync(join(project.root_path,'index.html'),html.replace("const r=await(await fetch('/reply',{method:'POST',body:JSON.stringify({text:el('say').value})})).json();", "const r={choices:[{message:{content:'fabricated reply'}}]};"))
  const env=await prepare()
  try{const result=await observe(env);expect(result.status).toBe('unverified');expect(result.error).toContain('REQUEST_NOT_OBSERVED')}finally{await env.close()}
},35000)
it('allows fixed settings assertions alongside real controlled replies and preserves the selected model',async()=>{
  const file=join(project.root_path,'index.html')
  writeFileSync(file,readFileSync(file,'utf8').replace('<input id="model">','<input id="model" value="deepseek-flash">'))
  const env=await prepare(),rules=suite()
  rules.steps.unshift({id:'model-setting',kind:'expect',selector:'#model',property:'value',equals:'deepseek-flash'})
  try{const result=await observe(env,rules);expect(result.status,JSON.stringify(result)).toBe('passed')}
  finally{await env.close()}
},35000)
it('reports a fixed generated-reply mismatch as missing semantic evidence after observing a real request',async()=>{
  const env=await prepare(),rules=suite()
  rules.steps[2]={id:'reply',kind:'expect',selector:'#reply',equals:'a predetermined model reply'}
  try{
    const result=await observe(env,rules)
    expect(result.status).toBe('unverified')
    expect(result.error).toContain('EXTERNAL_ORACLE_REQUIRED')
    expect(env.evidence().requests.filter(row=>row.phase==='case')).toHaveLength(1)
  }finally{await env.close()}
},35000)
it('observes zero-request cancellation and rejects an actual request under that same expectation',async()=>{
  const make=()=>prepareAcceptanceEnvironment({root:project.root_path,features:['F-001'],requiresLlm:true,requestExpectation:'none'})
  const env=await make()
  try{
    const result=await observe(env,{...suite(),steps:[
      {id:'draft',kind:'fill',selector:'#say',value:'cancel this'},
      {id:'cancelled',kind:'fill',selector:'#say',value:''},
      {id:'empty',kind:'expect',selector:'#say',property:'value',equals:''}
    ]})
    expect(result.status,JSON.stringify(result)).toBe('passed')
    expect(env.evidence().requests).toEqual([])
  }finally{await env.close()}
  const wrong=await make()
  try{
    const result=await observe(wrong)
    expect(result.status).not.toBe('passed')
    expect(result.error).toContain('UNEXPECTED_REQUEST')
  }finally{await wrong.close()}
},60000)
it('blocks missing settings before executing a business case',async()=>{
  const llm=spec();delete (llm as {settings?:unknown}).settings;writeFileSync(join(project.root_path,'CORE_CHECK.json'),JSON.stringify({llm}))
  await expect(prepare()).rejects.toThrow('SETTINGS_REQUIRED')
  const diagnosis=verificationFailure({status:'unverified',summary:'environment',independent:{status:'unverified',case_results:[{id:'case',status:'unverified',kind:'environment',steps:[],error:'ACCEPTANCE_ENVIRONMENT_SETTINGS_REQUIRED'}]}} as never)
  expect(diagnosis?.category).toBe('environment');expect(diagnosis?.code).toBe('ACCEPTANCE_ENVIRONMENT_SETTINGS_REQUIRED')
  expect(diagnosis?.next_action).toEqual({tool:'read_production_context',arguments:{topic:'ai-service'}})
})
it('identifies the exact required field without requiring a model control', async () => {
  const llm = spec()
  writeFileSync(join(project.root_path, 'CORE_CHECK.json'), JSON.stringify({
    llm: { ...llm, settings: { ...settings, model: undefined, api_key: undefined } },
  }))
  await expect(prepare()).rejects.toThrow('CORE_CHECK.llm.settings.api_key')
  const failure = verificationFailure({ status: 'unverified', summary: '实际界面业务检查：ACCEPTANCE_ENVIRONMENT_SETTINGS_INVALID: CORE_CHECK.llm.settings.api_key' })
  expect(failure).toMatchObject({ category: 'environment', code: 'ACCEPTANCE_ENVIRONMENT_SETTINGS_INVALID',
    next_action: { tool: 'read_production_context', arguments: { topic: 'ai-service' } } })
})
it('marks failed setup as unverified without running frozen assertions or creating service observations',async()=>{
  writeFileSync(join(project.root_path,'CORE_CHECK.json'),JSON.stringify({llm:{...spec(),settings:{...settings,save:'#does-not-exist'}}}))
  const env=await prepare()
  try{const result=await observe(env);expect(result.status).toBe('unverified');expect(result.error).toContain('SETUP_FAILED');expect(result.steps).toEqual([]);expect(env.evidence().readiness).toBe('blocked')}finally{await env.close()}
},35000)
it('cancellation tears down the service lease and cannot produce passed evidence',async()=>{
  const controller=new AbortController(),env=await prepare(controller.signal)
  const result=observe(env,suite(),controller.signal);setTimeout(()=>controller.abort(),100)
  await expect(result).rejects.toThrow();await env.close()
  expect(env.evidence().requests).toEqual([])
},35000)
it.each(['openai-chat','anthropic-messages'])('isolates service credentials and teardown for %s leases',async protocol=>{
  writeFileSync(join(project.root_path,'CORE_CHECK.json'),JSON.stringify({llm:spec(protocol)}))
  const first=await prepare(),second=await prepare()
  const configure=async(env:typeof first)=>{
    const fields:Record<string,string>={}
    await env.prepare({url:()=> 'http://127.0.0.1/', locator:(selector:string)=>({isVisible:async()=>true,
      evaluate:async()=>({value:'',editable:true}),isEditable:async()=>true,fill:async(value:string)=>{fields[selector]=value},
      click:async()=>{},filter:()=>({waitFor:async()=>{}})})} as unknown as Page,0)
    return fields
  }
  try{
    const a=await configure(first),b=await configure(second)
    expect(a['#service']).not.toBe(b['#service']);expect(a['#key']).not.toBe(b['#key'])
    expect(first.evidence().instance_id).not.toBe(second.evidence().instance_id)
    const send=(fields:Record<string,string>,key=fields['#key'])=>fetch(fields['#service']+(protocol==='openai-chat'?'/chat/completions':'/messages'),{
      method:'POST',headers:{'Content-Type':'application/json',...(protocol==='openai-chat'?{Authorization:'Bearer '+key}:{'x-api-key':key,'anthropic-version':'2023-06-01'})},
      body:JSON.stringify({model:fields['#model'],messages:[{role:'user',content:'hello'}]})})
    expect((await send(b,a['#key'])).status).toBe(400)
    const response=await(await send(a)).json() as any
    first.assess([protocol==='openai-chat'?response.choices[0].message.content:response.content[0].text])
    await first.close()
    expect((await send(b)).status).toBe(200)
    expect(JSON.stringify(second.evidence())).not.toContain(b['#key'])
    expect(()=>second.assess(['fabricated'])).toThrow('REQUEST_INVALID')
  } finally {await first.close();await second.close()}
})
