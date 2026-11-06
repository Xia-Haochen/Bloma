import type {AgentLoopTool} from '../agent/loop/agent-loop'
import {buildDelegationTools} from '../agent/delegation/delegation-tools'


export function productionAgentTools(executorTools: AgentLoopTool[], extraTools: AgentLoopTool[]): AgentLoopTool[] {
  const tools = [...executorTools.filter(tool => tool.name !== 'ask_delegation_question'), ...buildDelegationTools('parent'), ...extraTools]
  const hostOwned=new Set(['check_quality_finding','start_quality_review','start_visual_review','apply_test_correction','inspect_collaboration_plan'])
  return [...new Map(tools.filter(tool=>!hostOwned.has(tool.name)).map(tool => {
    if(tool.name!=='delegate_agent')return [tool.name,tool] as const
    const schema=tool.input_schema as {properties:Record<string,unknown>}
    const role=schema.properties.role as {enum:string[]}
    return [tool.name,{...tool,input_schema:{...schema,properties:{...schema.properties,role:{...role,enum:role.enum.filter(name=>name!=='review'),description:'探索、调研、实现或自定义子任务；交付审阅由宿主安排。'}}}}] as const
  })).values()]
}
