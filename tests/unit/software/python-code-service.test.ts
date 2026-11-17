import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { executeCodeService } from '../../../main/software/code-service-executor'
import { pythonCodeServiceCapabilities } from '../../../main/software/python-code-service'

const executable=process.env.TEST_PYTHON_SEMANTICS_EXECUTABLE,site=process.env.TEST_PYTHON_SEMANTICS_SITE
const keys=['PROMA_HOME','BLOMA_PYTHON_SEMANTICS_EXECUTABLE','BLOMA_PYTHON_SEMANTICS_SITE'] as const
const prior=Object.fromEntries(keys.map(k=>[k,process.env[k]]));let home:string,root:string
beforeAll(()=>{if(!executable||!site)throw Error('Positive Python semantics requires private TEST_PYTHON_SEMANTICS_EXECUTABLE and TEST_PYTHON_SEMANTICS_SITE; do not install into system/shared dependencies')})
beforeEach(()=>{home=mkdtempSync(join(tmpdir(),'bloma-python-semantic-'));root=join(home,'project');mkdirSync(root);process.env.PROMA_HOME=home;process.env.BLOMA_PYTHON_SEMANTICS_EXECUTABLE=executable;process.env.BLOMA_PYTHON_SEMANTICS_SITE=site
 writeFileSync(join(root,'value.py'),'def amount(x):\n    return x + 1\n')
 writeFileSync(join(root,'use.py'),'from value import amount as selected\nresult = selected(4)\n')
})
afterEach(()=>{for(const k of keys){if(prior[k]===undefined)delete process.env[k];else process.env[k]=prior[k]}if(home)rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
const query=(path:string,kind:'definition'|'references'|'diagnostics'|'symbol',extra={})=>executeCodeService(root,{path,kind,...extra})
it('handshakes a pinned real backend; missing configuration does not become lexical semantics',async()=>{
 const c=await pythonCodeServiceCapabilities();expect(c).toMatchObject({available:true,backend:'jedi',jediVersion:'0.19.2',parsoVersion:'0.8.4',diagnostics:'syntax-only',hard_heap_limit:false})
 delete process.env.BLOMA_PYTHON_SEMANTICS_SITE
 expect(await pythonCodeServiceCapabilities()).toMatchObject({available:false})
 expect(await query('use.py','definition',{line:2,column:11})).toMatchObject({ok:false,error:{code:'PYTHON_BACKEND_UNAVAILABLE'}})
})
it('resolves cross-module alias definitions and actual references with versioned UTF16 locations',async()=>{
 const def=await query('use.py','definition',{line:2,column:12});expect(def).toMatchObject({ok:true,backend:'jedi',language:'python',items:[{kind:'definition',name:'amount',location:{path:'value.py',start:{line:1,column:5}}}]})
 const refs=await query('value.py','references',{line:1,column:7});expect(refs.ok).toBe(true);if(!refs.ok)throw Error(JSON.stringify(refs))
 expect(refs.items).toEqual(expect.arrayContaining([expect.objectContaining({kind:'reference',location:expect.objectContaining({path:'use.py'})}),expect.objectContaining({kind:'reference',location:expect.objectContaining({path:'value.py'}),writeAccess:'unknown'})]))
 expect(JSON.stringify(refs)).not.toContain('"isWriteAccess":')
})
it('distinguishes local same-named symbols and excludes definitions when requested',async()=>{
 writeFileSync(join(root,'local.py'),'def first():\n    value = 1\n    return value\ndef second():\n    value = 2\n    return value\n')
 const refs=await query('local.py','references',{line:3,column:13,includeDeclaration:false});expect(refs.ok).toBe(true);if(!refs.ok)throw Error(JSON.stringify(refs));expect(refs.items).toHaveLength(1);expect(refs.items[0]).toMatchObject({location:{start:{line:3}}})
})
it('uses real declaration navigation and only claims syntax diagnostics, not type acceptance',async()=>{
 const symbols=await query('value.py','symbol',{query:'amount'});expect(symbols).toMatchObject({ok:true,items:[{kind:'symbol',name:'amount'}]})
 writeFileSync(join(root,'bad.py'),'def broken(:\n    pass\n');const errors=await query('bad.py','diagnostics');expect(errors.ok).toBe(true);if(!errors.ok)throw Error(JSON.stringify(errors));expect(errors.items).toEqual(expect.arrayContaining([expect.objectContaining({kind:'diagnostic',code:'SyntaxError'})]))
 writeFileSync(join(root,'bad.py'),'value: int = "not an int"\n');expect(await query('bad.py','diagnostics')).toMatchObject({ok:true,items:[]})
})
it('converts astral Unicode positions and rejects a split surrogate',async()=>{
 writeFileSync(join(root,'unicode.py'),'from value import amount\ntext = "😀"; result = amount(1)\n')
 const row=readFileSync(join(root,'unicode.py'),'utf8').split('\n')[1],column=row.indexOf('amount')+2
 expect(await query('unicode.py','definition',{line:2,column})).toMatchObject({ok:true,items:[{name:'amount',location:{path:'value.py'}}]})
 expect(await query('unicode.py','definition',{line:2,column:row.indexOf('😀')+2})).toMatchObject({ok:false,error:{code:'INVALID_POSITION'}})
})
it('does not reuse same-size/mtime changed bytes or changed config and notices new modules',async()=>{
 const first=await query('use.py','symbol');if(!first.ok)throw Error(JSON.stringify(first));const path=join(root,'use.py'),s=statSync(path)
 writeFileSync(path,readFileSync(path,'utf8').replace('result','output'));utimesSync(path,s.atime,s.mtime)
 expect(await query('use.py','symbol',{expectedFileVersion:first.fileVersion})).toMatchObject({ok:false,error:{code:'STALE_FILE_VERSION'}})
 const second=await query('use.py','symbol');if(!second.ok)throw Error(JSON.stringify(second));expect(second.fileVersion).not.toBe(first.fileVersion)
 writeFileSync(join(root,'pyproject.toml'),'[project]\nname="example"\n')
 expect(await query('use.py','symbol',{expectedIndexVersion:second.indexVersion})).toMatchObject({ok:false,error:{code:'STALE_INDEX_VERSION'}})
 const third=await query('use.py','symbol');if(!third.ok)throw Error(JSON.stringify(third));writeFileSync(join(root,'new.py'),'x=1\n')
 expect(await query('use.py','symbol',{expectedIndexVersion:third.indexVersion})).toMatchObject({ok:false,error:{code:'STALE_INDEX_VERSION'}})
})
it('reuses identity only when copied project/config/backend observations match',async()=>{
 const first=await query('use.py','definition',{line:2,column:12});if(!first.ok)throw Error(JSON.stringify(first))
 const same=await query('use.py','definition',{line:2,column:12,expectedFileVersion:first.fileVersion,expectedIndexVersion:first.indexVersion});expect(same).toMatchObject({ok:true,indexVersion:first.indexVersion})
})
it('refuses outside paths and project links instead of reading their targets',async()=>{
 const outside=join(home,'outside.py');writeFileSync(outside,'secret=1\n')
 expect(await query('../outside.py','symbol')).toMatchObject({ok:false,error:{code:'PYTHON_PATH_OUTSIDE_PROJECT'}})
 const directory=join(home,'outside-dir');mkdirSync(directory);writeFileSync(join(directory,'private.py'),'private=1\n');symlinkSync(directory,join(root,'linked'),process.platform==='win32'?'junction':'dir')
 expect(await query('use.py','symbol')).toMatchObject({ok:false,error:{code:'PYTHON_LINK_UNSUPPORTED'}})
})
it('never executes project modules, .pth or sitecustomize and reports missing imports honestly',async()=>{
 const marker=join(home,'executed.txt').replaceAll('\\','/'),evil=`from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("executed")\ndef safe():\n    return 1\n`
 writeFileSync(join(root,'value.py'),evil);writeFileSync(join(root,'use.py'),'from value import safe\nx=safe()\n');writeFileSync(join(root,'sitecustomize.py'),evil);writeFileSync(join(root,'evil.pth'),`import pathlib; pathlib.Path(${JSON.stringify(marker)}).write_text('executed')`)
 expect(await query('use.py','definition',{line:2,column:4})).toMatchObject({ok:true,items:[{name:'safe'}]});expect(existsSync(marker)).toBe(false)
 writeFileSync(join(root,'use.py'),'from not_installed_here import unavailable\nx=unavailable()\n')
 const missing=await query('use.py','definition',{line:2,column:4});expect(missing).toMatchObject({ok:true,items:[]});if(missing.ok)expect(missing.limitations.join(' ')).toContain('Missing imports')
 expect(existsSync(join(root,'__pycache__'))).toBe(false)
})
it('honors cancellation/deadlines, drains owned children and releases the shared two-query slots',async()=>{
 expect(await executeCodeService(root,{kind:'symbol',path:'use.py'},{signal:AbortSignal.abort()})).toMatchObject({ok:false,error:{code:'CANCELLED'}})
 const ctl=new AbortController();const running=query('use.py','symbol');const cancel=executeCodeService(root,{kind:'symbol',path:'value.py'},{signal:ctl.signal})
 expect(await query('use.py','symbol')).toMatchObject({ok:false,error:{code:'CODE_SERVICE_BUSY'}});setTimeout(()=>ctl.abort(),20)
 expect(await cancel).toMatchObject({ok:false,error:{code:'CANCELLED'}});expect((await running).ok).toBe(true)
 expect(await executeCodeService(root,{kind:'symbol',path:'use.py'},{timeoutMs:10})).toMatchObject({ok:false,error:{code:'DEADLINE_EXCEEDED'}})
 expect((await query('use.py','symbol')).ok).toBe(true)
 const directory=join(home,'software-code-service');expect(readdirSync(directory)).toEqual([])
})
it('rejects stale results if original source changes while the fixed backend is running',async()=>{
 const pending=query('use.py','symbol');await new Promise<void>(resolve=>setTimeout(resolve,100));writeFileSync(join(root,'use.py'),'changed=42\n')
 expect(await pending).toMatchObject({ok:false,error:{code:'STALE_INDEX_VERSION'}})
})
it('rejects tampering with the disposable analysis copy, not just changes to the original',async()=>{
 const pending=query('use.py','symbol'),directory=join(home,'software-code-service');let copied:string|undefined
 for(let n=0;n<100;n++){if(existsSync(directory)){const child=readdirSync(directory).find(name=>name.startsWith('python-'));if(child){const candidate=join(directory,child,'source','value.py');if(existsSync(candidate)){copied=candidate;break}}}await new Promise<void>(resolve=>setTimeout(resolve,10))}
 expect(copied).toBeDefined();writeFileSync(copied!,'def changed(x): return x'+String.fromCharCode(10))
 expect(await pending).toMatchObject({ok:false,error:{code:'PYTHON_SNAPSHOT_CHANGED'}})
})
it('limits file bytes, output items and malformed options without a fallback',async()=>{
 writeFileSync(join(root,'large.py'),'x'.repeat(1024*1024+1));expect(await query('use.py','symbol')).toMatchObject({ok:false,error:{code:'PYTHON_FILE_BYTE_LIMIT'}});rmSync(join(root,'large.py'))
 writeFileSync(join(root,'many.py'),Array.from({length:90},(_,i)=>`def f${i}(): pass`).join('\n'))
 const limited=await query('many.py','symbol',{limit:3});expect(limited).toMatchObject({ok:true,truncated:true});if(limited.ok)expect(limited.items).toHaveLength(3)
 expect(await query('use.py','symbol',{limit:0})).toMatchObject({ok:false,error:{code:'INVALID_REQUEST'}})
})

it('declares project stubs and non-UTF8 coding directives unsupported instead of mis-decoding names',async()=>{
 writeFileSync(join(root,'legacy.py'),'# coding: latin1'+String.fromCharCode(10)+'value=1'+String.fromCharCode(10))
 expect(await query('legacy.py','symbol')).toMatchObject({ok:false,error:{code:'PYTHON_ENCODING_UNSUPPORTED'}})
 expect(await query('types.pyi','symbol')).toMatchObject({ok:false,error:{code:'PYTHON_STUBS_UNSUPPORTED'}})
})
it('keeps BOM/CRLF byte identity while reporting source UTF16 coordinates',async()=>{
 writeFileSync(join(root,'bom.py'),String.fromCharCode(0xfeff)+'def amount(x):'+String.fromCharCode(13,10)+'    return x+1'+String.fromCharCode(13,10))
 const symbols=await query('bom.py','symbol',{query:'amount'});expect(symbols).toMatchObject({ok:true,items:[{name:'amount',location:{start:{line:1,column:6}}}]})
 expect(await query('bom.py','definition',{line:1,column:8})).toMatchObject({ok:true,items:[{name:'amount',location:{start:{line:1,column:6}}}]})
})
it('does not replace a broken configured backend with a lexical answer and frees the slot',async()=>{
 const empty=join(home,'empty-site');mkdirSync(empty);process.env.BLOMA_PYTHON_SEMANTICS_SITE=empty
 expect(await query('use.py','symbol')).toMatchObject({ok:false,error:{code:'PYTHON_BACKEND_START_FAILED'}})
 process.env.BLOMA_PYTHON_SEMANTICS_SITE=site;expect((await query('use.py','symbol')).ok).toBe(true)
 expect(await executeCodeService(root,{kind:'symbol',path:'use.py'},{timeoutMs:0})).toMatchObject({ok:false,error:{code:'INVALID_OPTIONS'}})
})
