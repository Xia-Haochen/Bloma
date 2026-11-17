import { expect,it } from 'vitest'
import { trialOutputCap } from '../../../scripts/trial-output-cap'
const rate={context_tokens:1048576,input_rmb_per_million:2,output_rmb_per_million:8}
it('fits a fresh smaller window without spending its complete-input reserve or imposing 16K',()=>{
  for(const amount of [2.114,5,10]){
    const tokens=trialOutputCap(amount,640000,rate)
    expect(tokens).toBeGreaterThanOrEqual(2048)
    expect(Math.ceil(rate.context_tokens*rate.input_rmb_per_million)+Math.ceil(tokens*rate.output_rmb_per_million)).toBeLessThanOrEqual(Math.floor(amount*1e6))
  }
  expect(trialOutputCap(5,640000,rate)).toBeGreaterThan(16384)
  expect(trialOutputCap(10,640000,rate)).toBe(640000)
  expect(trialOutputCap(10,32768,rate)).toBe(32768)
  expect(()=>trialOutputCap(2.09,640000,rate)).toThrow('COMPLETE_INPUT')
  expect(()=>trialOutputCap(5,640000,{...rate,output_rmb_per_million:0})).toThrow('INVALID')
})
