import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { componentUsage, verifyComponentUsage } from '../../../main/software/component-usage'
import { componentSource } from '../../../main/software/component-contracts'
it('records component/requirement links and rejects stale scope, unknown features and changed actual bytes',()=>{
  const root=mkdtempSync(join(tmpdir(),'component-usage-'))
  try{
    cpSync(componentSource('product_store.cjs'),join(root,'product_store.cjs'))
    const uses=componentUsage(root,['F-001'],[{capability:'data-store',feature_ids:['F-001'],purpose:'保存身份与规则'}])
    expect(uses[0].files[0].origin).toBe('platform');expect(uses[0].product_verification).toBe('unverified')
    writeFileSync(join(root,'COMPONENT_USAGE.json'),JSON.stringify({version:1,scope:'scope',uses}))
    expect(()=>verifyComponentUsage(root,'scope',['F-001'])).not.toThrow()
    expect(()=>verifyComponentUsage(root,'changed',['F-001'])).toThrow('STALE')
    expect(()=>componentUsage(root,['F-001'],[{capability:'data-store',feature_ids:['F-999'],purpose:'wrong'}])).toThrow('REFERENCE')
    writeFileSync(join(root,'product_store.cjs'),'module.exports={} ')
    expect(()=>verifyComponentUsage(root,'scope',['F-001'])).toThrow('CHANGED')
    expect(componentUsage(root,['F-001'],[{capability:'data-store',feature_ids:['F-001'],purpose:'自定义实现'}])[0].files[0].origin).toBe('adapted')
  }finally{rmSync(root,{recursive:true,force:true})}
})
