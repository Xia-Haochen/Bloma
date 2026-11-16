import {expect,it} from 'vitest'
import {assessCandidateRequirements} from '../../../main/software/requirement-assessment'
import type {SoftwareVerification} from '../../../main/software/verification'

it('keeps one outcome per requirement with the evidence and owner of pending work',()=>{
 const result={status:'unverified',core:{requirements:[
  {id:'F-001',verification:'passed'},{id:'F-002',verification:'passed'},{id:'F-003',verification:'unverified'},
 ],pending_user_checks:[{feature:'F-003',kind:'microphone'}]},independent:{status:'unverified',case_results:[
  {id:'one',feature:'F-001',status:'passed',kind:'none'},
  {id:'setup',feature:'F-002',status:'unverified',kind:'environment',error:'service unavailable'},
 ]}} as SoftwareVerification
 const rows=assessCandidateRequirements(['F-001','F-002','F-003'],result)
 expect(rows.map(row=>[row.id,row.status,row.next_owner])).toEqual([
  ['F-001','passed',undefined],['F-002','unverified','host'],['F-003','unverified','user'],
 ])
 expect(rows[1].evidence.at(-1)?.detail).toBe('service unavailable')
})
it('an observed business failure remains a failure even when another channel passes',()=>{
 const result={status:'failed',core:{status:'passed'},independent:{status:'failed',case_results:[
  {id:'bad',feature:'F-001',status:'failed',kind:'product_assertion',error:'wrong total'}
 ]}} as SoftwareVerification
 expect(assessCandidateRequirements(['F-001'],result)[0]).toMatchObject({status:'failed',next_owner:'implementation'})
})
it('never presents invalidated observations as current requirement passes',()=>{
 const result={status:'unverified',evidence_valid:false,core:{status:'passed'}} as SoftwareVerification
 expect(assessCandidateRequirements(['F-001'],result)[0]).toMatchObject({status:'unverified',next_owner:'host'})
})
