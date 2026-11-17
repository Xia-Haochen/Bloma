import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {expect,it} from 'vitest'
import {exportTrialTrace} from '../../scripts/export-trial-trace'
it('exports exact tool-ID receipts without exporting native hidden content or credentials',()=>{
  const root=mkdtempSync(join(tmpdir(),'trace-export-'))
  try{
    mkdirSync(join(root,'trace/requests'),{recursive:true});mkdirSync(join(root,'home/agent-sessions'),{recursive:true})
    writeFileSync(join(root,'trace/requests/00001.json'),JSON.stringify({sequence:1,trace_id:'r',session_id:'s',phase:'run',role:'orchestrator',started_at:'now',status:'completed',transports:[{state:'started'}],reported_price_micro_rmb:26,tool_calls:[{id:'call',name:'read_file',input:{path:'app.js'}}],assistant_output:['visible'],input_file:join(root,'trace/input.json')}))
    writeFileSync(join(root,'trace/input.json'),'{}')
    writeFileSync(join(root,'home/agent-sessions/s.jsonl'),[
      {role:'assistant',content:[{type:'thinking',text:'PRIVATE_THOUGHT'},{type:'tool_use',id:'call',name:'read_file'}]},
      {role:'user',content:[{type:'tool_result',tool_use_id:'call',content:'api_key=PRIVATE_CREDENTIAL',is_error:false}]}
    ].map(r=>JSON.stringify(r)).join('\n'))
    writeFileSync(join(root,'monetary-policy.json.state.json'),JSON.stringify({entries:[{status:'reported',charged_micro_rmb:26}]}))
    expect(exportTrialTrace(root)).toMatchObject({physical_recorded:1,native_tool_receipts:1,unmatched_native_tool_receipts:0,accounted_rmb:.000026})
    const text=readFileSync(join(root,'report/requests/00001.md'),'utf8')
    expect(text).toContain('visible');expect(text).not.toContain('PRIVATE_THOUGHT');expect(text).not.toContain('PRIVATE_CREDENTIAL')
  }finally{rmSync(root,{recursive:true,force:true})}
})
