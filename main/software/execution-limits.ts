import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'

/** Shared platform capacity, separate from the task's monetary authorization. */
export const SOFTWARE_EXECUTION_REQUEST_CAPACITY=4096
export const SOFTWARE_EXECUTION_OUTPUT_CAPACITY=16_777_216
export function remainingSoftwareRequests(used:number){
  if(!Number.isSafeInteger(used)||used<0)throw Error('EXECUTION_REQUEST_COUNT_INVALID')
  return Math.max(0,SOFTWARE_EXECUTION_REQUEST_CAPACITY-used)
}
export interface FundedExecutionWindow {remainingRequests:number;remainingRmb:number;outputRmbPerMillion:number;deadlineAt?:number;minimumOutputTokens?:number}
const admittedWindow = new AsyncLocalStorage<() => FundedExecutionWindow>()
/** Host scope only: the outer request/money guards remain authoritative. */
export function withFundedExecutionWindow<T>(window:()=>FundedExecutionWindow, work:()=>T):T {return admittedWindow.run(window,work)}
export function currentFundedExecutionWindow(){return admittedWindow.getStore()?.()}
export function executionWindowFacts(now=Date.now()) {
  const window=currentFundedExecutionWindow()
  if(!window)return{scope:'standard_platform_guards' as const,
    note:'当前使用平台常规准入。此处没有附加共享窗口的遥测。判断工具能否执行，查看本轮的工具回执、请求准入或取消结果。'}
  return{scope:'funded_execution_window' as const,remaining_requests:window.remainingRequests,admission_remaining_rmb:window.remainingRmb,
    ...(Number.isFinite(window.deadlineAt)?{deadline_at:new Date(window.deadlineAt!).toISOString(),remaining_ms:Math.max(0,window.deadlineAt!-now)}:{}),
    note:'共享执行窗口的实时准入余量，不是账户余额或新增授权；未知费用责任仍占用额度。'}
}
interface ExecutionLimits { version: 1; operation: string; requests: number; output: number; reason: string; at: string }
/** Translate an explicitly admitted outer window into cumulative inner limits.
 * This never grants money or resets usage; callers must keep monetary admission. */
export function fundedExecutionLimits(current:{requests:number;output:number;limits:{requests:number;output:number}},window:FundedExecutionWindow){
  if(![current.requests,current.output,window.remainingRequests].every(n=>Number.isSafeInteger(n)&&n>=0)
    ||!Number.isFinite(window.remainingRmb)||window.remainingRmb<=0||!Number.isFinite(window.outputRmbPerMillion)||window.outputRmbPerMillion<=0)throw Error('EXECUTION_WINDOW_INVALID')
  return{requests:Math.min(SOFTWARE_EXECUTION_REQUEST_CAPACITY,Math.max(current.limits.requests,current.requests+window.remainingRequests)),
    output:Math.min(SOFTWARE_EXECUTION_OUTPUT_CAPACITY,Math.max(current.limits.output,current.output+Math.floor(window.remainingRmb*1e6/window.outputRmbPerMillion)))}
}
const path = (id: string) => { if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('EXECUTION_LIMITS_PROJECT_INVALID'); return join(getPromaHome(),'software-execution-limits',id+'.json') }
function validate(value: ExecutionLimits) {
  if (!value || value.version !== 1 || typeof value.operation !== 'string'
    || !Number.isSafeInteger(value.requests) || value.requests < 1 || value.requests > SOFTWARE_EXECUTION_REQUEST_CAPACITY
    || !Number.isSafeInteger(value.output) || value.output < 512 || value.output > SOFTWARE_EXECUTION_OUTPUT_CAPACITY
    || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 2000) throw Error('EXECUTION_LIMITS_INVALID')
}
/** Host/operator policy only; never clears counters, monetary receipts or leases. */
export function configureSoftwareExecutionLimits(projectId: string, expectedOperation: string, limits: { requests: number; output: number; reason: string }) {
  const project=findProject(projectId)
  if(project.workflow_version!=='software-v1'||(project.lean_operation_id??'initial')!==expectedOperation)throw Error('EXECUTION_LIMITS_OPERATION_CHANGED')
  const value:ExecutionLimits={version:1,operation:expectedOperation,...limits,at:new Date().toISOString()};validate(value)
  writeTextFileAtomic(path(projectId),JSON.stringify(value,null,2));return value
}
export function softwareExecutionLimits(projectId: string, operation: string) {
  const file=path(projectId);if(!existsSync(file))return undefined
  const value=JSON.parse(readFileSync(file,'utf8')) as ExecutionLimits;validate(value)
  return value.operation===operation?{requests:value.requests,output:value.output}:undefined
}

/** Scheduling protection is not an invoice or another reservation ledger. */
export function optionalExecutionAdmission(input:{remainingMicro?:number;requestMicro?:number;protectedMicro?:number;mandatoryRequests:number;deadlineAt?:number;drainMs:number;now?:number}){
 if(!Number.isSafeInteger(input.mandatoryRequests)||input.mandatoryRequests<0||!Number.isFinite(input.drainMs)||input.drainMs<0)throw Error('OPTIONAL_PROTECTION_INVALID')
 if([input.remainingMicro,input.requestMicro,input.protectedMicro].some(v=>v!==undefined&&(!Number.isSafeInteger(v)||v<0)))throw Error('OPTIONAL_PROTECTION_INVALID')
 const protectedMicro=input.protectedMicro??(input.requestMicro===undefined?undefined:input.requestMicro*input.mandatoryRequests)
 if(input.deadlineAt!==undefined&&input.deadlineAt-(input.now??Date.now())<=input.drainMs*(input.mandatoryRequests+1))return{allowed:false,reason:'OPTIONAL_DEADLINE_PROTECTED',protected_micro_rmb:protectedMicro}
 if(input.remainingMicro!==undefined&&input.requestMicro!==undefined&&input.remainingMicro<input.requestMicro+protectedMicro!)return{allowed:false,reason:'OPTIONAL_CLOSEOUT_BUDGET_PROTECTED',protected_micro_rmb:protectedMicro}
 return{allowed:true,protected_micro_rmb:protectedMicro}
}
