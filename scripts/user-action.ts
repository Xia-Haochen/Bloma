/** Only these errors are recoverable by another public observation/decision.
 * Accounting, cancellation, integrity and unknown engine failures stay fatal. */
export class UserInteractionError extends Error {
  constructor(readonly kind:'response'|'action'|'surface',readonly publicMessage:string,readonly effect:'none'|'unknown'='none',options?:ErrorOptions){
    super(publicMessage,options);this.name='UserInteractionError'
  }
}
export type UserAction={action:'reply'|'click'|'fill'|'select'|'upload'|'draw'|'wait'|'reopen'|'finish'|'stop';text?:string;choice?:number;observation?:string;ref?:number;value?:string;files?:string[];points?:Array<{x:number;y:number;delay?:number}>;milliseconds?:number}
const fields:Record<UserAction['action'],string[]>={reply:['text','choice'],click:['ref'],fill:['ref','value'],select:['ref','value'],upload:['ref','files'],draw:['ref','points'],wait:['milliseconds'],reopen:[],finish:['text'],stop:['text']}
const fail=(message:string):never=>{throw new UserInteractionError('action',message)}
/** Validate the complete intent before any side effect. IDs always come from the host. */
export function validateUserAction(raw:unknown):UserAction{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail('请只提交一个动作对象；每次操作后先查看新画面，再决定下一步。')
  const a=raw as UserAction
  if(!Object.hasOwn(fields,a.action))return fail('动作不受支持，请使用当前可用的用户操作。')
  if(Object.keys(a).some(k=>!['action','observation',...fields[a.action]].includes(k)))return fail('动作包含不适用的字段，请只提供该动作所需的信息。')
  if(['reply','finish','stop'].includes(a.action)&&(typeof a.text!=='string'||!a.text.trim()||a.text.length>2000))return fail('请用不超过2000字说明回复或试用结论。')
  if(a.choice!==undefined&&(!Number.isSafeInteger(a.choice)||a.choice<0))return fail('请选择卡片中显示的选项。')
  if(fields[a.action].includes('ref')&&(!Number.isSafeInteger(a.ref)||a.ref!<0))return fail('请使用当前画面中的控件编号。')
  if(['fill','select'].includes(a.action)&&(typeof a.value!=='string'||a.value.length>2000))return fail('请输入不超过2000字的文本或显示的选项。')
  if(a.action==='upload'&&(!Array.isArray(a.files)||!a.files.length||a.files.some(id=>typeof id!=='string')||new Set(a.files).size!==a.files.length))return fail('请选择可用文件列表中的文件，不能重复。')
  if(a.action==='wait'&&(!Number.isSafeInteger(a.milliseconds)||a.milliseconds!<0||a.milliseconds!>3000))return fail('每次等待时间应在0到3000毫秒之间，之后重新观察。')
  if(a.action==='draw'&&(!Array.isArray(a.points)||a.points.length<2||a.points.length>50||a.points.some(p=>!p||![p.x,p.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1)||p.delay!==undefined&&(!Number.isSafeInteger(p.delay)||p.delay<0||p.delay>500))))return fail('画线需要2到50个画布内的归一化坐标，点间延时不超过500毫秒。')
  return a
}
