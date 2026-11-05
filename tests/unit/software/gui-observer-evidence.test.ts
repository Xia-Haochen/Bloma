import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:net'
import { beforeEach, afterEach, it, expect } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { observeSoftwareGui } from '../../../main/software/gui-observer'
import type { LaunchDeclaration } from '../../../main/desktop/launch-smoke'
import type { GuiAcceptanceSuite } from '../../../main/desktop/gui-acceptance'
import { installGuiAcceptanceSuite,runGuiAcceptance } from '../../../main/desktop/gui-acceptance'
import { observedQualityFinding } from '../../../main/software/quality-closeout'
let home:string,previous:string|undefined,project:ReturnType<typeof createProject>,launch:LaunchDeclaration
beforeEach(async()=>{
  previous=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-observer-evidence-'));process.env.PROMA_HOME=home
  project=createProject({request_id:'c',mode:'quick'},{workflowVersion:'software-v1'})
  const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()))
  writeFileSync(join(project.root_path,'server.cjs'),`require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end(require('fs').readFileSync('index.html'))}).listen(${port},'127.0.0.1')`)
  writeFileSync(join(project.root_path,'index.html'),`<button id="save" onclick="document.querySelector('#value').textContent='saved'">Save</button><output id="value">empty</output>`)
  launch={schema_version:2,ui:'browser',command:['node','server.cjs'],url:`http://127.0.0.1:${port}`} as LaunchDeclaration
})
afterEach(()=>{if(previous===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=previous;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const suite=():GuiAcceptanceSuite=>({version:1,scope_hash:'a'.repeat(64),covers:['F-001'],steps:[{id:'save',kind:'click',selector:'#save'},{id:'saved',kind:'expect',selector:'#value',equals:'saved'}]})
const observe=(rules=suite())=>observeSoftwareGui({projectId:project.project_id,root:project.root_path,launch,suite:rules,temporary:join(home,'runtime'),screenshotDir:join(home,'shots'),signal:AbortSignal.timeout(30000),purpose:'acceptance'})
it('does not pass an application that updates the expected DOM then throws a real renderer error',async()=>{
  writeFileSync(join(project.root_path,'index.html'),`<button id="save" onclick="document.querySelector('#value').textContent='saved';throw Error('save crashed')">Save</button><output id="value">empty</output>`)
  const result=await observe();expect(result.status).toBe('failed');expect(result.error).toContain('save crashed');expect(result).toMatchObject({failure_kind:'runtime'})
})
it('keeps successful business checks when the diagnostic screenshot destination cannot be written',async()=>{
  mkdirSync(join(home,'shots','gui-0.png'),{recursive:true})
  const result=await observe();expect(result.status).toBe('passed');expect(result).toHaveProperty('evidence_warnings');expect((result as {evidence_warnings:string[]}).evidence_warnings.length).toBeGreaterThan(0)
})
it('does not turn an invalid CSS selector into a failed product assertion',async()=>{
  const rules=suite();rules.steps[1]={id:'saved',kind:'expect',selector:'[',equals:'saved',timeout_ms:100}
  const result=await observe(rules);expect(result.status).toBe('unverified');expect(result.error).not.toContain('GUI_ASSERTION_FAILED')
})
it('does not confirm a quality defect from a real wrong-element observation adapter',async()=>{
  writeFileSync(join(project.root_path,'LAUNCH.json'),JSON.stringify(launch))
  const rules=suite();rules.steps[1]={id:'saved',kind:'expect',selector:'#value',property:'value',equals:'saved',timeout_ms:100};rules.acceptance_refs={saved:['F-001']}
  installGuiAcceptanceSuite(project.project_id,rules)
  const result=await runGuiAcceptance({projectId:project.project_id,root:project.root_path,scopeHash:rules.scope_hash,signal:AbortSignal.timeout(30000)})
  expect(result?.status).toBe('unverified');expect(result?.case_results?.[0].status).toBe('unverified')
  expect(observedQualityFinding({status:'unverified',summary:'adapter',core:{host_gui:result}} as never,{requirement:'F-001'} as never,'saved')).toBe('unverified')
})
