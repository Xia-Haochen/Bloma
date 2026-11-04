import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const root=resolve('tests/fixtures/personal-wish'),corpus=JSON.parse(readFileSync(join(root,'corpus.json'),'utf8'))
const assets=JSON.parse(readFileSync(join(root,'assets-manifest.json'),'utf8')).assets
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
assert.equal(corpus.version,1);assert.equal(new Set(corpus.cases.map(c=>c.id)).size,corpus.cases.length)
const familyCounts={}
for(const c of corpus.cases){
  assert.match(c.id,/^[a-z-]+$/);assert.equal(c.exposed_to_implementer,true)
  const request=readFileSync(join(root,c.id,'request.txt')),oracle=JSON.parse(readFileSync(join(root,c.id,'oracle.json'),'utf8')),change=JSON.parse(readFileSync(join(root,c.id,'changes.json'),'utf8'))
  assert.equal(sha(request),c.request_sha256);assert.equal(oracle.source_quote,request.toString('utf8').trim());assert.equal(oracle.change_quote,change.request)
  assert.equal(oracle.status,'authored_not_executed');assert.equal(oracle.independent,false)
  assert.ok(oracle.core_experience&&oracle.unacceptable_substitute&&oracle.required_evidence.length)
  assert.ok(!/F-\d{3}|prepare_software|verify_app|React|Playwright|Node\.js/.test(request.toString('utf8')))
  for(const name of c.assets){assert.match(name,/^[a-z0-9.-]+$/);const a=assets.find(a=>a.name===name);assert.ok(a?.sha256);assert.equal(sha(readFileSync(join(root,'assets',name))),a.sha256)}
  familyCounts[c.family]=(familyCounts[c.family]??0)+1
}
assert.equal(Object.keys(familyCounts).length,6);assert.ok(Object.values(familyCounts).every(n=>n>=2))
const report={version:1,scope:'corpus_integrity_only',cases:corpus.cases.length,family_counts:familyCounts,assets:assets.length,
  generation_requests:0,product_acceptance:'not_run',heldout:'not_independent',next:'选择未暴露样本并确认新费用范围后，沿正式生成链执行；不能以本报告宣称体验或交付通过。'}
const out=resolve('run-artifacts/personal-wish-corpus');mkdirSync(out,{recursive:true});writeFileSync(join(out,'report.json'),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report))
