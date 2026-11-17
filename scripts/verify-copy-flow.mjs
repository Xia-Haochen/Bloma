/** Real Electron/offline UI acceptance. No channel or model is configured. */
import { _electron } from 'playwright'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

const root = resolve('.')
const folder = join(root, 'run-artifacts', process.env.BLOMA_UI_EVIDENCE || 'copy-flow-20261105')
mkdirSync(folder, { recursive: true })
const home = mkdtempSync(join(tmpdir(), 'blui-'))
const pid = randomUUID(), sid = randomUUID(), now = new Date().toISOString()
const projectRoot = join(home, 'agent-workspaces', 'default-software-builder', 'generated-projects', pid)
mkdirSync(join(projectRoot, '00_UX'), { recursive: true })
writeFileSync(join(projectRoot, '00_UX', 'confirmed.html'), `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;width:1280px;height:800px;box-sizing:border-box;font:18px/1.8 'Segoe UI',sans-serif;color:#525849;background:#fff}header{padding:20px 32px;border-bottom:1px solid #e4e9df}main{display:grid;grid-template-columns:190px 260px 1fr;height:700px}aside{padding:30px;background:#f3f5ef;border-right:1px solid #e5eadf}article{padding:35px}input,button{font:inherit;padding:8px;border:1px solid #d9e0d1;border-radius:6px}footer{height:20px;background:#78956f}h1{font-size:27px}</style></head><body><header>课程笔记 · 离线固定界面样例</header><main><aside>我的课程<br>组成原理<br>操作系统</aside><aside>最近笔记<br>虚拟存储器<br>指令流水线</aside><article><h1>虚拟存储器与地址转换</h1><p>这是平台布局验收固定草图，不是新模型产物。</p><input aria-label="草图输入" value="草图状态"><button id="count" onclick="this.textContent=++window.count">0</button></article></main><footer id="bottom"></footer><script>window.count=0;window.__fixtureReady=true</script></body></html>`)
writeFileSync(join(home, 'projects.json'), JSON.stringify({ version: 1, projects: [{ project_id: pid, workspace_slug: 'default-software-builder', name: '课程笔记 · 离线验收', mode: 'quick', workflow_version: 'software-v1', template_type: 'desktop_tool', status: 'active', current_stage: 'blocked_for_user_decision', desktop_phase: 'desktop-verify', ux_confirmation: { prd_fingerprint: 'fixture', design_hash: 'fixture', html_hash: 'fixture' }, desktop_blocked: { reason: 'user-stop', at: now }, root_path: projectRoot, last_session_id: sid, created_at: now, updated_at: now }] }))
mkdirSync(join(home, 'agent-sessions'), { recursive: true })
writeFileSync(join(home, 'bloma-agent-sessions.json'), JSON.stringify({ version: 1, sessions: [{ session_id: sid, project_id: pid, status: 'completed', jsonl_path: join(home, 'agent-sessions', sid + '.jsonl'), created_at: now, updated_at: now }] }))
const messages = [
  { id: 'human-fixture', role: 'user', origin: 'human', content: [{ type: 'text', text: '想把课程笔记整理清楚。' }], timestamp: 1 },
  { id: 'reply-fixture', role: 'assistant', origin: 'agent', content: [{ type: 'text', text: process.env.BLOMA_UI_LONG_REPLY ? '长消息完整正文。\n\n'.repeat(100) : '第一版界面已准备好。可以先看整体，细节放大再看。\n\n当前修改尚未完成验证。' }], timestamp: 2 },
]
writeFileSync(join(home, 'agent-sessions', sid + '.jsonl'), messages.map(message => JSON.stringify(message)).join('\n') + '\n')
const documentsDir = join(home, 'agent-workspaces', 'default-software-builder', 'documents', pid)
mkdirSync(documentsDir, { recursive: true })
writeFileSync(join(documentsDir, 'task.md'), '# 离线验收文档\n\n这是实际读取的本地文档。\n\n' + '长内容用于滚动检查。\n\n'.repeat(80))
writeFileSync(join(documentsDir, '.document-manifest.json'), JSON.stringify({ documents: [{ document_id: 'task', type: 'prd', path: join(documentsDir, 'task.md'), status: 'synced' }] }))
const env = { ...process.env, PROMA_HOME: home, BLOMA_DESKTOP_DISPATCH: '0' }
delete env.ELECTRON_RUN_AS_NODE; delete env.VITE_DEV_SERVER_URL

const scene=process.env.BLOMA_COPY_SCENE ?? 'flow'
const seed=JSON.parse(readFileSync(join(home,'projects.json'),'utf8'))
if(scene==='delivered') {
 Object.assign(seed.projects[0],{status:'completed',current_stage:'completed',desktop_phase:'delivered',desktop_blocked:undefined})
} else if(scene==='blocked') {
 const reason='模型请求额度已到，宿主检查未通过，未再调用模型：\n语音功能尚未通过实际检查。ASR_CAPABILITY_PREPARATION_REQUIRED'
 seed.projects[0].desktop_blocked.note=reason
 writeFileSync(join(home,'agent-sessions',sid+'.jsonl'),JSON.stringify(messages[0])+'\n'+JSON.stringify({id:'stop',role:'assistant',origin:'agent',content:[{type:'text',text:reason}],timestamp:2})+'\n')
} else { delete seed.projects[0].desktop_blocked; delete seed.projects[0].desktop_phase; seed.projects[0].current_stage='clarifying' }
writeFileSync(join(home,'projects.json'),JSON.stringify(seed))
const report={scope:'real Electron, isolated fixture project and IPC events; no model calls',errors:[],screens:[]}
let app
try {
 app=await _electron.launch({executablePath:join(root,'node_modules/electron/dist/electron.exe'),args:[`--user-data-dir=${join(home,'profile')}`,'.'],cwd:root,env})
 const page=await app.firstWindow();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message))
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setContentSize(1100,760)})
 await page.waitForSelector('[data-ai-id="workspace-theatre"]')
 const emit=(type,payload)=>app.evaluate(({BrowserWindow},e)=>BrowserWindow.getAllWindows()[0].webContents.send('agent:stream-event',e),{event_id:randomUUID(),project_id:pid,session_id:sid,type,payload,created_at:new Date().toISOString()})
 const shot=async name=>{await page.waitForTimeout(400);await page.screenshot({path:join(folder,name+'.png')});report.screens.push(name)}
 if(scene==='delivered') {
  await page.locator('[data-ai-id="export-project-btn"]').waitFor()
  const bounds=await page.locator('[data-ai-id="mvp-status-banner"]').boundingBox()
  assert.ok(bounds.width>100 && bounds.height<90,JSON.stringify(bounds))
  const title=await page.locator('[data-ai-id="mvp-status-banner"] p').first().boundingBox()
  assert.ok(title.height<25,JSON.stringify(title))
  await shot('delivered')
 } else if(scene==='blocked') {
  await page.waitForTimeout(500)
  await page.getByText('本轮制作额度不足，任务已暂停。',{exact:true}).waitFor()
  await shot('blocked-summary')
  await page.getByText('查看停止原因与检查详情',{exact:true}).click()
  await shot('blocked-details')
 } else {
 await emit('user_decision_required',{kind:'lean_scope',title:'确认这次要做的内容',scope:{goal:'整理课程笔记',usage:'在桌面窗口使用',features:[{id:'F-001',description:'按课程整理笔记',expected:'保存后重开仍能找到笔记'}],constraints:['保存在本机'],out_of_scope:['多人共享']},questions:[{id:'lean_confirm:fixture',label:'按这份做',description:'确认目标和范围'},{id:'lean_adjust',label:'补充或修改'},{id:'lean_pause',label:'稍后再说'}]})
 await page.getByRole('heading',{name:'这次要做的软件'}).waitFor(); await shot('requirements')
 await emit('stage_changed',{stage:'sketch_ready'})
 await emit('ux_sketch_ready',{preview_url:`bloma-file://${pid}/00_UX/confirmed.html`})
 await emit('user_decision_required',{kind:'ux_confirm',title:'请确认界面草图',summary:'左侧选课程，右侧查看和编辑笔记。',questions:[{id:'ux_confirm_go',label:'确认草图，开始制作'},{id:'ux_confirm_adjust',label:'有要调整的'}]})
 await shot('design')
 await emit('ux_sketch_closed',{})
 await emit('stage_changed',{stage:'generating_mvp'})
 await emit('stage_changed',{stage:'desktop-implement'})
 await emit('tool_call_started',{tool:'read_file',tool_use_id:'copy-review-read',input:{path:'task.md'}})
 await page.waitForTimeout(11000); await shot('working')
 await page.getByRole('button',{name:'查看进度',exact:true}).click(); await page.locator('[data-ai-id="progress-card"]').scrollIntoViewIfNeeded(); await shot('progress')
 await emit('retrying',{attempt:3,max_retries:5});await shot('retry')
 await emit('stage_changed',{stage:'desktop-verify'}); await emit('tool_call_started',{tool:'verify_app',tool_use_id:'check',input:{}}); await shot('verification')
 }
 assert.deepEqual(report.errors,[])
} finally {writeFileSync(join(folder,scene+'-report.json'),JSON.stringify(report,null,2));if(app){await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.removeAllListeners('close')}).catch(()=>{});await app.close()}}
console.log(JSON.stringify(report))
