import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createProject } from '../../main/project/project-service'
import { createToolState, type ToolContext } from '../../main/agent/loop/agent-loop'
import { buildAgentTools, createWriteScope, setJsSyntaxCheckerForTests } from '../../main/agent/tools/agent-tools'
import { contentRevision, fileRevisionMatches } from '../../main/agent/tools/write-lease'
import { replaceMultipleTexts, replaceUniqueText } from '../../main/agent/tools/text-edit'
import { restorePromaHome } from '../support/proma-home-guard'

const original = process.env.PROMA_HOME
let home: string
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bloma-batch-edit-')); process.env.PROMA_HOME = home; setJsSyntaxCheckerForTests(async () => ({ ok: true })) })
afterEach(() => { setJsSyntaxCheckerForTests(); restorePromaHome(original); rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
function fixture(options: Partial<Parameters<typeof buildAgentTools>[0]> = {}) {
  const project = createProject({ request_id: 'edits', mode: 'quick' }), file = join(project.root_path, 'src/app.js')
  mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'const first = 1\r\nconst second = 2\n')
  const tools = buildAgentTools({ projectId: project.project_id, software: true, realFullstackVariant: true, ...options })
  const controller = new AbortController()
  const ctx: ToolContext = { projectId: project.project_id, sessionId: 'edit', requestId: 'edit', signal: controller.signal, state: createToolState() }
  const read = () => tools.find(t => t.name === 'read_file')!.execute({ path: 'src/app.js' }, ctx)
  const edit = (input: Record<string, unknown>) => tools.find(t => t.name === 'edit_file')!.execute({ path: 'src/app.js', ...input }, ctx)
  return { project, file, tools, ctx, controller, read, edit }
}
const edits = [{ old_string: 'first = 1', new_string: 'first = 3' }, { old_string: 'second = 2', new_string: 'second = 4' }]
it('applies all spans against the original and validates/writes once without changing unrelated endings', async () => {
  const f = fixture(); await f.read()
  const syntax = vi.fn(async () => ({ ok: true as const })); setJsSyntaxCheckerForTests(syntax)
  expect((await f.edit({ edits })).isError).not.toBe(true)
  expect(readFileSync(f.file, 'utf8')).toBe('const first = 3\r\nconst second = 4\n')
  expect(syntax).toHaveBeenCalledTimes(1)
  expect(f.ctx.state.file_revisions?.get('src/app.js')).toBe(contentRevision(readFileSync(f.file)))
})
it('rejects ambiguity/overlap/malformed edits before any write', async () => {
  const f = fixture(); await f.read(); const original = readFileSync(f.file)
  for (const input of [{ edits: [edits[0], { old_string: 'missing', new_string: 'x' }] },
    { edits: [edits[0], { old_string: 'const first = 1', new_string: 'x' }] },
    { edits: [] }, { edits, old_string: 'first', new_string: 'x' }, { edits: [{ old_string: 'first' }] }]) {
    expect((await f.edit(input)).isError).toBe(true); expect(readFileSync(f.file)).toEqual(original)
  }
  expect(replaceUniqueText('aaa', 'aa', 'x')).toEqual({ ok: false, matches: 2 })
  expect(replaceMultipleTexts('a\nb a\r\nb', [{ old_string: 'a\nb', new_string: 'x' }]).ok).toBe(false)
  expect(replaceMultipleTexts('abcd', [{ old_string: 'ab', new_string: 'X' }, { old_string: 'cd', new_string: 'Y' }])).toEqual({ ok: true, content: 'XY' })
})
it('requires content identity for batch edits; keeps legacy single-span stat compatibility explicit', async () => {
  const f = fixture()
  expect((await f.edit({ edits })).output).toContain('CONTENT_REVISION_REQUIRED')
  const stat = statSync(f.file), legacy = `${stat.mtimeMs.toString(16)}-${stat.size.toString(16)}`
  expect(fileRevisionMatches(f.file, legacy)).toBe(true)
  expect((await f.edit({ edits, expected_revision: legacy })).output).toContain('CONTENT_REVISION_REQUIRED')
  expect((await f.edit({ ...edits[0], expected_revision: legacy })).isError).not.toBe(true)
})
it('detects changed same-length bytes with an explicitly restored timestamp', async () => {
  const f = fixture(); await f.read(); const stat = statSync(f.file)
  writeFileSync(f.file, 'const first = 9\r\nconst second = 2\n'); utimesSync(f.file, stat.atime, stat.mtime)
  expect((await f.edit({ edits })).output).toContain('STALE_READ')
  expect(readFileSync(f.file, 'utf8')).toContain('first = 9')
})
it('rejects deletion or a concurrent same-size rewrite during asynchronous validation', async () => {
  const f = fixture(); await f.read()
  setJsSyntaxCheckerForTests(async () => { const stat = statSync(f.file); writeFileSync(f.file, 'const first = 9\r\nconst second = 2\n'); utimesSync(f.file, stat.atime, stat.mtime); return { ok: true } })
  expect((await f.edit({ edits })).output).toContain('STALE_READ')
  expect(readFileSync(f.file, 'utf8')).toContain('first = 9')
  await f.read()
  setJsSyntaxCheckerForTests(async () => { rmSync(f.file); return { ok: true } })
  expect((await f.edit({ edits: [{ old_string: 'first = 9', new_string: 'first = 3' }] })).output).toContain('STALE_READ')
})
it('retains write scope, host frozen-file checks and cancellation after validation', async () => {
  const denied = fixture({ writeScope: createWriteScope(['other.js']) }); await denied.read()
  expect((await denied.edit({ edits })).output).toContain('WRITE_SCOPE_DENIED')
  const check = vi.fn(() => { throw Error('FROZEN_TEST_WRITE_DENIED') })
  const frozen = fixture({ assertFileWrite: check }); await frozen.read()
  await expect(frozen.edit({ edits })).rejects.toThrow('FROZEN_TEST_WRITE_DENIED')
  expect(readFileSync(frozen.file, 'utf8')).toContain('first = 1')
  const cancelled = fixture(); await cancelled.read()
  setJsSyntaxCheckerForTests(async () => { cancelled.controller.abort(); return { ok: true } })
  await expect(cancelled.edit({ edits })).rejects.toThrow()
  expect(readFileSync(cancelled.file, 'utf8')).toContain('first = 1')
})
it('rejects internal junction aliases, including new files, before writing through an alternate scope', async () => {
  const f = fixture()
  symlinkSync(join(f.project.root_path, 'src'), join(f.project.root_path, 'alias'), 'junction')
  const read = f.tools.find(t => t.name === 'read_file')!, write = f.tools.find(t => t.name === 'write_file')!
  await read.execute({ path: 'alias/app.js' }, f.ctx)
  expect((await write.execute({ path: 'alias/app.js', content: 'const changed = 1' }, f.ctx)).output).toContain('PATH_ALIAS_WRITE_DENIED')
  expect((await write.execute({ path: 'alias/new.js', content: 'const changed = 1' }, f.ctx)).output).toContain('PATH_ALIAS_WRITE_DENIED')
  expect(readFileSync(f.file, 'utf8')).toContain('first = 1')
})
it('does not apply a later span to bytes introduced by an earlier replacement', () => {
  const result = replaceMultipleTexts('one two', [{ old_string: 'one', new_string: 'two' }, { old_string: 'two', new_string: 'three' }])
  expect(result).toEqual({ ok: true, content: 'two three' })
})

async function multiple(f:ReturnType<typeof fixture>){
  for(const name of ['two','three'])writeFileSync(join(f.project.root_path,`src/${name}.js`),`const ${name} = 1\n`)
  const paths=['src/app.js','src/two.js','src/three.js']
  await f.tools.find(t=>t.name==='read_file')!.execute({files:paths.map(path=>({path}))},f.ctx)
  return paths.map((path,index)=>({path,edits:[{old_string:index===0?'first = 1':`${index===1?'two':'three'} = 1`,new_string:index===0?'first = 7':`${index===1?'two':'three'} = 7`}]}))
}
it('prechecks every file and validates each once before ordered nontransactional writes',async()=>{
 const f=fixture(),files=await multiple(f),syntax=vi.fn(async()=>({ok:true as const}));setJsSyntaxCheckerForTests(syntax)
 const tool=f.tools.find(t=>t.name==='edit_file')!,result=JSON.parse((await tool.execute({files},f.ctx)).output)
 expect(result).toMatchObject({code:'EDIT_MULTI_APPLIED',atomic:false,applied:files.map(file=>file.path)})
 expect(syntax).toHaveBeenCalledTimes(3)
 for(const file of files)expect(readFileSync(join(f.project.root_path,file.path),'utf8')).toContain('= 7')
})
it('any preflight ambiguity, duplicate, scope or frozen-file refusal leaves all files untouched',async()=>{
 const f=fixture(),files=await multiple(f),tool=f.tools.find(t=>t.name==='edit_file')!
 files[1].edits[0].old_string='missing'
 expect(JSON.parse((await tool.execute({files},f.ctx)).output).code).toBe('EDIT_MULTI_PREFLIGHT_FAILED')
 expect(readFileSync(f.file,'utf8')).toContain('first = 1')
 expect((await tool.execute({files:[files[0],files[0]]},f.ctx)).output).toContain('DUPLICATE_PATH')
 const guarded=fixture({assertFileWrite:(path)=>{if(path==='src/two.js')throw Error('FROZEN_TEST_WRITE_DENIED')}}),guardedFiles=await multiple(guarded)
 expect((await guarded.tools.find(t=>t.name==='edit_file')!.execute({files:guardedFiles},guarded.ctx)).output).toContain('FROZEN_TEST_WRITE_DENIED')
 expect(readFileSync(guarded.file,'utf8')).toContain('first = 1')
})
it('returns exact applied/failed/not-attempted facts without rolling back an external rewrite',async()=>{
 let f:ReturnType<typeof fixture>
 f=fixture({onProjectFilesChanged:()=>writeFileSync(join(f.project.root_path,'src/two.js'),'const two = 9\n')})
 const files=await multiple(f),result=JSON.parse((await f.tools.find(t=>t.name==='edit_file')!.execute({files},f.ctx)).output)
 expect(f.ctx.state.successful_file_changes).toEqual(['src/app.js']);expect(result.code).toBe('EDIT_MULTI_PARTIAL');expect(result.results.map((item:{state:string})=>item.state)).toEqual(['applied','failed','not_attempted'])
 expect(readFileSync(f.file,'utf8')).toContain('first = 7');expect(readFileSync(join(f.project.root_path,'src/two.js'),'utf8')).toContain('two = 9')
 expect(readFileSync(join(f.project.root_path,'src/three.js'),'utf8')).toContain('three = 1')
})
it('reports partial application on cancellation and never attempts the remaining files',async()=>{
 let f:ReturnType<typeof fixture>;f=fixture({onProjectFilesChanged:()=>f.controller.abort()})
 const files=await multiple(f),result=JSON.parse((await f.tools.find(t=>t.name==='edit_file')!.execute({files},f.ctx)).output)
 expect(f.ctx.state.successful_file_changes).toEqual(['src/app.js']);expect(result.code).toBe('EDIT_MULTI_PARTIAL');expect(result.applied).toEqual(['src/app.js'])
 expect(readFileSync(join(f.project.root_path,'src/two.js'),'utf8')).toContain('two = 1')
})
