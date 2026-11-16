import {readFileSync,createReadStream} from 'node:fs'
import {resolve,dirname,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
const root=resolve(process.argv[2])
const manifest=JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)),'../common-assets-manifest.json'),'utf8'))
for(const row of manifest.files){
  const hash=createHash('sha256')
  for await(const bytes of createReadStream(join(root,row.path)))hash.update(bytes)
  assert.equal(hash.digest('hex'),row.sha256,row.path)
}
console.log(JSON.stringify({verified:true,files:manifest.files.length,root}))
