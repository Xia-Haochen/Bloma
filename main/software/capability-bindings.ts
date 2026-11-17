import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { getPromaHome } from '../../storage/config-paths'
import { writeTextFileAtomic } from '../../storage/json-store'
import { SPEECH_MODEL_MANIFEST } from '../platform/speech/model-manifest'

export interface SpeechCapabilityBinding {
  provider:'python-sensevoice-v1'; model_root:string; manifest_sha256:string
  components:Record<string,string>; dependencies:Record<string,{version:string;path:string}>; at:string
}
export const speechManifestVersion=()=>createHash('sha256').update(JSON.stringify(SPEECH_MODEL_MANIFEST)).digest('hex')
export const CAPABILITY_CAPSULE='.bloma-capabilities.json'
function path(projectId:string){
  if(!/^[A-Za-z0-9_-]+$/.test(projectId))throw Error('CAPABILITY_PROJECT_INVALID')
  return join(getPromaHome(),'software-environments',projectId,'capabilities.json')
}
function validateBinding(value:{version:number;speech?:SpeechCapabilityBinding}){
  if(value.version!==1)throw Error('CAPABILITY_BINDING_INVALID')
  const speech=value.speech
  if(!speech||!isAbsolute(speech.model_root)||speech.provider!=='python-sensevoice-v1'||speech.manifest_sha256!==speechManifestVersion()
    ||!speech.components||Array.isArray(speech.components)||!speech.dependencies||Array.isArray(speech.dependencies)
    ||['speech_runtime.py','speech_locator.py','speech_worker.py','speech_bridge.cjs'].some(name=>!/^[a-f0-9]{64}$/.test(speech.components[name]??''))
    ||['numpy','sherpa_onnx','sounddevice'].some(name=>typeof speech.dependencies[name]?.version!=='string'||typeof speech.dependencies[name]?.path!=='string'))throw Error('SPEECH_CAPABILITY_BINDING_CHANGED')
  return speech
}
function readBinding(file:string):SpeechCapabilityBinding|undefined{
  if(!existsSync(file))return
  return validateBinding(JSON.parse(readFileSync(file,'utf8')))
}
export function speechCapabilityBinding(projectId:string):SpeechCapabilityBinding|undefined{return readBinding(path(projectId))}
export function executionSpeechBinding(projectId:string,root?:string):SpeechCapabilityBinding|undefined{
  return root&&existsSync(join(root,CAPABILITY_CAPSULE))?readBinding(join(root,CAPABILITY_CAPSULE)):speechCapabilityBinding(projectId)
}
export function bindSpeechCapability(projectId:string,speech:SpeechCapabilityBinding){
  validateBinding({version:1,speech});writeTextFileAtomic(path(projectId),JSON.stringify({version:1,speech}))
}

const windowsRuntimePaths = new Map<string,string>()
const shortPathScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
public static class BlomaSpeechPath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
  static extern uint GetShortPathName(string path, StringBuilder output, uint capacity);
  public static string Shorten(string path) {
    var output = new StringBuilder(32768);
    return GetShortPathName(path, output, (uint)output.Capacity) > 0 ? output.ToString() : "";
  }
}
'@
[BlomaSpeechPath]::Shorten($env:BLOMA_SPEECH_PATH_TO_SHORTEN)
`

export function speechPythonPath(root:string) {
  return windowsRuntimePath(join(root,'.venv',process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
}

/** Use a verified short alias of the same owned file or directory for native Windows APIs. */
export function windowsRuntimePath(file:string) {
  // Leave headroom for native library and Windows speech profile suffixes.
  if (process.platform !== 'win32' || file.length < 160 || !existsSync(file)) return file
  const canonical = realpathSync.native(file)
  const cached = windowsRuntimePaths.get(canonical)
  if (cached && existsSync(cached) && realpathSync.native(cached) === canonical) return cached
  let result = file
  try {
    const systemRoot = process.env.SystemRoot ?? process.env.windir
    if (!systemRoot) return file
    const shell = join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
    const command = Buffer.from(shortPathScript,'utf16le').toString('base64')
    const alias = execFileSync(shell,['-NoProfile','-NonInteractive','-EncodedCommand',command],{
      env:{SystemRoot:systemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP,BLOMA_SPEECH_PATH_TO_SHORTEN:file},
      encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:32768,
    }).trim()
    if (isAbsolute(alias) && alias.length < file.length && realpathSync.native(alias) === canonical) result = alias
  } catch { /* A volume without DOS aliases keeps the declared interpreter. */ }
  if (windowsRuntimePaths.size >= 64) windowsRuntimePaths.clear()
  windowsRuntimePaths.set(canonical,result)
  return result
}

export function capabilityEnvironment(projectId:string,root?:string):Record<string,string>{
  const speech=executionSpeechBinding(projectId,root);if(!speech)return{}
  return{BLOMA_SPEECH_MODEL_DIR:speech.model_root,BLOMA_SPEECH_OFFLINE:'1',
    ...(root?{BLOMA_SPEECH_PYTHON:speechPythonPath(root)}:{})}
}
export function capabilityBindingVersion(projectId:string){
  const file=path(projectId);return existsSync(file)?createHash('sha256').update(readFileSync(file)).digest('hex'):'none'
}
