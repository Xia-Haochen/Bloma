import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { createEngineeringWorkspaces,engineeringObservations } from '../../../main/software/engineering-workspace'
import {debugWorkspace} from '../../../main/software/debug-workspace'
import { createSoftwareCollaborationPolicy } from '../../../main/software/collaboration-policy'
import { buildSoftwareAgentTools } from '../../../main/software/agent-tools'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { qualityLedgerPath, saveQualityLedger, type QualityFinding } from '../../../main/software/quality-ledger'
import { registerParentLoopContext, startDelegation, continueDelegation, findDelegation, getDelegationSummary, disposeParentDelegationState, settleParentDelegationRuns } from '../../../main/agent/delegation/agent-collaboration'

let home:string,old:string|undefined,project:ReturnType<typeof createProject>
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-engineering-peer-'));process.env.PROMA_HOME=home;project=createProject({request_id:'r',mode:'quick'},{workflowVersion:'software-v1'});writeFileSync(join(project.root_path,'app.js'),'original')})
afterEach(async()=>{disposeParentDelegationState('parent');await settleParentDelegationRuns('parent');if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const ctx=(sessionId='child')=>({projectId:project.project_id,sessionId,requestId:'r',signal:AbortSignal.timeout(30000),state:createToolState()})
const args={task:'核对方案',role:'research' as const,readOnly:true,independentWorkspace:true}

it('supplies actual retained probe steps after the window closes without making them current or leaking another owner',()=>{
  const path=join(debugWorkspace(project.project_id,'parent'),'checkpoint.json')
  const value={id:'old-debug',projectId:project.project_id,sessionId:'parent',state:'closed',version:2,source:'old-source',stale:false,
    observations:[{kind:'script.completed',message:'Browser script exited 0'}],steps:[{id:'browser-script',passed:false,actual:{expected_seed:777001,actual_seed:100027,error:'api_key=PRIVATE_KEY'}}]}
  writeFileSync(path,JSON.stringify(value));const before=readFileSync(path,'utf8')
  const facts=engineeringObservations(project.project_id,'parent')
  expect(facts).toMatchObject({available:true,historical:true,stale:true,recorded_state:'closed',steps:[{passed:false}]})
  expect(JSON.stringify(facts)).toContain('100027');expect(JSON.stringify(facts)).not.toContain('PRIVATE_KEY')
  expect(readFileSync(path,'utf8')).toBe(before)
  writeFileSync(path,JSON.stringify({...value,projectId:'foreign-project'}))
  expect(engineeringObservations(project.project_id,'parent')).toMatchObject({available:false})
})

it('recovers prior investigation artifacts across parents without inheriting private conversations or stale authority',async()=>{
  const first=createEngineeringWorkspaces(project.project_id,project.root_path,'old-parent'),lease=first.prepare('old-child',args),root=first.root('old-child')
  writeFileSync(join(root,'findings.md'),'已验证地图连通；仍需验证首领返回。')
  lease.release();writeFileSync(join(project.root_path,'app.js'),'changed product')
  const next=createEngineeringWorkspaces(project.project_id,project.root_path,'new-parent'),current=next.prepare('child',args)
  const context=JSON.parse(readFileSync(join(next.root('child'),'context.json'),'utf8'))
  expect(context.prior_investigations).toHaveLength(1)
  expect(context.prior_investigations[0].same_source).toBe(false)
  const path=context.prior_investigations[0].path+'/findings.md'
  expect(readFileSync(join(next.root('child'),path),'utf8')).toContain('首领返回')
  const contextForTools=ctx(),tools=next.tools('child')
  await tools.find(t=>t.name==='read_file')!.execute({path},contextForTools)
  await expect(tools.find(t=>t.name==='write_file')!.execute({path,content:'overwrite'},contextForTools)).rejects.toThrow('ENGINEERING_SNAPSHOT_READ_ONLY')
  expect(current.facts()).toMatchObject({input_intact:true})
  current.release()
})

it('keeps independent notes, immutable versioned source views, and reports changed evidence on continuation',async()=>{
  mkdirSync(join(project.root_path,'data'));writeFileSync(join(project.root_path,'data/private.json'),'private');writeFileSync(join(project.root_path,'.env'),'SECRET')
  const work=createEngineeringWorkspaces(project.project_id,project.root_path,'parent'),lease=work.prepare('child',args),root=work.root('child')
  const first=JSON.parse(readFileSync(join(root,'context.json'),'utf8'))
  expect(first.files.map((f:{path:string})=>f.path)).not.toContain('data/private.json');expect(existsSync(join(root,first.snapshot,'.env'))).toBe(false)
  const tools=work.tools('child'),write=tools.find(t=>t.name==='write_file')!
  expect((await write.execute({path:'notes.md',content:'independent diagnosis'},ctx())).isError).not.toBe(true)
  expect(readFileSync(join(root,'notes.md'),'utf8')).toBe('independent diagnosis');expect(existsSync(join(project.root_path,'notes.md'))).toBe(false)
  const run=await tools.find(t=>t.name==='run_command')!.execute({command:['node','-e',"require('fs').writeFileSync('probe.txt','probe');console.log(process.env.APP_DATA_DIR)"]},ctx())
  expect(run.isError).toBe(false);expect(lease.facts()).toMatchObject({run_count:1,recent_runs:[{exit_code:0,product_verified:false}]});expect(JSON.parse(run.output).product_verified).toBe(false)
  expect(readFileSync(join(root,'probe.txt'),'utf8')).toBe('probe');expect(existsSync(join(project.root_path,'probe.txt'))).toBe(false)
  let refused=false;try{refused=Boolean((await write.execute({path:`notes/../${first.snapshot}/app.js`,content:'tampered'},ctx())).isError)}catch{refused=true}
  expect(refused).toBe(true);expect(readFileSync(join(root,first.snapshot,'app.js'),'utf8')).toBe('original')
  writeFileSync(join(project.root_path,'added.js'),'added');expect(JSON.stringify(lease.facts())).toContain('"source_changed":true');
  writeFileSync(join(project.root_path,'app.js'),'new version');expect(JSON.stringify(lease.facts())).toContain('"source_changed":true');lease.release()
  const next=work.prepare('child',args),second=JSON.parse(readFileSync(join(root,'context.json'),'utf8'))
  expect(second.snapshot).not.toBe(first.snapshot);expect(JSON.parse(readFileSync(join(root,first.snapshot+'.context.json'),'utf8')).snapshot).toBe(first.snapshot);expect(readFileSync(join(root,first.snapshot,'app.js'),'utf8')).toBe('original')
  expect(readFileSync(join(root,second.snapshot,'app.js'),'utf8')).toBe('new version');expect(readFileSync(join(root,'notes.md'),'utf8')).toBe('independent diagnosis');next.release()
})

it('runs the actual delegated Pi session in its own workspace without producer prompt or skills',async()=>{
  const policy=createSoftwareCollaborationPolicy(project.project_id,project.root_path,'parent');let calls=0;const observations:any[]=[]
  registerParentLoopContext('parent',{env:{BLOMA_LOOP_THINKING:'high'},query:async function*(_prompt,options){
    expect(JSON.stringify(options.messages)).not.toContain('PRODUCER_PRIVATE_SUCCESS');expect(options.thinkingLevel).toBe('high');expect(options.maxTokens).toBe(2048)
    yield{type:'assistant',message:{role:'assistant',content:++calls===1?[{type:'tool_use',id:'note',name:'write_file',input:{path:'notes.md',content:'independent notes'}}]:[{type:'text',text:'独立意见，不签发通过。'}]}}
    yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:10}}
  },maxTokens:640000,childMaxTokens:()=>2048,maxTurns:5,delegationMaxTurns:5,permissionMode:'allow-all',temperature:.1,system:'PRODUCER_PRIVATE_SUCCESS',editFormat:'diff',
    prepareDelegation:policy.prepare,childWorkspace:child=>policy.engineering.root(child),childRuntimeScope:()=> 'engineering-peer',
    childSystemBuilder:(_role,child)=>policy.engineering.describe(child),childToolsBuilder:(id,role,_format,child)=>buildSoftwareAgentTools(id,role,policy,undefined,undefined,undefined,child),
    onRuntimeObservation:value=>observations.push(value),publish:()=>{}})
  const started=startDelegation(ctx('parent'),args),record=findDelegation('parent',started.delegation_id)!
  const own=policy.engineering.root(started.child_session_id)
  await record.completion;await settleParentDelegationRuns('parent')
  expect(record.status,record.error).toBe('completed');
  expect(getDelegationSummary(record).workspace_facts).toMatchObject({input_intact:true,run_count:0})
  writeFileSync(join(project.root_path,'app.js'),'updated after independent opinion')
  continueDelegation(ctx('parent'),started.delegation_id,'根据新版本继续核对')
  await record.completion;await settleParentDelegationRuns('parent');expect(record.status,record.error).toBe('completed')
  const latest=JSON.parse(readFileSync(join(own,'context.json'),'utf8'))
  expect(readFileSync(join(own,latest.snapshot,'app.js'),'utf8')).toBe('updated after independent opinion')
  expect(existsSync(join(project.root_path,'notes.md'))).toBe(false)
  expect(observations[0].skills.names).toEqual([]);expect(observations[0].skills.available).toEqual([])
  expect(readFileSync(join(own,'notes.md'),'utf8')).toBe('independent notes')
},60000)

it('invalidates a probe interpretation if its command changes the input copy, while leaving the product intact',async()=>{
  const work=createEngineeringWorkspaces(project.project_id,project.root_path,'parent'),lease=work.prepare('child',args),root=work.root('child')
  const context=JSON.parse(readFileSync(join(root,'context.json'),'utf8')),tools=work.tools('child')
  const result=await tools.find(t=>t.name==='run_command')!.execute({command:['node','-e',`require('fs').writeFileSync(${JSON.stringify(context.snapshot+'/app.js')},'changed copy')`]},ctx())
  expect(result.isError).toBe(true);expect(JSON.parse(result.output)).toMatchObject({input_intact:false,product_verified:false,code:'ENGINEERING_INPUT_CHANGED'})
  expect(readFileSync(join(project.root_path,'app.js'),'utf8')).toBe('original')
  expect(JSON.stringify(lease.facts())).toContain('"input_intact":false');lease.release()
})

it('views its own probe images without acquiring access to product image paths',async()=>{
  const work=createEngineeringWorkspaces(project.project_id,project.root_path,'parent'),lease=work.prepare('child',args),root=work.root('child')
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1F0AAAAASUVORK5CYII=','base64')
  writeFileSync(join(root,'probe.png'),png);writeFileSync(join(project.root_path,'outside.png'),png)
  const image=work.tools('child').find(t=>t.name==='view_image')!
  const viewed=await image.execute({path:'probe.png'},ctx())
  expect('images' in viewed ? viewed.images : undefined).toHaveLength(1)
  expect((await image.execute({path:join(project.root_path,'outside.png')},ctx())).isError).toBe(true)
  lease.release()
})

it('gives the peer the shared environment inspector and puts current host facts before the full requirement material',async()=>{
  const work=createEngineeringWorkspaces(project.project_id,project.root_path,'parent'),lease=work.prepare('child',args)
  const content=readFileSync(join(work.root('child'),'context.json'),'utf8')
  expect(content.indexOf('"facts"')).toBeLessThan(content.indexOf('"requirements"'))
  expect(work.describe('child')).toContain('重要发现先用简短自然语言交接')
  const inspect=work.tools('child').find(t=>t.name==='inspect_software_environment')!
  const result=JSON.parse((await inspect.execute({},ctx())).output)
  expect(result.native_js_observers).toEqual(['browser','electron'])
  expect(result.declared_entry).toMatchObject({declared:false})
  expect(lease.facts()).toMatchObject({input_intact:true})
  lease.release()
},30000)

it('lets an owned peer read the actual quality finding without changing evidence or acquiring review authority',async()=>{
  const finding:QualityFinding={id:'specific-finding',review:'review',identity:{source:'old-source',target:'target',environment:'environment'},
    requirement:'F-001',expected_source:'保存失败必须可见',category:'behavior',severity:'high',location:'storage.js',
    trigger:'磁盘写入失败后保存',evidence:'错误被捕获但界面显示保存成功',reproduction:'拒绝磁盘写入后按保存',unknowns:'修复后未复测',disposition:'suspected',checks:[]}
  saveQualityLedger(project.project_id,{version:1,reviews:[],findings:[finding]})
  const before=readFileSync(qualityLedgerPath(project.project_id),'utf8')
  const work=createEngineeringWorkspaces(project.project_id,project.root_path,'parent'),lease=work.prepare('child',args)
  const tools=work.tools('child'),read=tools.find(t=>t.name==='read_quality_findings')!
  expect(JSON.parse((await read.execute({finding_id:finding.id},ctx())).output)).toEqual({finding})
  expect(JSON.parse(readFileSync(join(work.root('child'),'context.json'),'utf8')).quality_findings.tool).toBe(read.name)
  expect(tools.map(t=>t.name)).not.toContain('submit_quality_findings')
  expect(tools.map(t=>t.name)).not.toContain('start_quality_review')
  await expect(read.execute({finding_id:finding.id},ctx('another-child'))).rejects.toThrow('ENGINEERING_WORKSPACE_OWNER_MISMATCH')
  await expect(read.execute({finding_id:'missing'},ctx())).rejects.toThrow('QUALITY_FINDING_UNKNOWN')
  expect(readFileSync(qualityLedgerPath(project.project_id),'utf8')).toBe(before)
  lease.release()
  await expect(read.execute({finding_id:finding.id},ctx())).rejects.toThrow('ENGINEERING_WORKSPACE_INACTIVE')
})
