import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createProject, updateProject } from '../../main/project/project-service'

/** Explicit pre-existing design for tests whose subject is recovery, budgets or
 * verification. Actual design ordering is exercised through real tools in the
 * production and engineering-baseline tests, not bypassed by this fixture. */
export function createEngineeringProject(...args: Parameters<typeof createProject>) {
  let project = createProject(...args)
  // These fixtures exercise implementation/recovery with an existing test plan.
  // Default B generation has its own production-entry regression.
  project = updateProject(project.project_id,{independent_design_default:undefined})
  writeFileSync(join(project.root_path, 'ARCHITECTURE.md'),
    'Controlled fixture: the application entry owns input/output and calls the calculation. Build scripts own packaging only. Tests own isolated data and observations; production code does not import tests. No shared mutable business state or background resources. Propagate process failures and verify the normal entry, expected output and restart where applicable. This fixture is not evidence of real-model design quality.')
  return project
}
