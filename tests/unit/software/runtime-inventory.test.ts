import {afterEach,expect,it,vi} from 'vitest'
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,statSync,utimesSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {runtimeInventory} from '../../../main/software/release-store'
import {resolveSoftwareCommand} from '../../../main/software/command-runtime'
const dirs:string[]=[]
const temporary=()=>{const root=mkdtempSync(join(tmpdir(),'bloma-inventory-'));dirs.push(root);return root}
afterEach(()=>{vi.unstubAllEnvs();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
it('preserves depth-first inventory identity while hashing real bytes with bounded IO',async()=>{
 const root=temporary();mkdirSync(join(root,'a'));mkdirSync(join(root,'data'))
 for(const [path,content] of [['a/x.txt','甲'],['a.txt','two'],['data/value.json','mutable'],['data/logic.js','const value=1']])writeFileSync(join(root,path),content)
 const paths=['a/x.txt','a.txt','data/logic.js']
 const files=paths.map(path=>{const b=readFileSync(join(root,path));return{path,size:b.length,sha256:createHash('sha256').update(b).digest('hex')}})
 const result=await runtimeInventory(root)
 expect(result.files).toEqual(files);expect(result.digest).toBe(createHash('sha256').update(JSON.stringify(files)).digest('hex'))
 expect(result.bytes).toBe(files.reduce((sum,f)=>sum+f.size,0))
 const before=statSync(join(root,'a.txt'));writeFileSync(join(root,'a.txt'),'new');utimesSync(join(root,'a.txt'),before.atime,before.mtime)
 expect((await runtimeInventory(root)).digest).not.toBe(result.digest)
})
it('does not turn link rejection or cancellation into partial successful inventories',async()=>{
 const root=temporary(),outside=temporary();writeFileSync(join(outside,'value.txt'),'outside')
 symlinkSync(outside,join(root,'linked'),process.platform==='win32'?'junction':'dir')
 await expect(runtimeInventory(root)).rejects.toThrow('RELEASE_LINK_UNSUPPORTED')
 const controller=new AbortController();controller.abort()
 await expect(runtimeInventory(root,controller.signal)).rejects.toThrow()
})
it('resolves fresh PATH entries without launching a shell or trusting cwd',()=>{
 const root=temporary(),other=temporary();const name=process.platform==='win32'?'node.EXE':'node'
 writeFileSync(join(root,name),'fake executable for resolution only');writeFileSync(join(other,name),'second')
 vi.stubEnv('PATH',root);if(process.platform==='win32')vi.stubEnv('PATHEXT','.EXE;.CMD')
 expect(resolveSoftwareCommand(root,['node','app.cjs'],{}).command[0]).toBe(join(root,name))
 vi.stubEnv('PATH',other)
 expect(resolveSoftwareCommand(root,['node','app.cjs'],{}).command[0]).toBe(join(other,name))
})
