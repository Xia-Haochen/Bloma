import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs'
import {join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {expect,it} from 'vitest'
import {checkNativeTestBindings} from '../../../main/software/native-test-preflight'
import {validateNativeGuiTests} from '../../../main/software/native-gui-tests'
import {freezeNativeGuiTests} from '../../../main/software/native-gui-tests'
import ts from 'typescript'

it.skipIf(!process.env.SOFTWARE_CAMPUS_EVIDENCE_TEST)('replays the original campus scope defects in isolated copies while retaining proposals and monetary bytes',()=>{
 const trial=process.env.SOFTWARE_CAMPUS_EVIDENCE_TEST!,project=JSON.parse(readFileSync(join(trial,'campus/project.json'),'utf8'))
 const statePath=join(trial,'home/software-test-corrections',project.project_id,'state.json'),ledgerPath=join(trial,'monetary-policy.json.state.json')
 const stateBytes=readFileSync(statePath),ledgerBytes=readFileSync(ledgerPath),state=JSON.parse(stateBytes.toString()),folder=mkdtempSync(join(tmpdir(),'campus-original-tests-'))
 const observations:Array<{digest:string;bytes:number;error?:string}>=[]
 try{
  const seen=new Set<string>()
  for(const proposal of state.proposals){const native=proposal.before;if(seen.has(native.digest))continue;seen.add(native.digest);validateNativeGuiTests(native)
   const root=join(folder,native.digest);mkdirSync(root,{recursive:true});let bytes=0
   for(const f of native.files){const target=join(root,f.path);mkdirSync(dirname(target),{recursive:true});const data=readFileSync(join(trial,'home/gui-native-tests',project.project_id,native.digest,f.path));expect(createHash('sha256').update(data).digest('hex')).toBe(f.sha256);writeFileSync(target,data);bytes+=data.length}
   let error:string|undefined;try{checkNativeTestBindings(root,native.files.map((f:{path:string})=>f.path))}catch(e){error=String(e)}
   observations.push({digest:native.digest,bytes,error})
   if(error){
    // Repair only the isolated test adapter's lexical ownership. The archived
    // business cases and their assertion expressions remain byte-for-byte in
    // the function body; this candidate is never approved in the real project.
    const entry=join(root,native.entry),original=readFileSync(entry,'utf8'),ast=ts.createSourceFile(entry,original,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
    const helpers=ast.statements.filter(ts.isFunctionDeclaration),exported=ast.statements.find(ts.isExportAssignment)
    if(!exported||!ts.isArrowFunction(exported.expression)||!ts.isBlock(exported.expression.body))throw Error('CAMPUS_REPLAY_ENTRY_SHAPE_CHANGED')
    const body=exported.expression.body,bodyText=original.slice(body.getStart(ast)+1,body.end-1)
    let repaired=original.slice(0,body.getStart(ast)+1)+helpers.map(h=>h.getText(ast)).join('\n')+'\n'+original.slice(body.getStart(ast)+1)
    for(const helper of [...helpers].reverse())repaired=repaired.slice(0,helper.getFullStart())+repaired.slice(helper.end)
    repaired=repaired.replace('({ test, page, expect, assert, dataDir, evidenceDir, phase })','({ test, page, context, expect, assert, dataDir, evidenceDir, phase })')
    expect(repaired).toContain(bodyText)
    writeFileSync(entry,repaired)
    expect(()=>checkNativeTestBindings(root,native.files.map((f:{path:string})=>f.path))).not.toThrow()
    const manifest=join(dirname(entry),'native-inputs.json');writeFileSync(join(root,'replay-fixture.txt'),'isolated resource')
    writeFileSync(manifest,JSON.stringify({files:['replay-fixture.txt']}))
    const candidate=freezeNativeGuiTests('campus-replay',root,native.entry,[...new Set<string>(native.cases.map((c:{feature:string})=>c.feature))],native.restart)
    expect(candidate.cases.map(c=>[c.name,c.feature])).toEqual(native.cases.map((c:{name:string;feature:string})=>[c.name,c.feature]))
    expect(candidate.files.some(f=>f.path==='replay-fixture.txt')).toBe(true)
   }
  }
  expect(observations.some(o=>o.bytes>42000)).toBe(true)
  expect(observations.some(o=>o.error?.includes('GUI_NATIVE_BINDING_UNDEFINED'))).toBe(true)
  expect(readFileSync(statePath).equals(stateBytes)).toBe(true);expect(readFileSync(ledgerPath).equals(ledgerBytes)).toBe(true)
  console.info(JSON.stringify({scope:'isolated_original_campus_static_replay',snapshots:observations.map(o=>({digest:o.digest,bytes:o.bytes,undefined_bindings:Boolean(o.error)})),
    proposals_unchanged:true,ledger_unchanged:true,product_pass:false,model_requests:0}))
 }finally{rmSync(folder,{recursive:true,force:true})}
})
