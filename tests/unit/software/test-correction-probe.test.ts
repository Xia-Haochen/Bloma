import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {beforeEach,afterEach,expect,it,vi} from 'vitest'
const hooks=vi.hoisted(()=>({root:'',candidate:'',run:vi.fn(),prepare:vi.fn()}))
vi.mock('../../../main/project/project-service',()=>({findProject:()=>({root_path:hooks.root})}))
vi.mock('../../../main/verification/security-scan',()=>({runSecurityScan:()=>({passed:true})}))
vi.mock('../../../main/desktop/gui-acceptance',()=>({parseGuiSuite:(value:unknown)=>value}))
vi.mock('../../../main/software/native-gui-observer',()=>({runNativeGuiTests:(input:unknown)=>hooks.run(input)}))
vi.mock('../../../main/software/release-store',()=>({prepareSoftwareRelease:(...args:unknown[])=>hooks.prepare(...args),runtimeInventory:async(root:string)=>({digest:sha(readFileSync(join(root,'acceptance.mjs'),'utf8'))})}))
import {probeTestCorrection} from '../../../main/software/test-correction-probe'
const sha=(text:string)=>createHash('sha256').update(text).digest('hex')
let home:string
const proposal=()=>({id:'proposal',file:'acceptance.mjs',scope:'scope',before:{text:'frozen original',sha256:sha('frozen original')},after:{text:'exact proposed correction',sha256:sha('exact proposed correction')},native:{cases:[{feature:'F-001'}]}} as Parameters<typeof probeTestCorrection>[1])
beforeEach(()=>{
  home=mkdtempSync(join(tmpdir(),'correction-probe-'));hooks.root=join(home,'product');hooks.candidate=join(home,'candidate');mkdirSync(hooks.root)
  writeFileSync(join(hooks.root,'acceptance.mjs'),'unfinished maker edit')
  hooks.run.mockReset();hooks.prepare.mockReset()
  hooks.prepare.mockImplementation(async()=>{cpSync(hooks.root,hooks.candidate,{recursive:true});return{id:'candidate',root:hooks.candidate,source:{digest:sha('unfinished maker edit')},launch:{},dependencies:[]}})
})
afterEach(()=>rmSync(home,{recursive:true,force:true}))
it('executes exact proposed bytes despite an edited working file, without applying or approving them',async()=>{
  hooks.run.mockImplementation(async(input:{root:string})=>{
    expect(input.root).toBe(hooks.candidate)
    expect(readFileSync(join(input.root,'acceptance.mjs'),'utf8')).toBe('exact proposed correction')
    expect(readFileSync(join(hooks.root,'acceptance.mjs'),'utf8')).toBe('unfinished maker edit')
    return{status:'passed'}
  })
  const result=await probeTestCorrection('p',proposal(),new AbortController().signal)
  expect(result).toMatchObject({purpose:'proposal_adjudication_only',product_verified:false,source_unchanged:true,result:{status:'passed'}})
  expect(readFileSync(join(hooks.root,'acceptance.mjs'),'utf8')).toBe('unfinished maker edit')
})
it.each(['before','after'] as const)('refuses tampered %s proposal text before preparing any candidate',async side=>{
  const input=proposal();input[side].text+=' changed'
  await expect(probeTestCorrection('p',input,new AbortController().signal)).rejects.toThrow('PROBE_INPUT_CHANGED')
  expect(hooks.prepare).not.toHaveBeenCalled();expect(hooks.run).not.toHaveBeenCalled()
})
it.each(['product','candidate'])('rejects %s byte changes during a probe',async target=>{
  hooks.run.mockImplementation(async()=>{writeFileSync(join(target==='product'?hooks.root:hooks.candidate,'acceptance.mjs'),'changed during execution');return{status:'passed'}})
  await expect(probeTestCorrection('p',proposal(),new AbortController().signal)).rejects.toThrow('PROBE_BYTES_CHANGED')
})
