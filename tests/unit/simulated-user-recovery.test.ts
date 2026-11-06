import {afterEach,beforeEach,expect,it} from 'vitest'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {chromium} from 'playwright'
import {decideAsUser,simulateUserSession,type UserView} from '../../scripts/simulated-user'
import {UserInteractionError,validateUserAction} from '../../scripts/user-action'
import {UserPage} from '../../scripts/simulated-user-surface'
import type {SDKQuery} from '../../main/orchestration/stages/orchestration-contracts'
let home:string,old:string|undefined
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'user-recovery-'));process.env.PROMA_HOME=home})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const options=()=>({env:{},maxTokens:1024,sessionId:'user',signal:new AbortController().signal})
const answer=(text:string):SDKQuery=>async function*(){yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text}]}}}
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
        return decideAsUser(answer(text),options(),state)
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
