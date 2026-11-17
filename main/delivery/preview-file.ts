import {existsSync,realpathSync,statSync} from 'node:fs'
import {isAbsolute,join,relative,resolve,sep} from 'node:path'
import {findProject} from '../project/project-service'

/** The Electron handler and external observers share this authorization. */
export function resolvePreviewFile(raw:string,expectedProject?:string):{status:number;path?:string;url?:URL}{
  let url:URL
  try{url=new URL(raw);if(url.protocol!=='bloma-file:')return{status:400}}catch{return{status:400}}
  if(expectedProject&&url.hostname!==expectedProject)return{status:403}
  let root:string
  try{root=realpathSync(findProject(url.hostname).root_path)}catch{return{status:404}}
  let requested:string
  try{requested=decodeURIComponent(url.pathname.replace(/^\/+/,''))}catch{return{status:400}}
  const inside=(path:string)=>{const rel=relative(root,path);return rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel)}
  try{
    let path=realpathSync(resolve(root,requested))
    if(!inside(path))return{status:403}
    if(statSync(path).isDirectory()){
      const index=['index.html','index.htm'].map(name=>join(path,name)).find(file=>existsSync(file)&&statSync(file).isFile())
      if(!index)return{status:404};path=realpathSync(index)
      if(!inside(path))return{status:403}
    }
    return statSync(path).isFile()?{status:200,path,url}:{status:404}
  }catch{return{status:404}}
}
