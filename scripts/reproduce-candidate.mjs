import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureBuild } from './build.mjs'
const root=fileURLToPath(new URL('../',import.meta.url)),cache=join(root,'.cache')
try{const info=lstatSync(cache);if(info.isSymbolicLink()||!info.isDirectory())throw Error('REPRODUCTION_CLI_CACHE_PATH_INVALID')}catch(error){if(error.code!=='ENOENT')throw error}
mkdirSync(cache,{recursive:true})
const temporary=mkdtempSync(join(cache,'reproduction-cli-'))
try{
 await ensureBuild({units:['templates'],log:message=>process.stderr.write(message+'\n')})
 const templates=join(root,'dist-main/main/templates')
 if(!existsSync(templates))throw Error('REPRODUCTION_CLI_TEMPLATES_UNBUILT: use npm run reproduce:candidate')
 cpSync(templates,join(temporary,'templates'),{recursive:true})
 const output=join(temporary,'entry.mjs')
 await build({entryPoints:[join(root,'scripts/reproduce-candidate-entry.ts')],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'})
 const result=spawnSync(process.execPath,[output,...process.argv.slice(2)],{cwd:root,windowsHide:true,stdio:'inherit',timeout:330000})
 process.exitCode=result.status??1
}finally{rmSync(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
