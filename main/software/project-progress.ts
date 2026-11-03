import type { SoftwareProjectProgress } from '../../shared/types'
import { findProject } from '../project/project-service'
import { readProjectActivity, projectActivityView } from './project-activity'
import { projectStageView } from './project-stages'
import { softwareStatusView } from './state-view'

/** Presentation derives only from host facts; ended delegates have not passed acceptance. */
export function projectProgress(id: string, busy: boolean): SoftwareProjectProgress {
  const project = findProject(id), operation = project.lean_operation_id ?? 'initial'
  const activity = readProjectActivity(id).events.filter(e => e.operation === operation)
  const stages = projectStageView(id)
  const delegated = activity.filter(e => e.kind === 'delegation_started')
  return { environment: '本机项目工作目录', execution: softwareStatusView(id, busy).execution.label,
    stages: stages.stages.map(s => ({ id: s.id, title: s.title, status: s.status==='running'&&!busy?'interrupted':s.status, current_source: s.source_matches })),
    next_stage: stages.next_stage,
    delegation_count: delegated.length,
    delegations: delegated.slice(-8).map(e => {
      const data = e.data as { session_id: string; reason?: string; source?: string }
      const released = activity.some(r => r.kind === 'delegation_released' && (r.data as { session_id?: string }).session_id === data.session_id && r.seq > e.seq)
      return { id: `${data.session_id}:${e.seq}`, reason: data.reason?.slice(0, 300) ?? '专项任务',
        status: released ? 'ended' : busy ? 'running' : 'interrupted', required_review: data.source === 'required_quality' }
    }),
    observed_strategy_segments: projectActivityView(id).segment_count,
    note: (projectActivityView(id).recording_complete ? '' : '运行观测存在缺口，请核对原记录。') + '显示宿主记录；子任务结束和阶段检查通过都不等于完整交付。' }
}
