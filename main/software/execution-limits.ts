import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { findProject } from '../project/project-service'

interface ExecutionLimits { version: 1; operation: string; requests: number; output: number; reason: string; at: string }
/** Translate an explicitly admitted outer window into cumulative inner limits.
 * This never grants money or resets usage; callers must keep monetary admission. */
export function fundedExecutionLimits(current:{requests:number;output:number;limits:{requests:number;output:number}},window:{remainingRequests:number;remainingRmb:number;outputRmbPerMillion:number}){
  if(![current.requests,current.output,window.remainingRequests].every(n=>Number.isSafeInteger(n)&&n>=0)
    ||!Number.isFinite(window.remainingRmb)||window.remainingRmb<=0||!Number.isFinite(window.outputRmbPerMillion)||window.outputRmbPerMillion<=0)throw Error('EXECUTION_WINDOW_INVALID')
  return{requests:Math.min(4096,Math.max(current.limits.requests,current.requests+window.remainingRequests)),
    output:Math.min(16777216,Math.max(current.limits.output,current.output+Math.floor(window.remainingRmb*1e6/window.outputRmbPerMillion)))}
}
const path = (id: string) => { if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw Error('EXECUTION_LIMITS_PROJECT_INVALID'); return join(getPromaHome(),'software-execution-limits',id+'.json') }
function validate(value: ExecutionLimits) {
  if (!value || value.version !== 1 || typeof value.operation !== 'string'
    || !Number.isSafeInteger(value.requests) || value.requests < 1 || value.requests > 4096
    || !Number.isSafeInteger(value.output) || value.output < 512 || value.output > 16777216
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
