import {it,expect} from 'vitest'
import {productionAgentTools} from '../../../main/desktop/production-tool-assembly'
import type {AgentLoopTool} from '../../../main/agent/loop/agent-loop'
const tool=(name:string):AgentLoopTool=>({name,description:name,input_schema:{type:'object',properties:{}},execute:async()=>({output:'fixture'})})
it('keeps implementation and evidence tools while host scheduling and approved application stay private',()=>{
 const names=productionAgentTools(['verify_app','inspect_app','apply_test_correction','read_test_contract','propose_test_correction'].map(tool),['start_quality_review','start_visual_review','check_quality_finding','inspect_collaboration_plan','read_quality_findings'].map(tool)).map(t=>t.name)
 expect(names).toEqual(expect.arrayContaining(['verify_app','inspect_app','read_test_contract','propose_test_correction','read_quality_findings']))
 for(const name of ['start_quality_review','start_visual_review','check_quality_finding','inspect_collaboration_plan','apply_test_correction'])expect(names).not.toContain(name)
})

it('does not advertise delivery review as a maker-selected delegation role',()=>{
 const delegate=productionAgentTools([],[]).find(t=>t.name==='delegate_agent')!
 const schema=delegate.input_schema as {properties:{role:{enum:string[]}}}
 expect(schema.properties.role.enum).not.toContain('review')
 expect(schema.properties.role.enum).toContain('implement')
})
