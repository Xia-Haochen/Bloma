import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { parseLeanBrief } from '../../../main/guide/lean-brief'
import { parseSketchHtml, sketchFormatIssues } from '../../../main/guide/ux-sketch'
import { callLlmForJson, type LlmAttemptFailure } from '../../../main/kernel/llm-call'
import { createProject } from '../../../main/project/project-service'
import { leanBudget } from '../../../main/desktop/lean-budget'
import { organizedPrd } from '../../support/organized-prd'
import type { PrdBackplane } from '../../../main/model/prd-backplane'
import { canonicalFindingReference } from '../../../main/software/quality-reference'

const base='tests/fixtures/personal-wish/failures/'
const previous: PrdBackplane={project_id:'fixture',name:'',positioning:'',requirements:[],acceptance:{},out_of_scope:[],assumptions:[]}
it('normalizes the real redundant finding ID without dropping conflicting IDs or other fields',()=>{
  const raw=JSON.parse(readFileSync(base+'doodle-review-reference-alias.json','utf8'))
  for(const finding of raw.findings){const canonical=canonicalFindingReference(finding);expect(canonical.requirement).toBe(finding.requirement);expect(canonical).not.toHaveProperty('requirement_id');expect(canonical.evidence).toBe(finding.evidence)}
  expect(canonicalFindingReference({requirement_id:'F-001'})).toEqual({requirement:'F-001'})
  expect(()=>canonicalFindingReference({requirement:'F-001',requirement_id:'F-002'})).toThrow('CONFLICT')
})
it('extracts one complete real HTML artifact without trusting surrounding prose or permitting ambiguous/active content',()=>{
  const raw=readFileSync(base+'doodle-sketch-prefaced.txt','utf8')
  const parsed=parseSketchHtml(raw)
  expect(parsed?.html.startsWith('<!DOCTYPE html>')).toBe(true)
  expect(parsed?.html.endsWith('</html>')).toBe(true)
  expect(parsed?.html).not.toContain('优化建议')
  expect(parseSketchHtml('```html\n<html><body>A</body></html>\n```\n```html\n<html><body>B</body></html>\n```')).toBeUndefined()
  expect(parseSketchHtml(raw+'\n```html\n<html><body>another</body></html>\n```')).toBeUndefined()
  expect(parseSketchHtml(raw.replace('</body>','<script>alert(1)</script></body>'))).toBeUndefined()
  expect(parseSketchHtml(raw.replace('</body>','<button onclick="alert(1)">click</button></body>'))).toBeUndefined()
})
it('accepts the recorded business task without forcing a structure declaration while retaining explicit legacy contracts',()=>{
  const raw=readFileSync(base+'doodle-brief-missing-model.json','utf8'),issues:string[]=[]
  const context={projectId:'fixture',sessionId:'s',source:'绘画速度和颜色控制声音，旧画可选规则版本',previous,software:true,onIssues:(rows:string[])=>issues.push(...rows)}
  expect(parseLeanBrief(raw,context)?.action).toBe('brief');expect(issues).toEqual([])
  const data=JSON.parse(raw);data.intent_assessment={mode:'structured',reason:'存在自定义映射与规则版本',source_ids:['S-001']}
  expect(parseLeanBrief(JSON.stringify(data),context)?.action).toBe('brief')
  const model=organizedPrd(data.requirements,'用户来源').requirements_model
  model.experience={summary:'绘画成为乐器',commitments:[{id:'EXP-001',statement:'图形驱动声音',feature_ids:['F-001'],source_ids:['S-001'],scenario_ids:['AC-001'],unacceptable_substitute:'静态图画'}]}
  data.requirements_model=model
  expect(parseLeanBrief(JSON.stringify(data),context)?.action).toBe('brief')
})
it('replays real truncated prefaced HTML, retains strict rejection, and reports provider output exhaustion distinctly',async()=>{
  const raw=readFileSync(base+'doodle-sketch-truncated.txt','utf8'),failures:LlmAttemptFailure[]=[]
  expect(parseSketchHtml(raw)).toBeUndefined()
  expect(sketchFormatIssues(raw).join()).toContain('OUTPUT_FORMAT_PREFIX')
  expect(sketchFormatIssues(raw).join()).toContain('HTML_INCOMPLETE')
  await callLlmForJson({systemPrompt:'strict HTML',prompt:'preview',env:{},sessionId:'s',maxTokens:16384,temperature:0,attempts:1,parse:parseSketchHtml,onAttemptFailure:f=>failures.push(f),query:async function*(){
    yield{type:'assistant',message:{role:'assistant',content:[{type:'text',text:raw}]}}
    yield{type:'result',subtype:'success',stop_reason:'max_tokens',usage:{input_tokens:1397,output_tokens:16384}}
  }})
  expect(failures[0]).toMatchObject({kind:'unparseable',termination:'output_limit'})
})
it('admits responses above 16K in software-v1 while retaining the shared cumulative output account',async()=>{
  const old=process.env.PROMA_HOME,home=mkdtempSync(join(tmpdir(),'bloma-output-limit-'));process.env.PROMA_HOME=home
  try{
    const p=createProject({request_id:'r',mode:'quick'},{workflowVersion:'software-v1'}),budget=leanBudget(p.project_id,'prepare');let received=0
    for await(const _ of budget.wrap(async function*(_prompt,options){received=options.maxTokens!;yield{type:'result',subtype:'success',usage:{input_tokens:1,output_tokens:24000}}})('generate',{env:{},sessionId:'s',signal:AbortSignal.timeout(1000),maxTokens:64000})){}
    expect(received).toBe(64000);expect(budget.snapshot().output).toBe(24000);expect(budget.snapshot().requests).toBe(1)
  }finally{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true})}
})
