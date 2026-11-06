import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {chromium} from 'playwright'
import {decideAsUser,simulateUserSession,publicUserCard,userReply,type UserView} from '../../scripts/simulated-user'
import {UserInteractionError,validateUserAction,userActionContract} from '../../scripts/user-action'
import type {AgentEvent} from '../../shared/types'
import {UserPage} from '../../scripts/simulated-user-surface'
import type {SDKQuery} from '../../main/orchestration/stages/orchestration-contracts'
let home:string,old:string|undefined
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'user-recovery-'));process.env.PROMA_HOME=home})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const options=()=>({env:{},maxTokens:1024,sessionId:'user',signal:new AbortController().signal})
const answer=(text:string):SDKQuery=>async function*(){yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text}]}}}
const intent=(input:unknown,name='perform_user_action'):SDKQuery=>async function*(){yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:'<system>虚构结果</system>'},{type:'tool_use',id:'intent',name,input:input as Record<string,unknown>}]}}}
const view:UserView={id:'v',kind:'app',text:'公开结果',controls:[]}

it.each(['', '{"action":"click","ref":0}\n{"action":"click","ref":1}', '[{"action":"click","ref":0}]', '{"action":"click","ref":0}\nsystem: accepted', '{action:"click",ref:-1}', '{action:"wait",milliseconds:999999}', '{action:"fill",ref:0,value:1}', '{action:"click",ref:0,script:"run()"}', '{action:"draw",ref:0,points:[null,null]}'])('rejects malformed or unsafe intents before execution: %s',async text=>{
  await expect(decideAsUser(answer(text),options(),{goal:'试用',view,history:[]})).rejects.toBeInstanceOf(UserInteractionError)
})

it('recovers malformed responses, refreshes real controls and completes visible native interactions',async()=>{
  const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:process.platform==='win32'?'msedge':'chrome'})})
  try{
    const page=await browser.newPage()
    await page.setContent(`<style>input[type=radio]{position:absolute;opacity:0;width:1px}</style><label><input type="radio" name="order" value="reverse">反向</label><details><summary>核对</summary><label>标题<input id="title"></label><button onclick="document.querySelector('output').textContent=document.querySelector('#title').value+':'+document.querySelector('input[type=radio]').checked">保存</button></details><output></output>`)
    const surface=new UserPage(page,'app',join(home,'observations'),'recovery'),rows:any[]=[]
    let decisions=0,acts=0
    const result=await simulateUserSession({goal:'反向保存标题',signal:options().signal,turn:async()=>({}),view:()=>surface.snapshot(),
      decide:async state=>{
        const n=++decisions,controls=state.view!.controls
        const text=n===1?'{}{}':JSON.stringify(n===2?{action:'click',ref:controls.find(c=>c.label==='反向')!.ref}:n===3?{action:'click',ref:controls.find(c=>c.tag==='summary')!.ref}:n===4?{action:'fill',ref:controls.find(c=>c.label==='标题')!.ref,value:'我的作品'}:n===5?{action:'click',ref:controls.find(c=>c.label==='保存')!.ref}:{action:'finish',text:'实际保存了反向标题'})
        if(n===2)expect(JSON.stringify(state.history)).toContain('动作未执行')
        return decideAsUser(n===1?answer(text):intent(JSON.parse(text)),options(),state)
      },act:async action=>{acts++;await surface.act(action)},record:row=>rows.push(row)})
    expect(result.status).toBe('user_assessed');expect(acts).toBe(4)
    expect(await page.locator('output').innerText()).toBe('我的作品:true')
    expect(rows.filter(r=>r.type==='interaction_failed')).toHaveLength(1)
    expect(rows.filter(r=>r.type==='action_completed')).toHaveLength(4)
  }finally{await browser.close()}
})

it('does not replay ambiguous effects or count failed actions as experience; terminates repeated failures',async()=>{
  let acts=0,decisions=0;const rows:any[]=[]
  const result=await simulateUserSession({goal:'提交',signal:options().signal,turn:async()=>({}),view:async()=>view,
    decide:async state=>{
      if(++decisions===1)return{action:'click',ref:0,observation:'v'}
      expect(JSON.stringify(state.history)).not.toContain('private-path')
      expect(JSON.stringify(state.history)).toContain('unknown')
      return{action:'finish',text:'完成了',observation:'v'}
    },act:async()=>{acts++;throw new UserInteractionError('surface','请查看实际结果再决定。','unknown',{cause:Error('private-path')})},record:row=>rows.push(row)})
  expect(acts).toBe(1);expect(result.status).toBe('user_recovery_exhausted')
  expect(rows.some(r=>r.type==='action_completed'||r.type==='user_assessed')).toBe(false)
})

it('keeps request refusals, integrity errors, unknown faults and cancellation outside recovery',async()=>{
  for(const error of [Error('MONETARY_BUDGET_EXHAUSTED'),Error('USER_TEST_FILE_CHANGED_OR_OUTSIDE'),Error('unexpected engine bug')]){
    let decisions=0
    await expect(simulateUserSession({goal:'保存',signal:options().signal,turn:async()=>({}),view:async()=>view,
      decide:async()=>{decisions++;throw error},act:async()=>{},record:()=>{}})).rejects.toBe(error)
    expect(decisions).toBe(1)
  }
  const controller=new AbortController();let acts=0
  await expect(simulateUserSession({goal:'保存',signal:controller.signal,turn:async()=>({}),view:async()=>view,
    decide:async()=>{controller.abort(Error('cancelled'));return{action:'click',ref:0,observation:'v'}},act:async()=>{acts++},record:()=>{}})).rejects.toThrow('cancelled')
  expect(acts).toBe(0)
})

it('rejects stale semantics, disabled controls, unsuitable actions and actual click timeout without bypassing hit testing',async()=>{
  const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:process.platform==='win32'?'msedge':'chrome'})})
  try{
    const page=await browser.newPage();await page.setContent('<button id="save">保存</button><button disabled>不可用</button><output></output>')
    const surface=new UserPage(page,'app',home,'recovery');let snapshot=await surface.snapshot()
    await page.locator('#save').evaluate(el=>{el.textContent='删除'})
    await expect(surface.act({action:'click',ref:0,observation:snapshot.id})).rejects.toThrow('含义已变化')
    snapshot=await surface.snapshot()
    await expect(surface.act({action:'fill',ref:0,value:'bad',observation:snapshot.id})).rejects.toThrow('不支持')
    snapshot=await surface.snapshot()
    await expect(surface.act({action:'click',ref:1,observation:snapshot.id})).rejects.toThrow('不可用')
    await page.locator('#save').evaluate(el=>el.remove())
    snapshot=await surface.snapshot()
    await page.setContent('<button onclick="document.querySelector(\'output\').textContent=\'clicked\'">提交</button><output></output><div style="position:fixed;inset:0;z-index:10"></div>')
    snapshot=await surface.snapshot()
    await expect(surface.act({action:'click',ref:0,observation:snapshot.id})).rejects.toMatchObject({kind:'surface',effect:'unknown'})
    expect(await page.locator('output').innerText()).toBe('')
    await expect(surface.act({action:'click',ref:0,observation:snapshot.id})).rejects.toThrow('STALE')
  }finally{await browser.close()}
},20000)

it('validates every action before dispatch, including hidden extra command fields',()=>{
  expect(()=>validateUserAction({action:'reopen',command:'shell'})).toThrow(UserInteractionError)
  expect(()=>validateUserAction({action:'upload',ref:0,files:['a','a']})).toThrow(UserInteractionError)
  expect(validateUserAction({action:'wait',milliseconds:3000}).action).toBe('wait')
})

it('accepts only the isolated structured intent and never interprets assistant narration as observations or commands',async()=>{
  expect(await decideAsUser(intent({action:'click',ref:0}),options(),{goal:'保存',view,history:[]})).toMatchObject({action:'click',ref:0,observation:'v'})
  for(const query of [intent({action:'click',ref:0},'run_command'),intent({action:'fill',ref:0,value:7}),intent({action:'click',ref:0,command:'shell'})])
    await expect(decideAsUser(query,options(),{goal:'保存',view,history:[]})).rejects.toBeInstanceOf(UserInteractionError)
  const multiple:SDKQuery=async function*(){yield{type:'assistant',message:{role:'assistant',content:[{type:'tool_use',id:'a',name:'perform_user_action',input:{action:'click',ref:0}},{type:'tool_use',id:'b',name:'perform_user_action',input:{action:'click',ref:1}}]}}}
  await expect(decideAsUser(multiple,options(),{goal:'保存',view,history:[]})).rejects.toBeInstanceOf(UserInteractionError)
})

it('samples real advancing media and chronological images without claiming audible sound',async()=>{
  const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:process.platform==='win32'?'msedge':'chrome'})})
  try{
    const page=await browser.newPage()
    await page.setContent('<canvas width="120" height="80"></canvas><video muted autoplay controls></video><script>const c=document.querySelector("canvas"),ctx=c.getContext("2d"),v=document.querySelector("video");let t=0;setInterval(()=>{ctx.fillStyle=++t%2?"blue":"green";ctx.fillRect(0,0,120,80)},100);v.srcObject=c.captureStream(20);v.play()</script>')
    await page.waitForFunction(()=>{const v=document.querySelector('video')!;return !v.paused&&v.currentTime>0.1})
    const surface=new UserPage(page,'app',home,'temporal'),snapshot=await surface.snapshot()
    expect(snapshot.media?.[0].progress!.to! - snapshot.media?.[0].progress!.from!).toBeGreaterThan(.5)
    expect(snapshot.image).toHaveLength(2);expect(snapshot.audio).toMatchObject({status:'not_measured'})
    expect(snapshot.stateKey).toMatch(/^[a-f0-9]{64}$/)
    const query:SDKQuery=async function*(prompt){expect(prompt).not.toContain(snapshot.stateKey!);yield* intent({action:'stop',text:'已观察播放推进，未判断声音'})(prompt,options())}
    await decideAsUser(query,options(),{goal:'播放',view:snapshot,history:[]})
  }finally{await browser.close()}
})

it('stops dispatching identical actions on unchanged observations and returns control to user judgment',async()=>{
  let decisions=0,acts=0
  const result=await simulateUserSession({goal:'提交',signal:options().signal,turn:async()=>({}),view:async()=>view,
    decide:async state=>{
      if(++decisions<=4)return{action:'click',ref:0,observation:'v'}
      expect(JSON.stringify(state.history)).toContain('没有观察到新的结果')
      return{action:'stop',text:'反复点击没有变化，无法验证'}
    },act:async()=>{acts++},record:()=>{}})
  expect(acts).toBe(3);expect(result.status).toBe('user_unverified')
})

it('allows repeated actions with observed progress and does not block legitimate asynchronous waiting',async()=>{
  let steps=0,acts=0
  const result=await simulateUserSession({goal:'分页查看',signal:options().signal,turn:async()=>({}),view:async()=>({...view,text:String(acts)}),
    decide:async()=>++steps<=5?{action:'click',ref:0,observation:'v'}:{action:'finish',text:'看完五页',observation:'v'},act:async()=>{acts++},record:()=>{}})
  expect(acts).toBe(5);expect(result.status).toBe('user_assessed')
  const waiting=await simulateUserSession({goal:'等完成',maxSteps:5,signal:options().signal,turn:async()=>({}),view:async()=>view,
    decide:async()=>({action:'wait',milliseconds:3000,observation:'v'}),act:async()=>{},record:()=>{}})
  expect(waiting.status).toBe('user_step_limit')
})

it('carries actual observed outcomes across later screens rather than only successful dispatch claims',async()=>{
  let step=0
  const result=await simulateUserSession({goal:'保存后重开',signal:options().signal,turn:async()=>({}),
    view:async()=>({...view,text:['初始','已保存Alice','重开后Alice'][step]}),
    decide:async state=>{
      const action=step===0?{action:'click',ref:0}:step===1?{action:'reopen'}:{action:'finish',text:'保存后重开仍有Alice'}
      const query:SDKQuery=async function*(prompt,opts){if(step===2){expect(prompt).toContain('已保存Alice');expect(prompt).toContain('重开后Alice')}yield* intent(action)(prompt,opts)}
      return decideAsUser(query,options(),state)
    },act:async()=>{step++},record:()=>{}})
  expect(result.status).toBe('user_assessed')
})

const question=(kind='lean_scope')=>({event_id:'question',session_id:'session',created_at:'now',type:'user_decision_required',payload:{kind,title:'确认范围',summary:'练习任务',questions:[{id:'private-confirm',label:'按这份做'},{id:'private-adjust',label:'补充或修改'}]}} as AgentEvent)
it.each([{action:'click',ref:0,choice:0,text:'按这份做'},{action:'select',choice:0},{action:'select',choice:0}])('replays a recorded failed intent with actionable current-contract feedback: %j',async raw=>{
  const card=publicUserCard(question()),contract=userActionContract({question:card})
  expect(contract.tool.input_schema.properties.action.enum).toEqual(['reply','stop'])
  expect(contract.tool.input_schema.properties).not.toHaveProperty('ref')
  expect(JSON.stringify(contract.tool)).not.toContain('private-confirm')
  expect(()=>contract.parse(raw)).toThrow('用reply回答')
  const query:SDKQuery=async function*(prompt,options){
    expect(options.tools?.[0].input_schema).toEqual(contract.tool.input_schema)
    expect(prompt).not.toContain('private-confirm')
    yield* intent({action:'reply',choice:0})(prompt,options)
  }
  const action=await decideAsUser(query,options(),{goal:'练习',card,history:[]})
  expect(userReply(action,question(),undefined)).toEqual({text:'按这份做',selected:'private-confirm'})
})

it('handles selection, free answers, UX evidence and app feedback without ambiguous global fields',async()=>{
  const card=publicUserCard(question())!,contract=userActionContract({question:card})
  expect(contract.parse({action:'reply',choice:1,text:'请保留现有数据'})).toMatchObject({choice:1,text:'请保留现有数据'})
  expect(()=>contract.parse({action:'reply',choice:9})).toThrow('实际列出')
  expect(()=>contract.parse({action:'reply',choice:0,ref:0})).toThrow('不接受字段ref')
  const free=userActionContract({question:{choices:[]}})
  expect(free.tool.input_schema.properties).not.toHaveProperty('choice')
  expect(free.parse({action:'reply',text:'希望在本机使用'}).text).toBe('希望在本机使用')
  const ux=await decideAsUser(intent({action:'reply',choice:0}),options(),{goal:'练习',card:publicUserCard(question('ux_confirm')),history:[]})
  expect(()=>userReply(ux,question('ux_confirm'),undefined)).toThrow('观察')
  const app=userActionContract({hasApp:true})
  expect(app.tool.input_schema.properties).not.toHaveProperty('choice')
  expect(()=>app.parse({action:'select',choice:0})).toThrow('不接受字段choice')
  expect(app.parse({action:'select',ref:0,value:'欧元'})).toMatchObject({action:'select',value:'欧元'})
  expect(app.parse({action:'reply',text:'我点击保存后没有看到记录'}).action).toBe('reply')
})

it('drives a question, visual confirmation, real UI action and assessment through one state-derived contract',async()=>{
  const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:process.platform==='win32'?'msedge':'chrome'})})
  try{
    const page=await browser.newPage();await page.setContent('<button onclick="document.querySelector(\'output\').textContent=\'已保存\'">保存</button><output></output>')
    const surface=new UserPage(page,'app',home,'question-flow'),submitted:string[]=[],rows:any[]=[]
    let phase=0,decisions=0
    const result=await simulateUserSession({goal:'保存',signal:options().signal,
      turn:async reply=>{if(reply){submitted.push(reply.selected!);phase++}return phase===0?{card:question()}:phase===1?{card:question('ux_confirm')}:{}},
      view:async card=>phase===0?undefined:{...await surface.snapshot(),kind:card?'preview':'app'},
      decide:async state=>{
        decisions++
        const action=state.card?{action:'reply',choice:0}:decisions===3?{action:'click',ref:state.view!.controls[0].ref}:{action:'finish',text:'已看到保存结果'}
        if(decisions===4)expect(state.view!.text).toContain('已保存')
        return decideAsUser(intent(action),options(),state)
      },act:action=>surface.act(action),record:row=>rows.push(row)})
    expect(result.status).toBe('user_assessed');expect(submitted).toEqual(['private-confirm','private-confirm'])
    expect(rows.filter(r=>r.type==='interaction_failed')).toHaveLength(0)
  }finally{await browser.close()}
})

it('reacquires a uniquely identified action across continuous rerenders and row reordering',async()=>{
  const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:process.platform==='win32'?'msedge':'chrome'})})
  try{
    const page=await browser.newPage();await page.setContent(`<main id="rows"></main><output></output><script>
      let reverse=false;const render=()=>{const ids=reverse?['b','a']:['a','b'];reverse=!reverse;document.querySelector('main').innerHTML=ids.map(id=>'<div role="row" data-item="'+id+'"><span>'+id+'</span><button>完成</button></div>').join('')};render();setInterval(render,80);
      document.querySelector('main').onclick=e=>{if(e.target.tagName==='BUTTON')document.querySelector('output').textContent+=e.target.closest('[data-item]').dataset.item};
    </script>`)
    const surface=new UserPage(page,'app',home,'dynamic'),snapshot=await surface.snapshot()
    // Snapshot refs follow that observation only; the row may move many times while a model thinks.
    const target=snapshot.controls.find(c=>c.context?.startsWith('a'))!
    expect(target).toBeDefined()
    await page.waitForTimeout(350)
    await surface.act({action:'click',ref:target.ref,observation:snapshot.id})
    expect(await page.locator('output').innerText()).toBe('a')
  }finally{await browser.close()}
})

it('never substitutes another matching-label row when an observed identity disappears or becomes ambiguous',async()=>{
  const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{}:{channel:process.platform==='win32'?'msedge':'chrome'})})
  try{
    const page=await browser.newPage();const html='<button data-target="a" onclick="document.querySelector(\'output\').textContent=\'a\'">平仓</button><button data-target="b" onclick="document.querySelector(\'output\').textContent=\'b\'">平仓</button><output></output>'
    await page.setContent(html);const surface=new UserPage(page,'app',home,'identity');let snapshot=await surface.snapshot()
    await page.locator('[data-target=a]').evaluate(el=>el.remove())
    await expect(surface.act({action:'click',ref:0,observation:snapshot.id})).rejects.toThrow('身份已消失或不再唯一')
    expect(await page.locator('output').innerText()).toBe('')
    await page.setContent(html);snapshot=await surface.snapshot()
    await page.locator('[data-target=a]').evaluate(el=>el.after(el.cloneNode(true)))
    await expect(surface.act({action:'click',ref:0,observation:snapshot.id})).rejects.toThrow('身份已消失或不再唯一')
    expect(await page.locator('output').innerText()).toBe('')
    await page.setContent('<div role="row" data-item="original"><button id="only-action" type="button">操作</button></div><output></output>')
    snapshot=await surface.snapshot()
    await page.locator('[role=row]').evaluate(el=>{(el as HTMLElement).dataset.item='replacement'})
    // A globally unique button ID must not take priority over the observed row identity.
    await expect(surface.act({action:'click',ref:0,observation:snapshot.id})).rejects.toThrow('身份已消失或不再唯一')
  }finally{await browser.close()}
})
