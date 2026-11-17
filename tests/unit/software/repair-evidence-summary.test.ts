import {expect,it} from 'vitest'
import {verificationReportView} from '../../../main/software/verification-report'
import {nativeCheckExecuted} from '../../../main/software/native-gui-tests'
it('reports all recorded failure reasons before paged detail without claiming an attempted action completed',()=>{
 const row=(name:string,error:string)=>({name,feature:'F-001',status:'failed',assertions:0,interactions:0,error})
 const result={status:'failed',summary:'three failures',core:{host_gui:{status:'failed',steps:[],case_results:[row('a','ReferenceError: context'),row('b','Timeout: login'),row('c','ReferenceError: context')],
   native_evidence:{interactions:0,assertions:0,interactions_attempted:1,interaction_count_semantics:'completed'}}}} as any
 const view=verificationReportView(result,{limit:1})
 expect(view.cases).toHaveLength(1);expect(view.counts.failed).toBe(3)
 expect(view.failure_distribution.map(g=>g.count).sort()).toEqual([1,2])
 expect(view.action_counts).toMatchObject({interactions:0,interactions_attempted:1})
 expect(nativeCheckExecuted(result.core.host_gui)).toBe(true)
 expect(view.usable_for_delivery).toBe(false)
})
