// @vitest-environment jsdom
import React from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Provider, createStore } from 'jotai'
import { ProjectExecutionPanel } from '../../renderer/components/ProjectExecutionPanel'
import { activeAgentSessionIdAtom, agentStreamStateFamily } from '../../renderer/agent-atoms'
afterEach(cleanup)
it('distinguishes historical partial checks and ended delegates from delivery and offers scoped cancellation',async()=>{
  const store=createStore();store.set(activeAgentSessionIdAtom,'s');store.set(agentStreamStateFamily('s'),x=>({...x,running:true}))
  const cancel=vi.fn(async()=>({ok:true}));window.electronAPI={agent:{cancel}} as never
  render(<Provider store={store}><ProjectExecutionPanel projectId="p" progress={{environment:'本机项目工作目录',execution:'正在制作',stages:[{id:'one',title:'登记',status:'passed',current_source:false}],next_stage:'two',delegation_count:3,delegations:[{id:'d',reason:'检查数据关系',status:'ended',required_review:true}],observed_strategy_segments:1,note:'整体仍须验收'}}/></Provider>)
  expect(screen.getByText(/此前版本局部检查通过/)).toBeTruthy()
  expect(screen.getByText(/已结束，结果仍须验收/)).toBeTruthy()
  expect(screen.getByText(/累计数量不是同时并发数量/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button',{name:'停止当前制作'}))
  await waitFor(()=>expect(cancel).toHaveBeenCalledWith(expect.objectContaining({project_id:'p',session_id:'s',reason:'user_cancelled'})))
})
