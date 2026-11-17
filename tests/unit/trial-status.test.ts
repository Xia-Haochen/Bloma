import {expect,it} from 'vitest'
import {trialResultStatus} from '../../scripts/trial-status'
const awaiting={milestone_status:'awaiting_confirmation',source_matches_milestone:true}
it('does not label a pending candidate host-checked when a finding recheck failed or remained unverified',()=>{
  const passed={is_error:false,result:{status:'passed'}}
  expect(trialResultStatus({...awaiting,host_verification:passed,finding_checks:[{is_error:true,result:{status:'failed'}}]})).toBe('host_verification_failed')
  expect(trialResultStatus({...awaiting,host_verification:passed,finding_checks:[{is_error:true,result:{status:'passed'}}]})).toBe('host_verification_incomplete')
  expect(trialResultStatus({...awaiting,stage_verification:{status:'unverified'}})).toBe('host_verification_incomplete')
  expect(trialResultStatus({...awaiting,host_verification:passed,finding_checks:[passed]})).toBe('host_checked_pending_independent_acceptance')
})
it('binds the released summary to the inspected source and preserves independent failures',()=>{
  const delivered={release:'release-a',project_status:'completed',current_stage:'completed',source_matches_milestone:true}
  expect(trialResultStatus(delivered)).toBe('released_pending_independent_acceptance')
  expect(trialResultStatus({...delivered,source_matches_milestone:false})).toBe('incomplete')
  expect(trialResultStatus({...delivered,independent:{status:'failed'}})).toBe('independent_failed')
})
