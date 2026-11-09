import {readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {createEngineeringProject} from './engineering-project'
import {withEmptyQualityReview} from './quality-review-query'
import {parseLeanBrief} from '../../main/guide/lean-brief'
import {readPrdBackplane,markPrdUserConfirmed} from '../../main/project/prd-store'
import {syncDocuments} from '../../main/project/document-sync'
import {enterDesktopLine} from '../../main/desktop/desktop-route'
import {leanBudget} from '../../main/desktop/lean-budget'
import {findProject} from '../../main/project/project-service'
import {activeSoftwareRelease} from '../../main/software/release-store'
import type {SDKQuery} from '../../main/orchestration/stages/orchestration-contracts'

const home=process.env.PROMA_HOME!,phase=process.argv[2],handoff=join(home,'process-fixture.json')
const deps={publish:()=>{},persistAssistant:()=>{},persistSystem:()=>{},complete:()=>{}}
const use=(id:string,name:string,input:Record<string,unknown>)=>({type:'tool_use' as const,id,name,input})
if(phase==='crash'){
 const project=createEngineeringProject({request_id:'create',mode:'quick'},{workflowVersion:'software-v1'})
 const parsed=parseLeanBrief(JSON.stringify({action:'brief',goal:'输出5',ui:'none',delivery:'command',requirements:[{description:'输出5',expected:'输出5'}]}),{projectId:project.project_id,sessionId:'s',source:'输出5',previous:readPrdBackplane(project.project_id),software:true})!
 if(parsed.action!=='brief')throw Error('fixture')
 syncDocuments({request_id:'sync',project_id:project.project_id,session_id:'s',checkpoint:'requirement_confirmed'},parsed.brief);markPrdUserConfirmed(project.project_id)
 writeFileSync(handoff,JSON.stringify({id:project.project_id,root:project.root_path,pid:process.pid}))
 let calls=0
 const query:SDKQuery=async function*(){
  if(++calls===2){writeFileSync(join(home,'before-process-exit.json'),JSON.stringify(leanBudget(project.project_id,'desktop-implement').snapshot()));process.exit(23)}
  yield{type:'assistant',message:{role:'assistant',content:[use('app','write_file',{path:'app.cjs',content:'console.log(5)'}),use('setup','write_file',{path:'setup.cjs',content:'require("fs").appendFileSync("once.txt","once\\n")'}),use('launch','write_file',{path:'LAUNCH.json',content:JSON.stringify({schema_version:2,mode:'command',command:['node','app.cjs']})}),use('rules','register_cli_check',{expectations:{'F-001':'输出5'},cases:[{name:'five',covers:['F-001'],args:[],stdout:'5',exit_code:0}]}),use('effect','run_command',{command:['node','setup.cjs']})]}}
  yield{type:'result',subtype:'success',usage:{input_tokens:10,output_tokens:20}}
 }
 await enterDesktopLine({projectId:project.project_id,sessionId:'s',requestId:'first-process',content:'开始实现',maxTokens:4096,signal:AbortSignal.timeout(60000)},withEmptyQualityReview(query),{},deps)
 throw Error('fixture did not reach the intended crash boundary')
}else if(phase==='resume'){
 const fixture=JSON.parse(readFileSync(handoff,'utf8'));let makerCalls=0
 const query:SDKQuery=async function*(){makerCalls++;throw Error('Stable candidate should resume in the host without another maker request')}
 await enterDesktopLine({projectId:fixture.id,sessionId:'s',requestId:'second-process',content:'继续',maxTokens:4096,signal:AbortSignal.timeout(120000)},withEmptyQualityReview(query),{},deps)
 const project=findProject(fixture.id),release=await activeSoftwareRelease(fixture.id)
 writeFileSync(join(home,'after-process-resume.json'),JSON.stringify({pid:process.pid,makerCalls,status:project.status,phase:project.desktop_phase,release:release?.id,effect:readFileSync(join(fixture.root,'once.txt'),'utf8'),budget:leanBudget(fixture.id,'desktop-implement').snapshot()}))
 process.exit(0)
}else throw Error('Unknown fixture phase')
