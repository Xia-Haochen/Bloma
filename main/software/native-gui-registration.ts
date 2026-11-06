import {applyApprovedTestCorrections,testCorrectionView} from './test-corrections';
import { assertStageContractsRetained } from './project-stages';
import {stageContractChanges} from './stage-contracts';
import { existsSync, readFileSync } from 'node:fs';
import { freezeNativeGuiTests, nativeTestContractChanges, NativeTestContractError } from './native-gui-tests';
import { findProject, updateProject } from '../project/project-service';
import { readPrdBackplane } from '../project/prd-store';
import { prdScopeFingerprint } from '../project/requirement-contract';
import { guiSuitePath, installGuiAcceptanceSuite, parseGuiSuite } from '../desktop/gui-acceptance';
import { assertRetainedSoftwareBehavior } from './regression-baseline';
import { createHash } from 'node:crypto';
import { canRepairUnexecutedNativePlan } from './verification';
import { join } from 'node:path';
import { getPromaHome } from '../../storage/config-paths';
import { writeTextFileAtomic } from '../../storage/json-store';
export function registerNativeGuiTests(projectId: string, script: string, restart = false) {
    const project = findProject(projectId), brief = readPrdBackplane(projectId), scope = prdScopeFingerprint(brief);
    if (project.workflow_version !== 'software-v1' || !brief.user_confirmed_at || project.ux_confirmation?.prd_fingerprint !== scope)
        throw Error('GUI_CONFIRMED_SCOPE_REQUIRED');
    const covers = brief.requirements.map(item => item.id), native_tests = freezeNativeGuiTests(projectId, project.root_path, script, covers, restart);
    const suite = parseGuiSuite({ version: 1, scope_hash: scope, design_hash: project.ux_confirmation.design_hash, covers, steps: [], native_tests });
    if (existsSync(guiSuitePath(projectId))) {
        const bytes=readFileSync(guiSuitePath(projectId)),previous = parseGuiSuite(JSON.parse(bytes.toString('utf8')));
        const repairable=Boolean(previous.native_tests)&&canRepairUnexecutedNativePlan(projectId,createHash('sha256').update(bytes).digest('hex'))
        const changes = previous.native_tests ? stageContractChanges(projectId,project.root_path,previous.native_tests,native_tests) : ['existing-action-suite'];
        if (previous.scope_hash === scope && changes.length && !repairable) throw new NativeTestContractError(changes,previous.native_tests);
    }
    assertStageContractsRetained(projectId, native_tests);
    assertRetainedSoftwareBehavior(projectId, 'gui', suite);
    // Immutable identity pair records every accepted adapter revision. No model
    // can use the audit record to replace the frozen business contract.
    const previous = existsSync(guiSuitePath(projectId)) ? parseGuiSuite(JSON.parse(readFileSync(guiSuitePath(projectId), 'utf8'))) : undefined;
    writeTextFileAtomic(join(getPromaHome(), 'gui-native-adapters', projectId, `${native_tests.digest}.json`), JSON.stringify({
        version: 1, at: new Date().toISOString(), scope, previous: previous?.native_tests?.digest, current: native_tests.digest, contract: native_tests.contract,
        changes: previous?.native_tests ? nativeTestContractChanges(previous.native_tests, native_tests) : [],
        rule: 'reachable-inputs-and-retained-business-cases-v2'
    }));
    installGuiAcceptanceSuite(projectId, suite);
    updateProject(projectId, { gui_acceptance: { status: 'sealed', scope_hash: scope } });
    return suite;
}

/** Recovery also refreshes the existing formal binding, including retry after
 * bytes were applied but registration was interrupted. It never invents a suite. */
export function applyApprovedNativeCorrections(projectId:string,signal?:AbortSignal){
  const count=applyApprovedTestCorrections(projectId,signal)
  if(!existsSync(guiSuitePath(projectId)))return count>0
  const native=parseGuiSuite(JSON.parse(readFileSync(guiSuitePath(projectId),'utf8'))).native_tests
  if(!native)return count>0
  const revisions=testCorrectionView(projectId).proposals.filter(p=>p.status==='approved'&&p.applied_at)
  const latest=new Map(revisions.map(p=>[p.file,p.new_hash]))
  const stale=native.files.some(file=>{
    const path=native.layout==='project'?file.path:native.directory+'/'+file.path
    return latest.has(path)&&file.sha256!==latest.get(path)&&revisions.some(p=>p.file===path&&p.old_hash===file.sha256)
  })
  if(stale){signal?.throwIfAborted();registerNativeGuiTests(projectId,native.layout==='project'?native.entry:native.directory+'/'+native.entry,native.restart)}
  return count>0||stale
}
