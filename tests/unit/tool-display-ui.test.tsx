// @vitest-environment jsdom
import React from 'react'
import { render,screen,cleanup,fireEvent } from '@testing-library/react'
import { afterEach,it,expect } from 'vitest'
import { ToolCallFeed,ToolBlocksReplay,ToolCallRow } from '../../renderer/components/ToolCallBlock'
import { formatToolFeedback } from '../../shared/tool-feedback'
import type { ToolDisplay } from '../../shared/tool-display'
import type { AgentEvent } from '../../shared/types'
afterEach(cleanup)
const changes:ToolDisplay={version:1,kind:'changes',files:[{path:'src/a.ts',before:'a'.repeat(64),after:'b'.repeat(64),created:false,omitted:false,line:2,removed:'old <script>not executed</script>\n',added:'new value\n'}]}
it('shows actual changes in live and history with keyboard-accessible disclosure, never treating a request as an applied edit',()=>{
 render(<ToolCallRow tool="edit_file" status="error" outputSummary="PARTIAL" display={changes}/>)
 fireEvent.click(screen.getByRole('button'));expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true')
 expect(screen.getByLabelText('移除内容').textContent).toContain('<script>');expect(document.querySelector('script')).toBeNull()
 expect(screen.getByText(/本次实际提交/)).toBeTruthy();expect(screen.getByText(/src\/a.ts/)).toBeTruthy()
 cleanup();render(<ToolBlocksReplay blocks={[{type:'tool_use',id:'write',name:'edit_file',input:{path:'not-written.ts',old_string:'old',new_string:'new'}}]}/>)
 expect(screen.getByText('调用已登记')).toBeTruthy();fireEvent.click(screen.getByRole('button'));expect(screen.queryByLabelText('实际提交差异')).toBeNull()
 cleanup();render(<ToolBlocksReplay toolNamesById={{write:'edit_file'}} blocks={[{type:'tool_result',tool_use_id:'write',content:'written',tool_display:changes}]}/>)
 fireEvent.click(screen.getByRole('button'));expect(screen.getByLabelText('实际提交差异')).toBeTruthy()
})
it('presents running/exit/error and a non-replaying log query without HTML or implicit verification',()=>{
 const process:ToolDisplay={version:1,kind:'process',id:'process-owned',state:'failed',exit_code:2,preview:'<img src=x onerror=alert(1)>\nactual error',truncated:true,log_available:true,log_complete:false}
 render(<ToolCallRow tool="run_command" status="error" feedback={{schema_version:1,execution:'failed',verification:'not_applicable'}} display={process}/>)
 fireEvent.click(screen.getByRole('button'));expect(screen.getByText('进程失败 · 退出码 2')).toBeTruthy()
 expect(document.querySelector('img')).toBeNull();expect(screen.getByText(/不会重启或重放命令/)).toBeTruthy()
 expect(screen.getByText(/有明确缺口/)).toBeTruthy();expect(screen.queryByText('已报告检查通过')).toBeNull()
})
it('does not drop host feedback in the event feed or combine same-name tool ids',()=>{
 const event=(type:string,id:string,payload:Record<string,unknown>):AgentEvent=>({event_id:`${type}:${id}`,session_id:'test',created_at:'2026-11-11T00:00:00Z',type:type as AgentEvent['type'],payload:{tool:'run_command',turn:1,tool_call_id:id,...payload}})
 render(<ToolCallFeed events={[event('tool_call_started','a',{}),event('tool_call_started','b',{}),event('tool_call_completed','a',{status:'ok',feedback:{schema_version:1,execution:'running',verification:'not_applicable'},display:{version:1,kind:'process',id:'owned',state:'running',preview:'waiting',truncated:false,log_available:true,log_complete:true}}),event('tool_call_completed','b',{status:'error',output_summary:formatToolFeedback({schema_version:1,execution:'not_run',verification:'unverified',category:'budget'},'blocked'),feedback:{schema_version:1,execution:'not_run',verification:'unverified',category:'budget'}})]}/>)
 expect(screen.getByText('进行中')).toBeTruthy();expect(screen.getByText('额度保护未放行')).toBeTruthy()
 const buttons=screen.getAllByRole('button');expect(buttons).toHaveLength(2);fireEvent.click(buttons[1]!);expect(screen.getByText('blocked')).toBeTruthy()
 expect(screen.queryByText(/<tool-feedback>/)).toBeNull()
})
