import ts from 'typescript'

/** Inspect actual bindings, not credential-looking text inside comments or
 * cleanup/example strings. Only clearly synthetic values inside test callbacks
 * receive a nonblocking classification; exporting a credential stays high. */
export function credentialLiterals(path:string,source:string){
  const file=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS)
  const findings:Array<{line:number;synthetic:boolean}>=[]
  const sensitive=(name:string)=>/(?:api[_-]?key|password|passwd|secret|token|access[_-]?key)$/i.test(name.replace(/["']/g,''))
  const testFile=/(?:^|\/)(?:tests?|fixtures)\/|\.(?:test|spec)\.[cm]?[jt]s$/i.test(path)
  const inTest=(node:ts.Node):boolean=>{for(let p=node.parent;p;p=p.parent)if(ts.isCallExpression(p)&&/^(?:test|it)(?:\.(?:skip|only))?$/.test(p.expression.getText(file)))return true;return false}
  const visit=(node:ts.Node)=>{
    let name:ts.Node|undefined,value:ts.Node|undefined
    if(ts.isVariableDeclaration(node)||ts.isPropertyAssignment(node)){name=node.name;value=node.initializer}
    if(ts.isBinaryExpression(node)&&node.operatorToken.kind===ts.SyntaxKind.EqualsToken){name=node.left;value=node.right}
    if(name&&value&&sensitive(name.getText(file))&&ts.isStringLiteralLike(value)&&value.text.length>=4){
      findings.push({line:file.getLineAndCharacterOfPosition(value.getStart(file)).line+1,
        synthetic:testFile&&inTest(node)&&/^(?:synthetic|fixture|test)[_-]/i.test(value.text)})
    }
    ts.forEachChild(node,visit)
  }
  visit(file);return findings
}
