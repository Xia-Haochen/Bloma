import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import {it,expect} from 'vitest'
import {createNativeTestScope} from '../../main/templates/tools/native-test-scope.mjs'

it.each([false,true])('drains real nested node:test cases and preserves failure=%s',failure=>{
  const root=mkdtempSync(join(tmpdir(),'native-scope-')),trace=join(root,'trace.json'),file=join(root,'case.mjs')
  try{
    writeFileSync(file,`import {test} from 'node:test';import assert from 'node:assert/strict';import {writeFileSync} from 'node:fs';import {createNativeTestScope} from ${JSON.stringify(pathToFileURL(resolve('main/templates/tools/native-test-scope.mjs')).href)};
const scope=createNativeTestScope(),order=[];
await test('suite',async t=>{try{await scope.run(async()=>{scope.register(()=>t.test('group',async group=>{await scope.run(async()=>{scope.register(()=>group.test('case',async()=>{await new Promise(r=>setTimeout(r,25));order.push('assertion');assert.equal(1,${failure?2:1})}))})}))})}finally{order.push('closed');writeFileSync(${JSON.stringify(trace)},JSON.stringify(order))}});`)
    let code=0;try{execFileSync(process.execPath,['--test',file],{stdio:'pipe',timeout:10000})}catch(error){code=error.status}
    expect(code).toBe(failure?1:0);expect(JSON.parse(readFileSync(trace,'utf8'))).toEqual(['assertion','closed'])
  }finally{rmSync(root,{recursive:true,force:true})}
})
it('rejects late registration and retains setup errors after outstanding work drains',async()=>{
  const scope=createNativeTestScope();let finished=false,late
  await expect(scope.run(async()=>{scope.register(()=>new Promise(r=>setTimeout(()=>{finished=true;r()},10)));throw Error('setup failed')})).rejects.toThrow('setup failed')
  expect(finished).toBe(true)
  await scope.run(()=>{late=new Promise(resolve=>setTimeout(()=>{try{scope.register(()=>Promise.resolve());resolve('wrong')}catch(error){resolve(error.message)}},10))})
  expect(await late).toContain('LATE_REGISTRATION')
})
