import { expect, it } from 'vitest'
// @ts-expect-error Standalone offline forensic CLI uses native ESM.
import { auditConvergence } from '../../../scripts/audit-software-convergence.mjs'
it('separates physical retries, unsent queries and unresolved monetary receipts without leaking content',()=>{
  const report=auditConvergence([
    {event:'transport_started',query_id:'q1',session_id:'c'},
    {event:'transport_started',query_id:'q1',session_id:'c'},
    {event:'query_finished',query_id:'q1',session_id:'c',role:'child',usage:{input_tokens:5,output_tokens:3}},
    {event:'query_finished',query_id:'unsent',session_id:'parent',role:'orchestrator'}],
    [{type:'tool_call_started',payload:{tool:'read_file',input_summary:'PRIVATE_PROMPT'}},
      {type:'tool_call_completed',payload:{tool:'read_file',is_error:true,output_summary:'PRIVATE_OUTPUT'}}],
    {reviews:[{id:'r',child:'c',status:'interrupted',identity:{source:'s'}}],findings:[]},
    {entries:[{status:'unknown',charged_micro_rmb:100},{status:'reported',charged_micro_rmb:2}]})
  expect(report).toMatchObject({physical_requests:2,sent_logical_queries:1,unsent_finished_queries:1,accounted_micro_rmb:102,
    receipt_status:{unknown:1,reported:1},roles:{code:{logical_queries:1}},recorded_case_checks:0})
  expect(JSON.stringify(report)).not.toContain('PRIVATE_')
})
