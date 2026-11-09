import ts from 'typescript'
import { join } from 'node:path'
import {existsSync,readFileSync} from 'node:fs'

/** Resolve lexical bindings before freezing. Check only host-supplied names;
 * package/type diagnostics are owned by their actual loaders, not guessed here. */
export function checkNativeTestBindings(root:string,files:string[],productRoot=root){
  const names=files.filter(f=>/\.(?:m|c)?js$/i.test(f)).map(f=>join(root,f))
  const program=ts.createProgram(names,{allowJs:true,checkJs:true,noEmit:true,noResolve:true,noLib:true,types:[],target:ts.ScriptTarget.ESNext})
  const launch=join(productRoot,'LAUNCH.json')
  const electron=existsSync(launch)&&JSON.parse(readFileSync(launch,'utf8')).ui==='electron'
  if(electron)for(const name of names){const file=program.getSourceFile(name);if(!file)continue;const visit=(node:ts.Node)=>{
    if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&node.expression.name.text==='newPage'&&ts.isIdentifier(node.expression.expression)&&node.expression.expression.text==='context')throw Error('GUI_NATIVE_CAPABILITY_UNSUPPORTED: Electron context.newPage; observe a window created by normal product actions')
    ts.forEachChild(node,visit)
  };visit(file)}
  const issues=program.getSemanticDiagnostics().filter(d=>[2304,2552].includes(d.code)&&d.file&&d.start!==undefined
    && /^(?:context|expect|assert|page|test|dataDir|evidenceDir|phase)$/.test(d.file.text.slice(d.start,d.start+(d.length??0))))
  if(issues.length)throw Error('GUI_NATIVE_BINDING_UNDEFINED: '+JSON.stringify(issues.map(d=>({file:d.file!.fileName,line:d.file!.getLineAndCharacterOfPosition(d.start!).line+1,message:ts.flattenDiagnosticMessageText(d.messageText,' ')}))))
}
