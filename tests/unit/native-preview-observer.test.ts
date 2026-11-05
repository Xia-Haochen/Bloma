import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
vi.mock('electron',()=>({net:{},protocol:{},session:{}}))
import {createProject} from '../../main/project/project-service'
import {mintProjectPreviewUrl} from '../../main/delivery/preview-scheme'
import {resolvePreviewFile} from '../../main/delivery/preview-file'
import {SimulatedUserSurface} from '../../scripts/simulated-user-surface'
let home:string,old:string|undefined
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'native-preview-'));process.env.PROMA_HOME=home})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})})
it('opens a minted bloma-file preview with real relative resources and refuses other projects or linked escapes',async()=>{
  const project=createProject({request_id:'p',mode:'quick'},{workflowVersion:'software-v1'}),other=createProject({request_id:'o',mode:'quick'},{workflowVersion:'software-v1'})
  mkdirSync(join(project.root_path,'00_UX'));writeFileSync(join(project.root_path,'00_UX/ux-sketch.html'),'<html><meta charset="utf-8"><body><h1>本地预览</h1><output></output><script src="./view.js"></script><script src="/shared.js"></script></body></html>')
  writeFileSync(join(project.root_path,'00_UX/view.js'),'document.querySelector("output").textContent="相对资源已运行"')
  writeFileSync(join(project.root_path,'shared.js'),'document.querySelector("output").textContent+="，根路径资源已运行"')
  writeFileSync(join(other.root_path,'index.html'),'<h1>另一个项目</h1>')
  const url=mintProjectPreviewUrl(project.project_id,'00_UX/ux-sketch.html'),surface=new SimulatedUserSurface(project.project_id,join(home,'observer'),'observer')
  try{
    await surface.openPreview(url);const view=await surface.snapshot();expect(view?.text).toContain('相对资源已运行');expect(view?.image).toHaveLength(1);expect(view?.text).toContain('根路径资源已运行')
    await expect(surface.openPreview(mintProjectPreviewUrl(other.project_id,'index.html'))).rejects.toThrow('DENIED')
    symlinkSync(other.root_path,join(project.root_path,'outside'),'junction')
    expect(resolvePreviewFile(`bloma-file://${project.project_id}/outside/index.html`,project.project_id).status).toBe(403)
  }finally{await surface.close()}
})
