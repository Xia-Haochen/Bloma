import {existsSync,readFileSync,realpathSync} from 'node:fs'
import {resolve,relative,isAbsolute} from 'node:path'
import {createHash} from 'node:crypto'
export interface UserTestFile {id:string;name:string;description:string;path:string;sha256:string}
export function loadUserTestFiles(root:string):UserTestFile[]{
  const file=resolve(root,'user-files.json');if(!existsSync(file))return[]
  const entries=JSON.parse(readFileSync(file,'utf8'))
  if(!Array.isArray(entries)||entries.length>12)throw Error('USER_TEST_FILES_INVALID')
  const base=realpathSync(root),ids=new Set<string>()
  return entries.map(row=>{
    if(!row||!/^[-\w]{1,64}$/.test(row.id)||ids.has(row.id)||typeof row.name!=='string'||typeof row.description!=='string'||typeof row.path!=='string'||isAbsolute(row.path))throw Error('USER_TEST_FILES_INVALID')
    ids.add(row.id);const path=realpathSync(resolve(base,row.path)),rel=relative(base,path)
    if(rel.startsWith('..')||isAbsolute(rel)||createHash('sha256').update(readFileSync(path)).digest('hex')!==row.sha256)throw Error('USER_TEST_FILE_CHANGED_OR_OUTSIDE')
    return{...row,path}
  })
}
