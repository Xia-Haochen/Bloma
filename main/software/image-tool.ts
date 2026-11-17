import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { readDebugSession } from './debug-sessions'
import { softwareVerificationFingerprint } from '../desktop/verification-fingerprint'
import { findProject } from '../project/project-service'
import { resolveProjectRoot } from '../../shared/project-root-override'
import type { AgentLoopTool } from '../agent/loop/agent-loop'
import { MAX_PASTED_IMAGE_BYTES, savePastedImage } from '../platform/shell/pasted-images'

export function buildSoftwareImageTool(projectId: string): AgentLoopTool {
  return { name: 'view_image', description: '查看项目内path图片，或用debug_session_id读取本会话最近一次当前源码调试截图（二选一，png/jpeg/webp最大5MB）；surface=native选择自有HWND的原生截图，缺图不回退DOM或桌面。后者支持宿主管理的工程外截图，拒绝他人/过期源码截图。附图不等于已视觉核对或功能通过；日志只保存引用。',
    input_schema: { type: 'object', additionalProperties:false, properties: { path: { type: 'string' }, debug_session_id:{type:'string'},surface:{type:'string',enum:['renderer','native']} } },
    execute: async (input, ctx) => {
      try {
        ctx.signal.throwIfAborted()
        if (ctx.projectId !== projectId || !/^[A-Za-z0-9_-]+$/.test(ctx.sessionId)) throw Error('IMAGE_OWNER_INVALID')
        if(Object.keys(input).some(key=>!['path','debug_session_id','surface'].includes(key))||Boolean(input.path)===Boolean(input.debug_session_id))throw Error('IMAGE_SOURCE_REQUIRED: path和debug_session_id二选一')
        if(input.surface!==undefined&&(!input.debug_session_id||!['renderer','native'].includes(String(input.surface))))throw Error('IMAGE_SURFACE_INVALID')
        const root = realpathSync(resolveProjectRoot(projectId,()=>findProject(projectId).root_path))
        let file:string,source: string|undefined,version:number|undefined
        if(input.debug_session_id){
          if(typeof input.debug_session_id!=='string')throw Error('IMAGE_SESSION_INVALID')
          const snapshot=readDebugSession(projectId,ctx.sessionId,input.debug_session_id)
          const screenshot=input.surface==='native'?snapshot.native_ui?.screenshot:snapshot.screenshot
          if(snapshot.state!=='ready'||snapshot.stale||!screenshot||!snapshot.source||snapshot.source!==softwareVerificationFingerprint(root))throw Error('IMAGE_DEBUG_SCREENSHOT_STALE_OR_MISSING: 先inspect_app重新观察当前源码及目标surface')
          file=realpathSync(screenshot);source=snapshot.source;version=snapshot.version
        }else{
          if(typeof input.path!=='string')throw Error('IMAGE_PATH_REQUIRED')
          file=realpathSync(resolve(root,input.path));const rel=relative(root,file)
          if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) throw Error('IMAGE_OUTSIDE_PROJECT')
        }
        const ext = extname(file).slice(1).toLowerCase()
        if (!['png', 'jpg', 'jpeg', 'webp'].includes(ext) || statSync(file).size > MAX_PASTED_IMAGE_BYTES) throw Error('IMAGE_FORMAT_OR_SIZE_INVALID')
        const bytes=readFileSync(file)
        const image = savePastedImage(ctx.sessionId, bytes.toString('base64'), ext)
        return { output: JSON.stringify({image:image.imageId,sha256:createHash('sha256').update(bytes).digest('hex'),source,version,surface:input.surface??(input.debug_session_id?'renderer':'project-file'),visual_review:'image_attached_not_reviewed',note:'图片内容已附上；模型需实际核对可见内容，附图不签发PASS。'}), images: [image] }
      } catch (error) { return { output: String(error), isError: true } }
    } }
}
