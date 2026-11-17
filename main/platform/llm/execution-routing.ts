/** Resolve the category for the executor, not merely the persisted UI stage. */
import type { WorkflowStage, DocumentCategory } from '../../../shared/types'
import { isDesktopLineActive, type DesktopLineProjectLike } from '../../desktop/desktop-route'
import { categoryForStage } from './model-resolution'

export function categoryForExecution(project: DesktopLineProjectLike & { current_stage: WorkflowStage }): DocumentCategory {
  // Delivered software remains in the production executor for subsequent edits.
  // ready/completed otherwise map to guide in the legacy stage-only table.
  return isDesktopLineActive(project) ? 'mvp' : categoryForStage(project.current_stage)
}
