import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, truncateSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createProcessLog, readProcessLog, readProcessLogRecord } from '../../../main/software/process-log'
import { createProcessOutput } from '../../../main/software/process-output'
import { readSoftwareProcessLog, redactSoftwareOutput, softwareProcess, stopSoftwareSession } from '../../../main/software/process-manager'
import { buildSoftwareExecutionTools } from '../../../main/software/execution-tools'
import { createProject } from '../../../main/project/project-service'
import { createToolState } from '../../../main/agent/loop/agent-loop'
import { restorePromaHome } from '../../support/proma-home-guard'
let home: string
const originalHome = process.env.PROMA_HOME
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bloma-process-log-')); process.env.PROMA_HOME = home })
afterEach(() => { restorePromaHome(originalHome); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
it('archives complete redacted records before ring eviction and retrieves bounded ranges/search', () => {
  const id = randomUUID(), log = createProcessLog(id), output = createProcessOutput(redactSoftwareOutput, log.append)
  output.push('stderr', Buffer.from('EARLY_ERROR api_key=PRIVATE_'))
  output.push('stderr', Buffer.from('SECRET\n'))
  for (let n = 0; n < 1000; n++) output.push('stdout', Buffer.from(`line ${n}\n`))
  output.flush()
  expect(JSON.stringify(output.snapshot())).not.toContain('EARLY_ERROR')
  const archived = readProcessLog(id, log.info(), { pattern: 'EARLY_ERROR' })
  expect(archived.output[0].text).toContain('[REDACTED]')
  expect(JSON.stringify(archived)).not.toContain('PRIVATE_SECRET')
  const first = readProcessLog(id, log.info(), { limit: 1 })
  const next = readProcessLog(id, log.info(), { since: first.next_seq, limit: 1 })
  expect(next.output[0].seq).toBe(2)
  expect(log.info()).toMatchObject({ available: true, complete: true, retention: 'until_manual_cleanup' })
  expect(readFileSync(join(home, 'software-process-logs', id + '.jsonl'), 'utf8')).not.toContain('PRIVATE_SECRET')
})
it('never exposes a giant unfinished credential tail after dropping its key prefix', () => {
  const id = randomUUID(), log = createProcessLog(id), output = createProcessOutput(redactSoftwareOutput, log.append)
  output.push('stdout', Buffer.from('api_key=' + 'X'.repeat(70000)))
  output.push('stdout', Buffer.from('PRIVATE_SUFFIX\npublic line\n')); output.flush()
  const retained = readFileSync(join(home, 'software-process-logs', id + '.jsonl'), 'utf8')
  expect(retained).not.toContain('PRIVATE_SUFFIX'); expect(retained).toContain('public line')
  expect(log.info()).toMatchObject({ complete: false, gap: 'long_line' })
})
it('supports lossless character continuation of a full oversized archived record', () => {
  const id = randomUUID(), log = createProcessLog(id), text = '中😀'.repeat(10000)
  log.append({ seq: 1, stream: 'stdout', text })
  expect(readProcessLog(id, log.info(), {}).code).toBe('PROCESS_LOG_RECORD_TOO_LARGE')
  let offset = 0, actual = ''
  for (;;) {
    const part = readProcessLogRecord(id, log.info(), 1, offset)
    expect(part.text.length).toBeLessThanOrEqual(16000); actual += part.text
    if (part.eof) break
    if (!('next_char_offset' in part)) throw Error('expected character continuation')
    offset = part.next_char_offset
  }
  expect(actual).toBe(text)
})
it('keeps explicit gaps/capacity without deleting old evidence or treating corruption as EOF', () => {
  const id = randomUUID(), log = createProcessLog(id)
  for (let seq = 1; seq < 12; seq++) log.append({ seq, stream: 'stdout', text: 'x'.repeat(1024 * 1024) })
  expect(log.info().bytes).toBeLessThanOrEqual(8 * 1024 * 1024)
  expect(log.info()).toMatchObject({ complete: false, gap: 'capacity' })
  for (let n = 1; n < 40; n++) expect(createProcessLog(randomUUID()).info().available).toBe(true)
  writeFileSync(join(home, 'software-process-logs', id + '.jsonl'), 'broken\n')
  expect(() => readProcessLog(id, log.info(), {})).toThrow('PROCESS_LOG_CORRUPT')
})
it('keeps archive ownership on host restart without adopting a persisted PID', () => {
  const project = createProject({ request_id: 'archive-restart', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const id = randomUUID(), log = createProcessLog(id); log.append({ seq: 1, stream: 'stdout', text: 'retained' })
  mkdirSync(join(home, 'software-processes'), { recursive: true })
  writeFileSync(join(home, 'software-processes', id + '.json'), JSON.stringify({ id, projectId: project.project_id, sessionId: 's', state: 'running', pid: process.pid, kind: 'command', stdout: '', stderr: '', log: log.info() }))
  expect(readSoftwareProcessLog(project.project_id, id, 's', {}).state).toBe('interrupted')
  expect(() => readSoftwareProcessLog(project.project_id, id, 'other', {})).toThrow('OWNER_MISMATCH')
})
it('actual managed command preserves early errors, avoids exit log duplication, supports explicit tail, and never restarts', async () => {
  const project = createProject({ request_id: 'archive-command', mode: 'quick' }, { workflowVersion: 'software-v1' })
  const tools = Object.fromEntries(buildSoftwareExecutionTools(project.project_id).map(t => [t.name, t]))
  const ctx = { projectId: project.project_id, sessionId: 's', requestId: 'r', signal: AbortSignal.timeout(30000), state: createToolState() }
  writeFileSync(join(project.root_path, 'once.cjs'), 'require("fs").appendFileSync("starts.txt","1");console.error("EARLY_ERROR token=PRIVATE_SECRET");for(let n=0;n<1000;n++)console.log("ordinary line "+n)')
  const start = JSON.parse((await tools.run_command.execute({ command: ['node', 'once.cjs'], yield_ms: 0, timeout_ms: 10000 }, ctx)).output)
  try {
    await expect.poll(() => softwareProcess(project.project_id, start.process_id, 's').state, { timeout: 15000 }).toBe('exited')
    const done = JSON.parse((await tools.read_process.execute({ process_id: start.process_id }, ctx)).output)
    expect(done.stdout).toBeUndefined(); expect(done.stderr).toBeUndefined()
    const empty = JSON.parse((await tools.read_process.execute({ process_id: start.process_id, since_seq: done.next_seq }, ctx)).output)
    expect(empty.output).toEqual([]); expect(empty.stdout).toBeUndefined()
    const archived = await tools.read_process.execute({ process_id: start.process_id, mode: 'log', pattern: 'EARLY_ERROR' }, ctx)
    expect(archived.isError, archived.output).not.toBe(true); expect(archived.output).toContain('[REDACTED]'); expect(archived.output).not.toContain('PRIVATE_SECRET')
    const tail = JSON.parse((await tools.read_process.execute({ process_id: start.process_id, mode: 'tail' }, ctx)).output)
    expect(tail.stdout).toContain('ordinary line 999'); expect(tail.output).toBeUndefined()
    expect((await tools.read_process.execute({ process_id: start.process_id, mode: 'log' }, { ...ctx, sessionId: 'other' })).isError).toBe(true)
    expect(readFileSync(join(project.root_path, 'starts.txt'), 'utf8')).toBe('1')
  } finally { await stopSoftwareSession(project.project_id, 's') }
}, 40000)

it('counts actual bytes including legacy archives rather than lifetime process slots', () => {
  const dir = join(home, 'software-process-logs'); mkdirSync(dir, {recursive:true})
  for (let n=0;n<16;n++) writeFileSync(join(dir, `slot-${n}`), randomUUID())
  for (let n=0;n<40;n++) {
    const id=randomUUID(),log=createProcessLog(id)
    expect(log.info().available).toBe(true)
    log.append({seq:1,stream:'stdout',text:`record-${n}`})
    expect(readProcessLog(id,log.info(),{}).output[0].text).toBe(`record-${n}`)
  }
  const active=createProcessLog(randomUUID()),old=join(dir,randomUUID()+'.jsonl')
  writeFileSync(old,'');truncateSync(old,128*1024*1024)
  active.append({seq:1,stream:'stdout',text:'cannot exceed home capacity'})
  expect(active.info()).toMatchObject({complete:false,gap:'capacity',bytes:0})
  expect(createProcessLog(randomUUID()).info()).toMatchObject({available:false,gap:'capacity'})
  // Simulate explicit operator cleanup; the writer never deletes old evidence.
  truncateSync(old,0)
  expect(createProcessLog(randomUUID()).info().available).toBe(true)
})

it('serializes actual byte admission across two Node hosts without evicting old evidence', async () => {
  const dir=join(home,'software-process-logs');mkdirSync(dir,{recursive:true})
  const old=join(dir,randomUUID()+'.jsonl');writeFileSync(old,'');truncateSync(old,128*1024*1024-200000)
  const bundle=join(home,'process-log.mjs')
  await build({entryPoints:[fileURLToPath(new URL('../../../main/software/process-log.ts',import.meta.url))],outfile:bundle,bundle:true,platform:'node',format:'esm'})
  const script=`import {createProcessLog} from ${JSON.stringify(pathToFileURL(bundle).href)};import {randomUUID} from 'node:crypto';const log=createProcessLog(randomUUID());log.append({seq:1,stream:'stdout',text:'x'.repeat(150000)});console.log(JSON.stringify(log.info()))`
  const results=await Promise.all([1,2].map(()=>promisify(execFile)(process.execPath,['--input-type=module','-e',script],{env:{...process.env,PROMA_HOME:home},windowsHide:true,timeout:15000})))
  const facts=results.map(r=>JSON.parse(r.stdout))
  expect(facts.filter(f=>f.bytes>0)).toHaveLength(1)
  expect(facts.filter(f=>f.gap==='capacity')).toHaveLength(1)
  expect(readFileSync(old).length).toBe(128*1024*1024-200000)
},30000)

it('archives a complete pipe chunk in one batch while retaining ordered prefix at capacity', () => {
  const id=randomUUID(),log=createProcessLog(id)
  let batches=0
  const output=createProcessOutput(redactSoftwareOutput,undefined,records=>{batches++;log.appendMany(records)})
  output.push('stdout',Buffer.from(Array.from({length:1000},(_,i)=>`row ${i}`).join('\n')+'\n'))
  expect(batches).toBe(1)
  expect(readProcessLog(id,log.info(),{pattern:'row 999'}).output[0].seq).toBe(1000)
  const path=join(home,'software-process-logs',id+'.jsonl');truncateSync(path,8*1024*1024-100)
  log.appendMany([{record:{seq:1001,stream:'stdout',text:'kept'},omitted:false},{record:{seq:1002,stream:'stdout',text:'x'.repeat(100)},omitted:false}])
  expect(log.info()).toMatchObject({complete:false,gap:'capacity'})
  expect(log.info().bytes).toBeLessThanOrEqual(8*1024*1024)
})
