import { it, expect } from 'vitest'
import { nativeGuiObservations } from '../../../main/software/native-gui-tests'
import { guiFeatureResults } from '../../../main/desktop/gui-feature-results'
import { verificationFailure } from '../../../main/software/verification-diagnostics'
it('classifies parent-cancelled child tests with zero assertions as unverified execution, not business assertion failure',()=>{
  const result=nativeGuiObservations(suite,[{code:1,events:JSON.stringify({type:'test:fail',name:'F-001 save',error:'test did not finish before its parent and was cancelled'}),trace:'{"interactions":0,"assertions":0,"cases":[{"name":"F-001 save","assertions":0,"interactions":0}]}'}])
  expect(result.status).toBe('unverified');expect(result.failure_kind).toBe('incomplete')
  expect(result.case_results[0].status).toBe('unverified');expect(result.error).toContain('EXECUTION_INCOMPLETE')
  expect(verificationFailure({status:result.status,summary:result.error!,core:{host_gui:result}} as never)?.category).not.toBe('product_assertion')
})
const suite={covers:['F-001','F-002','F-003'],native_tests:{cases:[{name:'F-001 save',feature:'F-001'},{name:'F-002 reject',feature:'F-002'},{name:'F-003 reopen',feature:'F-003'}]}} as never
it('requires restart phase evidence and retains passed cases across intentional phase skips',()=>{
  const one={covers:['F-001'],native_tests:{restart:true,cases:[{name:'F-001 save',feature:'F-001'},{name:'F-001 reopen',feature:'F-001'}]}} as never
  const report=(name:string,skip:string)=>({code:0,events:[{type:'test:pass',name},{type:'test:pass',name:skip,skip:true}].map(row=>JSON.stringify(row)).join('\n'),trace:JSON.stringify({interactions:1,assertions:1,cases:[{name,interactions:1,assertions:1}]})})
  const first=report('F-001 save','F-001 reopen'),second=report('F-001 reopen','F-001 save')
  const result=nativeGuiObservations(one,[first,second])
  expect(result.status).toBe('passed');expect(result.case_results.map(row=>row.status)).toEqual(['passed','passed'])
  const single={covers:['F-001'],native_tests:{restart:true,cases:[{name:'F-001 save',feature:'F-001'}]}} as never
  const only={...first,events:JSON.stringify({type:'test:pass',name:'F-001 save'})}
  expect(nativeGuiObservations(single,[only]).error).toContain('GUI_NATIVE_PHASE_INCOMPLETE')
})
it.each(['cancelledByParent','testTimeoutFailure'])('uses Node failure type %s even with assertion-shaped diagnostics',failure_type=>{
  const result=nativeGuiObservations(suite,[{code:1,events:JSON.stringify({type:'test:fail',name:'F-001 save',failure_type,error:'execution ended',assertion:{}}),trace:JSON.stringify({interactions:0,assertions:0,cases:[]})}])
  expect(result.status).toBe('unverified');expect(result.case_results[0].status).toBe('unverified')
})
function observed(){return nativeGuiObservations(suite,[{code:1,events:[{type:'test:pass',name:'F-001 save'},{type:'test:fail',name:'F-002 reject',error:'expected actual',assertion:{expected:'required',actual:'accepted'}}].map(row=>JSON.stringify(row)).join('\n'),
  trace:JSON.stringify({interactions:2,assertions:1,cases:[{name:'F-001 save',interactions:1,assertions:1},{name:'F-002 reject',interactions:1,assertions:0}]})}])}
it('keeps completed, failed and unexecuted native cases distinct while the whole suite fails',()=>{
  const result=observed();expect(result.status).toBe('failed');expect(result.case_results.map(row=>row.status)).toEqual(['passed','failed','not_run'])
  const rows=guiFeatureResults({...result,version:1,scope:'host_native_gui_business',suite_hash:'a',covers:['F-001','F-002','F-003'],source_unchanged:true})
  expect(rows.map(row=>row.status)).toEqual(['passed','failed','unverified']);expect(rows[2].not_run).toBe(true)
})
it('does not promote zero-assertion, skipped or missing cases into passed features',()=>{
  const result=nativeGuiObservations(suite,[{code:0,events:JSON.stringify({type:'test:pass',name:'F-001 save',skip:true}),trace:JSON.stringify({interactions:1,assertions:0,cases:[]})}])
  expect(result.status).toBe('unverified');expect(result.case_results.every(row=>row.status==='not_run')).toBe(true)
  const rows=guiFeatureResults({...result,version:1,scope:'host_native_gui_business',suite_hash:'a',covers:['F-001','F-002','F-003'],source_unchanged:true})
  expect(rows.every(row=>row.status==='unverified')).toBe(true)
})
it('invalidates passed case claims on runtime errors or changed source and keeps legacy failures conservative',()=>{
  const gui={...observed(),version:1 as const,scope:'host_native_gui_business' as const,suite_hash:'a',covers:['F-001','F-002','F-003'],source_unchanged:false}
  expect(guiFeatureResults(gui)[0].status).toBe('unverified')
  expect(guiFeatureResults({...gui,source_unchanged:true,failure_kind:'runtime'})[0].status).toBe('unverified')
  expect(guiFeatureResults({...gui,source_unchanged:true,native_evidence:{interactions:0,assertions:1}})[0].status).toBe('unverified')
  expect(guiFeatureResults({...gui,case_results:undefined}).every(row=>row.status==='unverified')).toBe(true)
})
it('reports bootstrap separately and never clears an earlier failure with a later success',()=>{
  const bootstrap=nativeGuiObservations(suite,[{code:1,events:JSON.stringify({type:'test:fail',name:'loader',error:'Cannot find package'}),trace:'{"interactions":0,"assertions":0,"cases":[]}'}])
  expect(bootstrap).toMatchObject({status:'unverified',failure_kind:'bootstrap'})
  const repeated=nativeGuiObservations(suite,[{code:1,events:[{type:'test:fail',name:'F-001 save',error:'bad'},{type:'test:pass',name:'F-001 save'}].map(row=>JSON.stringify(row)).join('\n'),trace:'{"interactions":1,"assertions":1,"cases":[{"name":"F-001 save","assertions":1,"interactions":1}]}'}])
  expect(repeated.case_results[0].status).toBe('failed');expect(repeated.status).toBe('failed')
})
it('uses structured execution evidence and leaves a locator timeout root cause unresolved',()=>{
  const result={status:'failed' as const,summary:'actual GUI check failed',core:{host_gui:{failure_kind:'assertion',steps:[{id:'one',passed:false,actual:{error:'TimeoutError waiting for locator',assertion:{}}}]}}} as never
  expect(verificationFailure(result)).toMatchObject({category:'unknown',classification_basis:'unresolved',next_action:{tool:'read_production_context',arguments:{topic:'diagnostics'}}})
  const assertion={status:'failed',summary:'check failed',core:{host_gui:{failure_kind:'assertion',steps:[{id:'one',passed:false,actual:{assertion:{expected:1,actual:0}}}]}}} as never
  expect(verificationFailure(assertion)).toMatchObject({category:'product_assertion',classification_basis:'assertion'})
})
it('separates hidden-state wait errors from uncertain overlays and preserves runtime precedence', () => {
  const failure = (error: string, kind?: string) => ({ status: 'failed', summary: 'GUI check failed',
    core: { host_gui: { failure_kind: kind, steps: [{ id: 'close-modal', passed: false, actual: { error } }] } } }) as never
  expect(verificationFailure(failure(`TimeoutError: waiting for locator('#import-modal[hidden]') to be visible`, 'assertion')))
    .toMatchObject({ category: 'test_adapter', code: 'TEST_WAIT_STATE_CONTRADICTION', classification_basis: 'adapter_contract' })
  expect(verificationFailure(failure('TimeoutError waiting for locator; topbar intercepts pointer events')))
    .toMatchObject({ category: 'unknown', classification_basis: 'unresolved' })
  expect(verificationFailure(failure('TimeoutError waiting for locator', 'runtime')))
    .toMatchObject({ category: 'product_assertion', classification_basis: 'host_runtime' })
})
