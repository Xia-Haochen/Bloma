import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it } from 'vitest'
import { createProject } from '../../../main/project/project-service'
import { importAttachment } from '../../../main/platform/attachments/composer-store'
import { materializeDesignAssets, verifyRequiredDesignAssets } from '../../../main/software/design-asset-delivery'

let home:string,old:string|undefined
beforeEach(()=>{old=process.env.PROMA_HOME;home=mkdtempSync(join(tmpdir(),'bloma-design-assets-'));process.env.PROMA_HOME=home})
afterEach(()=>{if(old===undefined)delete process.env.PROMA_HOME;else process.env.PROMA_HOME=old;rmSync(home,{recursive:true,force:true})})
it('copies authorized originals into an independently movable product and detects missing or changed bytes',()=>{
  const project=createProject({request_id:'r',mode:'quick'},{workflowVersion:'software-v1'})
  const info=importAttachment({request_id:'r',project_id:project.project_id,session_id:'s',draft_id:'d',name:'paper.png',media_type:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5N8AAAAASUVORK5CYII='})
  const asset={attachment_id:info.attachment_id,sha256:info.sha256,role:'required_asset' as const,usage:'背景',transformations:'保留原样'}
  const materials={project_id:project.project_id,owner_session_id:'s',attachments:[info]}
  const writes:string[]=[]
  const rows=materializeDesignAssets(project.root_path,[asset],materials,p=>writes.push(p))
  expect(writes).toEqual([rows[0].path]);expect(rows[0].media_type).toBe('image/png')
  expect(()=>verifyRequiredDesignAssets(project.root_path,[asset])).not.toThrow()
  const destination=join(home,'moved-product');mkdirSync(destination);cpSync(join(project.root_path,'assets'),join(destination,'assets'),{recursive:true})
  expect(()=>verifyRequiredDesignAssets(destination,[asset])).not.toThrow()
  writeFileSync(join(destination,rows[0].path),'replacement')
  expect(()=>verifyRequiredDesignAssets(destination,[asset])).toThrow('CHANGED')
  expect(readFileSync(join(project.root_path,rows[0].path)).subarray(1,4).toString()).toBe('PNG')
  expect(()=>materializeDesignAssets(project.root_path,[asset],{...materials,attachments:[]},()=>{})).toThrow('UNAVAILABLE')
  expect(materializeDesignAssets(project.root_path,[{...asset,role:'style_reference'}],materials,()=>{throw Error('must not copy')})).toEqual([])
})
