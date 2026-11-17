import ts from 'typescript'
import { posix } from 'node:path'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { frozenNativeGuiRoot, frozenNativeEntryPreview, nativeTestContractChanges, type NativeGuiTests } from './native-gui-tests'
import {filterApprovedTestChanges} from './test-corrections'

const entryPath = (n: NativeGuiTests) => n.layout === 'project' ? n.entry : `${n.directory}/${n.entry}`

/** A new cumulative entry may only compose default imports with the unchanged context.
 * No branches, assignments, argument rewriting or skipped prior entry are admitted. */
export function composesPriorEntry(source: string, entry: string, priorEntry: string, read?: (path: string) => string | undefined, seen = new Set<string>()): boolean {
  if (seen.has(entry) || seen.size >= 32) return false
  seen.add(entry)
  const parsed = ts.createSourceFile(entry, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const imports = new Map<string, string>()
  let fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined
  for (const statement of parsed.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
      && statement.importClause?.name && !statement.importClause.namedBindings && statement.moduleSpecifier.text.startsWith('.')) {
      imports.set(statement.importClause.name.text, posix.normalize(posix.join(posix.dirname(entry), statement.moduleSpecifier.text)))
    } else if (!fn && ts.isFunctionDeclaration(statement) && statement.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) fn = statement
    else if (!fn && ts.isExportAssignment(statement) && (ts.isArrowFunction(statement.expression) || ts.isFunctionExpression(statement.expression))) fn = statement.expression
    else return false
  }
  if (!fn || fn.parameters.length !== 1 || !ts.isIdentifier(fn.parameters[0].name) || !fn.body || !ts.isBlock(fn.body)) return false
  const context = fn.parameters[0].name.text
  let previous = false, first = true
  for (const statement of fn.body.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isAwaitExpression(statement.expression) || !ts.isCallExpression(statement.expression.expression)) return false
    const call = statement.expression.expression
    if (!ts.isIdentifier(call.expression) || !imports.has(call.expression.text) || call.arguments.length !== 1
      || !ts.isIdentifier(call.arguments[0]) || call.arguments[0].text !== context) return false
    const target = imports.get(call.expression.text)!
    if (target === priorEntry) previous = true
    else if (read && !previous) { const nested = read(target); if (nested && composesPriorEntry(nested, target, priorEntry, read, new Set(seen))) previous = true }
    if (first && !previous) return false
    first = false
  }
  return previous
}

export function stageContractChanges(projectId: string, root: string, before: NativeGuiTests, after: NativeGuiTests,retained?:Set<string>): string[] {
  const changes = filterApprovedTestChanges(projectId,before,after,nativeTestContractChanges(before, after,retained))
  if (!changes.includes('entry')) return changes
  // All old files, test bodies, inputs and restart requirements remain checked by
  // the original comparator. Only this narrowly verified entry indirection differs.
  const frozen = frozenNativeGuiRoot(projectId, after, root)
  const text = readFileSync(join(frozen, after.entry), 'utf8')
  return composesPriorEntry(text, entryPath(after), entryPath(before), path => after.files.some(f => f.path === path) ? readFileSync(join(frozen, path), 'utf8') : undefined) ? changes.filter(c => c !== 'entry') : changes
}

export function stageContractError(projectId: string, before: NativeGuiTests, changes: string[]) {
  return Error(`PROJECT_STAGE_RETAINED_BEHAVIOR_CHANGED: ${JSON.stringify({ changes, contract_digest:before.digest,original_entry: frozenNativeEntryPreview(projectId, before),read_original:{tool:'read_test_contract',arguments:{contract_digest:before.digest,file:entryPath(before)}},expected_entry_shape:'仅default导入，函数体仅顺序await importedFunction(ctx)，不得有const、ctx.test、分支或参数改写。新增测试注册放在单独default导出模块。',dispute_route:'预期错误先propose_test_correction，独立裁定前不改冻结内容。' })}；保留原入口原文、旧用例、共享逻辑和重开要求。新入口可用纯组合：import prior from './旧入口'; import newCases from './新增'; export default async(ctx)=>{await prior(ctx);await newCases(ctx);}。`)
}
