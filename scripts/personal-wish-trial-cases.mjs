import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'

const root=resolve('tests/fixtures/personal-wish'),corpus=JSON.parse(readFileSync(join(root,'corpus.json'),'utf8'))
const ids=process.argv.slice(2)
assert.ok(ids.length>0&&ids.length<=4,'选择1至4个样本ID；此命令只准备输入，不启动生成')
assert.equal(new Set(ids).size,ids.length)
const tasks={}
for(const id of ids){const row=corpus.cases.find(c=>c.id===id);assert.ok(row,'未知样本')
  const bytes=readFileSync(join(root,id,'request.txt'));assert.equal(createHash('sha256').update(bytes).digest('hex'),row.request_sha256)
  tasks[id]={name:id,goal:bytes.toString('utf8').trim(),change:JSON.parse(readFileSync(join(root,id,'changes.json'),'utf8')).request}
}
const output=resolve('run-artifacts/personal-wish-corpus');mkdirSync(output,{recursive:true})
writeFileSync(join(output,'trial-cases.json'),JSON.stringify(tasks,null,2)+'\n')
console.log(JSON.stringify({path:join(output,'trial-cases.json'),cases:ids,model_requests:0,acceptance:'independent scenario execution still required; no generic PASS'}))
