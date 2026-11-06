import {it,expect} from 'vitest'
import {fundedExecutionLimits,withFundedExecutionWindow,currentFundedExecutionWindow} from '../../../main/software/execution-limits'
it('adds only the admitted remaining allowance to existing counts, without granting money or resetting counts',()=>{
  const current={requests:256,output:230000,limits:{requests:256,output:262144}},before=structuredClone(current)
  expect(fundedExecutionLimits(current,{remainingRequests:221,remainingRmb:4.987177,outputRmbPerMillion:8})).toEqual({requests:477,output:853397})
  expect(current).toEqual(before)
  expect(()=>fundedExecutionLimits(current,{remainingRequests:NaN,remainingRmb:5,outputRmbPerMillion:8})).toThrow('INVALID')
  expect(()=>fundedExecutionLimits(current,{remainingRequests:1,remainingRmb:5,outputRmbPerMillion:0})).toThrow('INVALID')
})

it('keeps admitted windows isolated and reads remaining allowance without resetting counters',async()=>{
 expect(currentFundedExecutionWindow()).toBeUndefined()
 let remaining=10
 await withFundedExecutionWindow(()=>({remainingRequests:remaining,remainingRmb:2,outputRmbPerMillion:8}),async()=>{
   expect(currentFundedExecutionWindow()?.remainingRequests).toBe(10);remaining=4
   await Promise.resolve();expect(currentFundedExecutionWindow()?.remainingRequests).toBe(4)
   await withFundedExecutionWindow(()=>({remainingRequests:1,remainingRmb:1,outputRmbPerMillion:8}),async()=>expect(currentFundedExecutionWindow()?.remainingRequests).toBe(1))
   expect(currentFundedExecutionWindow()?.remainingRequests).toBe(4)
 })
 expect(currentFundedExecutionWindow()).toBeUndefined()
})
