import { expect, it, vi } from 'vitest'
const fixtures = vi.hoisted(() => ({ admission: vi.fn(), ledger: { findings: [{ id:'old', identity:{source:'old-source'}, evidence:'password=private-value', disposition:'confirmed' }], reviews:[] } }))
vi.mock('../../../main/software/delivery-qualification', () => ({deliveryQualityBlock:fixtures.admission}))
vi.mock('../../../main/software/quality-ledger', () => ({applicableQualityLedger:()=>fixtures.ledger,readQualityLedger:()=>fixtures.ledger,qualityIdentity:vi.fn(),qualityRulesVersion:vi.fn()}))
vi.mock('../../../main/software/quality-closeout', () => ({qualityWorkQueue:vi.fn()}))
vi.mock('../../../main/software/independent-design', () => ({independentDesignVersion:vi.fn()}))
vi.mock('../../../main/software/test-corrections', () => ({testCorrectionView:()=>({proposals:[{id:'rejected',status:'rejected'}]})}))
vi.mock('../../../main/software/verification-report', () => ({readVerificationReport:()=>({freshness:'historical_not_revalidated',recorded_status:'failed'})}))
import { buildQualityFindingsTool } from '../../../main/software/quality-findings-tool'
import { createToolState } from '../../../main/agent/loop/agent-loop'
it('keeps versioned failed evidence and rejected corrections readable when execution admission fails',async()=>{
  fixtures.admission.mockRejectedValue(Error('GUI_NATIVE_TEST_SOURCE_CHANGED'))
  const tool=buildQualityFindingsTool('p',()=>{})
  const result=JSON.parse((await tool.execute({}, {projectId:'p',sessionId:'s',requestId:'r',signal:new AbortController().signal,state:createToolState()})).output)
  expect(result).toMatchObject({status:'needs_work',freshness:'current_identity_unavailable',usable_for_delivery:false,finding_count:1,admission_error:expect.stringContaining('GUI_NATIVE_TEST_SOURCE_CHANGED')})
  expect(result.findings[0]).toMatchObject({id:'old',identity:{source:'old-source'},disposition:'confirmed',evidence:'password=[REDACTED]'})
  expect(result.test_corrections.proposals[0].status).toBe('rejected')
  expect(result.verification_report.recorded_status).toBe('failed')
})
