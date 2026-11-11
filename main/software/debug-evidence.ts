import { constants } from 'node:fs'
import { lstat, opendir, realpath, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { redactSoftwareOutput } from './process-manager'

export const DEBUG_DIAGNOSTIC_PREFIX = 'BLOMA_DIAGNOSTIC '
export const DEBUG_EVIDENCE_CAPABILITIES={protocol:'debug-evidence-v1',query:'inspect_app(mode=read,debug_session_id,since_seq,diagnostics); exact trace/action/operation/process/source/version and kind prefix; ISO time interval; diagnostic_page.next_seq',ipc:'Optional BLOMA_DIAGNOSTIC JSON line: kind=ipc|storage, phase=request|completed|failed, trace_id, optional code/message. Application-reported only; no generic IPC interception, root-cause proof or PASS.',backend:'Existing owned process logical-record sequence; gaps/truncation explicit, read_process(mode=log) for retained archive.',storage:'Only own debug data file bytes; declared host Electron profile excluded. Before/after hashes, no bodies. 128 files, 64 directories, depth12, 1MiB/file, 8MiB total, cooperative1500ms; no FS transaction or OS sandbox.',limits:{query_rows:80,query_bytes:12000,stored_rows:200,stored_characters:64000,changed_files:8},verification:'not_applicable'} as const
export function applicationDiagnostic(text:string) {
  if(!text.startsWith(DEBUG_DIAGNOSTIC_PREFIX))return undefined
  if(Buffer.byteLength(text)>4096)throw Error('DIAGNOSTIC_MARKER_TOO_LARGE')
  const value=JSON.parse(text.slice(DEBUG_DIAGNOSTIC_PREFIX.length)) as Record<string,unknown>
  if(!value||Array.isArray(value)||Object.keys(value).some(k=>!['kind','phase','trace_id','code','message'].includes(k))||!['ipc','storage'].includes(String(value.kind))||!['request','completed','failed'].includes(String(value.phase))||typeof value.trace_id!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(value.trace_id)||value.code!==undefined&&(typeof value.code!=='string'||!/^[A-Za-z0-9_.:-]{1,80}$/.test(value.code))||value.message!==undefined&&(typeof value.message!=='string'||value.message.length>1000))throw Error('DIAGNOSTIC_MARKER_INVALID')
  const trace=redactSoftwareOutput(value.trace_id),code=typeof value.code==='string'?redactSoftwareOutput(value.code):undefined
  return {kind:`application.${value.kind}.${value.phase}`,trace_id:trace===value.trace_id?trace:undefined,code,message:redactSoftwareOutput(String(value.message??value.code??value.phase))}
}
export interface DiagnosticQuery { kind?:string; action?:string; operation_id?:string; trace_id?:string; process_id?:string; source?:string; version?:number; from?:string; to?:string; limit?:number }
export interface EvidenceRow {seq:number;at:string;version:number;kind:string;action?:string;operation_id?:string;trace_id?:string;process_id?:string;source?:string}
export function validateDiagnosticQuery(query:DiagnosticQuery){
  if(!query||typeof query!=='object'||Array.isArray(query)||Object.keys(query).some(k=>!['kind','action','operation_id','trace_id','process_id','source','version','from','to','limit'].includes(k)))throw Error('DIAGNOSTIC_QUERY_INVALID')
  for(const key of ['kind','action','operation_id','trace_id','process_id'] as const)if(query[key]!==undefined&&(typeof query[key]!=='string'||!query[key]||query[key]!.length>160))throw Error('DIAGNOSTIC_QUERY_INVALID')
  if(query.source!==undefined&&(typeof query.source!=='string'||! /^[a-f0-9]{64}$/.test(query.source)))throw Error('DIAGNOSTIC_QUERY_INVALID')
  if(query.version!==undefined&&(!Number.isSafeInteger(query.version)||query.version<1)||query.limit!==undefined&&(!Number.isSafeInteger(query.limit)||query.limit<1||query.limit>80))throw Error('DIAGNOSTIC_QUERY_INVALID')
  for(const key of ['from','to'] as const)if(query[key]!==undefined&&(typeof query[key]!=='string'||query[key]!.length>40||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(query[key]!)||!Number.isFinite(Date.parse(query[key]!))))throw Error('DIAGNOSTIC_QUERY_INVALID')
  if(query.from&&query.to&&Date.parse(query.from)>Date.parse(query.to))throw Error('DIAGNOSTIC_QUERY_INVALID')
}
/** Filters do not grant another session access. Call only after normal ownership. */
export function diagnosticPage<T extends EvidenceRow>(rows:T[],cursor:number,since:number,query?:DiagnosticQuery){
  if(!Number.isSafeInteger(since)||since<0||since>cursor)throw Error('DEBUG_CURSOR_INVALID')
  if(query)validateDiagnosticQuery(query)
  const available=rows.filter(r=>r.seq>since),matches=available.filter(r=>!query||(!query.kind||r.kind===query.kind||r.kind.startsWith(query.kind+'.'))&&(!query.action||r.action===query.action)&&(!query.operation_id||r.operation_id===query.operation_id)&&(!query.trace_id||r.trace_id===query.trace_id)&&(!query.process_id||r.process_id===query.process_id)&&(!query.source||r.source===query.source)&&(!query.version||r.version===query.version)&&(!query.from||Date.parse(r.at)>=Date.parse(query.from))&&(!query.to||Date.parse(r.at)<=Date.parse(query.to)))
  const selected=query?matches.slice(0,query.limit??16):matches.slice(-16)
  const bytes=()=>Buffer.byteLength(JSON.stringify(selected))
  while(bytes()>12000&&selected.length>1){if(query)selected.pop();else selected.shift()}
  // Rows produced here are bounded below this limit. Never silently consume an
  // unexpected oversized persisted row or certify a corrupted historical log.
  if(bytes()>12000)throw Error('DIAGNOSTIC_ROW_TOO_LARGE')
  const more=!!query&&selected.length<matches.length
  return {observations:selected,observations_omitted:matches.length-selected.length,diagnostic_page:{next_seq:more?selected.at(-1)?.seq??since:cursor,more,retained_from_seq:rows[0]?.seq??cursor+1,history_gap:since<(rows[0]?.seq??cursor+1)-1,filtered_out:available.length-matches.length}}
}
interface FileFact {bytes:number;sha256:string}
export interface StorageSnapshot {complete:boolean; files:Record<string,FileFact>; digest?:string; gaps:string[]; bytes:number; excluded:string[]}
export interface StorageDelta {scope:'owned_debug_data'; complete:boolean; operation_id?:string; at?:string; before_version?:number;after_version?:number;before_source?:string;after_source?:string; before_digest?:string; after_digest?:string; before_bytes:number; after_bytes:number; changed:number; unobserved:number; excluded:{before:string[];after:string[]}; omitted:number; gaps:string[]; changes:Array<{path:string;path_truncated?:boolean;path_redacted?:boolean;kind:string;before?:FileFact;after?:FileFact}>; note:string}
const inside=(root:string,path:string)=>{const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..\\')&&!rel.startsWith('../')}
const equalStat=(a:Awaited<ReturnType<typeof lstat>>,b:Awaited<ReturnType<typeof lstat>>)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs
/** No bodies, arbitrary paths, profile-wide scanning, or filesystem transaction.
 * Full bounded byte reads plus pre/post identity checks, not an OS sandbox. */
export async function snapshotDebugData(directory:string,signal:AbortSignal,limits={files:128,bytes:8*1024*1024,fileBytes:1024*1024,ms:1500},excluded:string[]=[]):Promise<StorageSnapshot>{
  const result:StorageSnapshot={complete:true,files:Object.create(null),gaps:[],bytes:0,excluded:[...excluded].sort()},start=performance.now(),root=resolve(directory)
  let files=0,dirs=0
  const gap=(code:string)=>{result.complete=false;if(!result.gaps.includes(code)&&result.gaps.length<8)result.gaps.push(code)}
  const check=()=>{signal.throwIfAborted();if(performance.now()-start>limits.ms)throw Error('DATA_OBSERVATION_DEADLINE')}
  const namesIn=async(dir:string)=>{const names:string[]=[];for await(const entry of await opendir(dir)){check();names.push(entry.name);if(names.length>512)throw Error('DATA_MEMBER_LIMIT')}return names.sort()}
  try{
    const rootStat=await lstat(root);if(rootStat.isSymbolicLink()||!rootStat.isDirectory()||await realpath(root)!==root)throw Error('DATA_ROOT_IDENTITY_UNAVAILABLE')
    const walk=async(dir:string,depth:number):Promise<void>=>{
      check();if(depth>12||++dirs>64){gap('DATA_DIRECTORY_LIMIT');return}
      const before=await lstat(dir),actual=await realpath(dir)
      if(before.isSymbolicLink()||!before.isDirectory()||!inside(root,actual))throw Error('DATA_DIRECTORY_IDENTITY_CHANGED')
      const names=await namesIn(dir)
      for(const name of names){
        if(depth===0&&excluded.includes(name))continue
        check();const file=join(dir,name),stat=await lstat(file)
        if(stat.isSymbolicLink()){gap('DATA_LINK_UNOBSERVED');continue}
        if(stat.isDirectory()){await walk(file,depth+1);continue}
        if(!stat.isFile()){gap('DATA_SPECIAL_FILE_UNOBSERVED');continue}
        if(++files>limits.files){gap('DATA_FILE_LIMIT');break}
        if(stat.size>limits.fileBytes||result.bytes+stat.size>limits.bytes){gap('DATA_BYTE_LIMIT');continue}
        if(!inside(root,await realpath(file)))throw Error('DATA_FILE_IDENTITY_CHANGED')
        const handle=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
        try{
          const opened=await handle.stat();if(!opened.isFile()||!equalStat(stat,opened))throw Error('DATA_FILE_IDENTITY_CHANGED')
          const hash=createHash('sha256'),buffer=Buffer.alloc(Math.min(65536,stat.size+1));let offset=0
          while(offset<stat.size){check();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,stat.size-offset),offset);if(!bytesRead)break
            offset+=bytesRead;if(offset>stat.size)throw Error('DATA_FILE_CHANGED');hash.update(buffer.subarray(0,bytesRead))}
          if(offset!==stat.size||!equalStat(opened,await handle.stat())||!equalStat(opened,await lstat(file))||!inside(root,await realpath(file)))throw Error('DATA_FILE_CHANGED')
          result.files[relative(root,file).replace(/\\/g,'/')]={bytes:offset,sha256:hash.digest('hex')};result.bytes+=offset
        }finally{await handle.close()}
      }
      if(JSON.stringify(names)!==JSON.stringify(await namesIn(dir))||!equalStat(before,await lstat(dir))||await realpath(dir)!==actual)throw Error('DATA_DIRECTORY_CHANGED')
    }
    await walk(root,0);check();if(!equalStat(rootStat,await lstat(root))||await realpath(root)!==root)throw Error('DATA_ROOT_CHANGED')
  }catch(error){gap(signal.aborted?'DATA_OBSERVATION_CANCELLED':/^DATA_/.test((error as Error).message)?(error as Error).message:'DATA_READ_UNAVAILABLE')}
  if(result.complete)result.digest=createHash('sha256').update(JSON.stringify({excluded:result.excluded,files:Object.entries(result.files).sort(([a],[b])=>a.localeCompare(b))})).digest('hex')
  return result
}
export function compareDebugData(before:StorageSnapshot,after:StorageSnapshot):StorageDelta{
  const scopeChanged=JSON.stringify(before.excluded)!==JSON.stringify(after.excluded)
  const changes=[...new Set([...Object.keys(before.files),...Object.keys(after.files)])].sort().filter(p=>JSON.stringify(before.files[p])!==JSON.stringify(after.files[p])).map(path=>({path,kind:!before.files[path]&&(!before.complete||scopeChanged)||!after.files[path]&&(!after.complete||scopeChanged)?'unobserved':!before.files[path]?'added':!after.files[path]?'removed':'modified',before:before.files[path],after:after.files[path]}))
  return {scope:'owned_debug_data',complete:before.complete&&after.complete&&!scopeChanged,excluded:{before:before.excluded,after:after.excluded},before_digest:before.digest,after_digest:after.digest,before_bytes:before.bytes,after_bytes:after.bytes,changed:changes.filter(c=>c.kind!=='unobserved').length,unobserved:changes.filter(c=>c.kind==='unobserved').length,omitted:Math.max(0,changes.length-8),gaps:[...new Set([...before.gaps,...after.gaps,...(scopeChanged?['DATA_SCOPE_CHANGED']:[])])],changes:changes.slice(0,8).map(c=>{const safe=redactSoftwareOutput(c.path);return{...c,path:safe.slice(0,160),path_truncated:safe.length>160,path_redacted:safe!==c.path}}),note:'Complete only within bounded file domain minus declared exclusions; no file bodies. Before/after data bytes; temporal host-operation interval, not click causality, fs atomicity, IPC proof, browser profile coverage, or acceptance.'}
}
