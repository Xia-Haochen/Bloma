import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runHostLlmProbe } from '../../../main/desktop/llm-verification'
import type { DriverCommandRequest } from '../../../main/desktop/process-driver'
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'bloma-llm-contract-')); writeFileSync(join(root, 'app.py'), '# product') })
afterEach(() => rmSync(root, { recursive: true, force: true }))
const spec = { module: 'app', factory: 'Logic', method: 'enhance', covers: ['F-004'] }
describe('offline model entry evidence', () => {
  it('gives the actual Node client milliseconds sufficient for local HTTP and response validation',async()=>{
    writeFileSync(join(root,'client.cjs'),[
      "class Client {",
      "  async enhance({prompt,config}) {",
      "    if (!config.api_key) return {ok:false,kind:'unconfigured'}",
      "    const signal=AbortSignal.timeout(config.timeout)",
      "    await new Promise(resolve=>setTimeout(resolve,15))",
      "    const response=await fetch(config.endpoint+'/chat/completions',{",
      "      method:'POST',signal,headers:{'content-type':'application/json',authorization:'Bearer '+config.api_key},",
      "      body:JSON.stringify({model:config.model,messages:[{role:'user',content:prompt}]})",
      "    })",
      "    if(!response.ok)return {ok:false,kind:response.status===401?'auth_error':response.status===429?'rate_limited':'model_error'}",
      "    const body=await response.json(),text=body.choices?.[0]?.message?.content",
      "    return text?{ok:true,kind:'success',text}:{ok:false,kind:'invalid_response'}",
      "  }",
      "}",
      "module.exports={Client}",
    ].join('\n'))
    const result=await runHostLlmProbe(root,{runtime:'node',module:'client.cjs',factory:'Client',method:'enhance',covers:['F-004']})
    expect(result.status,JSON.stringify(result)).toBe('passed')
    expect(result.request_count).toBe(5)
    expect(result.tests?.every(row=>row.passed)).toBe(true)
  })
  it('requires host request and error evidence; product PASS cannot substitute it', async () => {
    const names = ['real_request', 'auth_error', 'model_error', 'rate_limited', 'invalid_response', 'unconfigured']
    const response = { probe_version: 1, status: 'passed', request_count: 5, tests: names.map(name => ({ name, passed: true })) }
    const spawn = vi.fn(async (_input: DriverCommandRequest) => ({ code: 0, stdout: JSON.stringify(response), stderr: '' }))
    expect((await runHostLlmProbe(root, spec, spawn)).status).toBe('passed')
    expect(spawn.mock.calls[0]?.[0]?.command).toContain('-B')
    response.request_count = 0
    expect((await runHostLlmProbe(root, spec, spawn)).status).toBe('environment_blocked')
  })
  it('rejects unsafe entry names without launching code', async () => {
    const spawn = vi.fn()
    expect((await runHostLlmProbe(root, { ...spec, module: '../outside' }, spawn)).status).toBe('environment_blocked')
    expect(spawn).not.toHaveBeenCalled()
  })
})
