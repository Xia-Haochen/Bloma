import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { bindSoftwareProfile, executeSoftwareCommand, softwareEnvironment } from '../../../main/software/command-runtime'
import { ownedDirectory } from '../../../main/software/owned-directory'

const directories: string[] = []
function temporary() { const root = mkdtempSync(join(tmpdir(), 'bloma-execution-isolation-')); directories.push(root); return root }
afterEach(() => { vi.unstubAllEnvs(); for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
function setup() { const home = temporary(); vi.stubEnv('PROMA_HOME', home); return home }
const keys = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'XDG_CACHE_HOME', 'npm_config_cache', 'PIP_CACHE_DIR', 'UV_CACHE_DIR', 'APP_DATA_DIR']
it('runs two actual Node children with separate host-selected worktree data, home, temp and mutable package caches', async () => {
 const home = setup(), a = temporary(), b = temporary()
 const code = `const fs=require('node:fs'),path=require('node:path');const keys=${JSON.stringify(keys)};const result=Object.fromEntries(keys.map(key=>[key,process.env[key]]));for(const value of Object.values(result)){fs.mkdirSync(value,{recursive:true});fs.writeFileSync(path.join(value,'proof-'+process.argv[1]),process.argv[1])}console.log(JSON.stringify(result))`
 const inputs = [a,b].map((root, i) => ({ projectId:'shared-project', root, dataDir:join(root,'data'), command:[process.execPath,'-e',code,String(i)], timeoutMs:10000 }))
 const runs = await Promise.all(inputs.map(executeSoftwareCommand))
 expect(runs.map(run=>run.code)).toEqual([0,0])
 const values = runs.map(run=>JSON.parse(run.stdout))
 for (const key of keys) {
  expect(values[0][key]).not.toBe(values[1][key])
  for (let i=0;i<2;i++) { const path=values[i][key]; expect(relative(i===0?a:b,path)).not.toMatch(/^\.\./);expect(readFileSync(join(path,'proof-'+i),'utf8')).toBe(String(i));expect(existsSync(join(path,'proof-'+(1-i)))).toBe(false) }
 }
 // The only intentional shared cache is the explicitly host-owned runtime
 // download cache, not either child's mutable HOME/npm/pip/uv/temp tree.
 expect(softwareEnvironment('shared-project',join(a,'data')).electron_config_cache).toBe(join(home,'software-runtimes','electron-cache'))
})
it('reuses an explicit data generation across reopen, without borrowing another session cache/profile', () => {
 setup(); const root=temporary(),data=join(root,'data'),first=softwareEnvironment('p',data),second=softwareEnvironment('p',data)
 expect(second).toEqual(first)
 const args=bindSoftwareProfile(['electron','.', '--user-data-dir','foreign','--user-data-dir=other'],first)
 expect(args).toEqual(['electron','.',`--user-data-dir=${join(data,'electron-profile')}`])
 expect(bindSoftwareProfile(['node','app.cjs'],first)).toEqual(['node','app.cjs'])
 expect(first.TEMP).not.toBe(process.env.TEMP)
})
it.each(['environment-home','tmp','npm','electron-profile'])('rejects an actual %s directory junction without writing to or deleting its target', part => {
 setup(); const root=temporary(),outside=temporary(),data=join(root,'data');mkdirSync(data)
 writeFileSync(join(outside,'keep.txt'),'unchanged')
 if(part==='environment-home')symlinkSync(outside,join(root,part),process.platform==='win32'?'junction':'dir')
 else {
  const environment=softwareEnvironment('p',data)
  const target=part==='electron-profile'?join(data,part):part==='npm'?environment.npm_config_cache:environment.TEMP
  rmSync(target,{recursive:true,force:true});symlinkSync(outside,target,process.platform==='win32'?'junction':'dir')
 }
 expect(()=>part==='electron-profile'?bindSoftwareProfile(['electron','.'],{APP_DATA_DIR:data}):softwareEnvironment('p',data)).toThrow('OWNED_DIRECTORY_LINK_OR_TYPE_UNSUPPORTED')
 expect(readFileSync(join(outside,'keep.txt'),'utf8')).toBe('unchanged')
 expect(existsSync(join(outside,'appdata'))).toBe(false)
})
it('rejects a linked data root and non-directory cache; neither becomes an execution profile', () => {
 setup();const root=temporary(),outside=temporary();symlinkSync(outside,join(root,'data'),process.platform==='win32'?'junction':'dir')
 expect(()=>softwareEnvironment('p',join(root,'data'))).toThrow('OWNED_DIRECTORY_LINK_OR_TYPE_UNSUPPORTED')
 const target=join(root,'plain');writeFileSync(target,'untouched');expect(()=>ownedDirectory(target)).toThrow('OWNED_DIRECTORY_LINK_OR_TYPE_UNSUPPORTED');expect(readFileSync(target,'utf8')).toBe('untouched')
 const dangling=join(root,'dangling'),missing=join(outside,'missing');symlinkSync(missing,dangling,process.platform==='win32'?'junction':'dir')
 expect(()=>ownedDirectory(dangling)).toThrow('OWNED_DIRECTORY_LINK_OR_TYPE_UNSUPPORTED');expect(existsSync(missing)).toBe(false)
 expect(()=>ownedDirectory(root,['..'])).toThrow('OWNED_DIRECTORY_PATH_INVALID')
})
