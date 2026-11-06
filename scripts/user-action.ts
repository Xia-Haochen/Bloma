/** Only these errors are recoverable by another public observation/decision.
 * Accounting, cancellation, integrity and unknown engine failures stay fatal. */
export class UserInteractionError extends Error {
  constructor(readonly kind:'response'|'action'|'surface',readonly publicMessage:string,readonly effect:'none'|'unknown'='none',options?:ErrorOptions){
    super(publicMessage,options);this.name='UserInteractionError'
  }
}
export const userInputKeys=[...'abcdefghijklmnopqrstuvwxyz0123456789','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space','Enter','Escape','Tab','Shift']
export type UserAction={action:'reply'|'click'|'fill'|'select'|'upload'|'draw'|'input'|'wait'|'reopen'|'finish'|'stop';text?:string;choice?:number;observation?:string;ref?:number;value?:string;files?:string[];points?:Array<{x:number;y:number;delay?:number}>;milliseconds?:number;keys?:string[];pointer?:{ref:number;x:number;y:number;button?:'left'|'right'|'middle'}}
const fields:Record<UserAction['action'],string[]>={reply:['text','choice'],click:['ref'],fill:['ref','value'],select:['ref','value'],upload:['ref','files'],draw:['ref','points'],input:['keys','pointer','milliseconds'],wait:['milliseconds'],reopen:[],finish:['text'],stop:['text']}
const properties:Record<string,unknown>={
  keys:{type:'array',maxItems:4,uniqueItems:true,items:{type:'string',enum:[...userInputKeys,...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']}},
  pointer:{type:'object',additionalProperties:false,required:['ref','x','y'],properties:{ref:{type:'integer',minimum:0},x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1},button:{type:'string',enum:['left','right','middle']}}},
  ref:{type:'integer',minimum:0},text:{type:'string',minLength:1,maxLength:2000},choice:{type:'integer',minimum:0},
  value:{type:'string',maxLength:2000},files:{type:'array',minItems:1,uniqueItems:true,items:{type:'string'}},milliseconds:{type:'integer',minimum:0,maximum:3000},
  points:{type:'array',minItems:2,maxItems:50,items:{type:'object',additionalProperties:false,required:['x','y'],properties:{x:{type:'number',minimum:0,maximum:1},y:{type:'number',minimum:0,maximum:1},delay:{type:'integer',minimum:0,maximum:500}}}}
}
export interface UserActionContext {question?:{choices:Array<{index:number;label:string}>};hasApp?:boolean}
/** The same contract advertises and validates the operations available now. */
export function userActionContract(context:UserActionContext){
  const question=context.question
  const actions:UserAction['action'][]=question?['reply','stop']:context.hasApp?Object.keys(fields) as UserAction['action'][]:['stop']
  const allowedFields=(action:UserAction['action'])=>fields[action].filter(k=>k!=='choice'||Boolean(question?.choices.length))
  const hint=question?'当前是问题卡片：用reply回答；choice选择卡片列出的编号，text可补充说明；用stop结束未验证。':'请根据当前画面选择操作。'
  const tool={name:'perform_user_action',description:`${hint} 每次只提交一个动作，等待真实执行及新观察。${question?'':'应用操作：click点击；fill输入；select按显示文字选择下拉选项；upload选择可用文件；draw画线；input同时按住keys中的键、可选移动到pointer指定画布归一化坐标并按住鼠标，持续milliseconds后自动松开；wait等待；reopen重开；reply反馈体验；finish结束评价。'}`,input_schema:{
    type:'object',additionalProperties:false,properties:{action:{type:'string',enum:actions},...Object.fromEntries([...new Set(actions.flatMap(allowedFields))].map(k=>[k,k==='choice'?{type:'integer',enum:question!.choices.map(c=>c.index)}:properties[k]]))},required:['action'],
    oneOf:actions.map(action=>({type:'object',additionalProperties:false,properties:{action:{const:action},...Object.fromEntries(allowedFields(action).map(k=>[k,k==='choice'?{type:'integer',enum:question!.choices.map(c=>c.index)}:properties[k]]))},required:['action',...allowedFields(action).filter(k=>!(question&&action==='reply')&&k!=='choice'&&!(action==='input'&&['keys','pointer'].includes(k)))],
      ...(action==='input'?{anyOf:[{required:['keys']},{required:['pointer']}]}:question&&action==='reply'?{anyOf:question.choices.length?[{required:['choice']},{required:['text']}]:[{required:['text']}]}:{})}))
  }}
  const parse=(raw:unknown):UserAction=>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new UserInteractionError('action',hint)
    const action={...raw} as UserAction
    if(!actions.includes(action.action))throw new UserInteractionError('action',`${hint} 当前可用动作：${actions.join('、')}。`)
    const extra=Object.keys(action).filter(k=>!['action','observation',...allowedFields(action.action)].includes(k))
    if(extra.length)throw new UserInteractionError('action',`${hint} ${action.action}不接受字段${extra.join('、')}；可用字段：${allowedFields(action.action).join('、')}。`)
    if(question&&action.action==='reply'&&action.choice!==undefined){
      const choice=question.choices.find(c=>c.index===action.choice)
      if(!choice)throw new UserInteractionError('action','请选择当前卡片实际列出的选项编号，或用text直接回答。')
      if(action.text===undefined)action.text=choice.label
    }
    return validateUserAction(action)
  }
  return{tool,parse}
}
const fail=(message:string):never=>{throw new UserInteractionError('action',message)}
/** Validate the complete intent before any side effect. IDs always come from the host. */
export function validateUserAction(raw:unknown):UserAction{
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return fail('请只提交一个动作对象；每次操作后先查看新画面，再决定下一步。')
  const a=raw as UserAction
  if(!Object.hasOwn(fields,a.action))return fail('动作不受支持，请使用当前可用的用户操作。')
  const extra=Object.keys(a).filter(k=>!['action','observation',...fields[a.action]].includes(k))
  if(extra.length)return fail(`${a.action}不接受字段${extra.join('、')}；可用字段：${fields[a.action].join('、')}。`)
  if(['reply','finish','stop'].includes(a.action)&&(typeof a.text!=='string'||!a.text.trim()||a.text.length>2000))return fail('请用不超过2000字说明回复或试用结论。')
  if(a.choice!==undefined&&(!Number.isSafeInteger(a.choice)||a.choice<0))return fail('请选择卡片中显示的选项。')
  if(fields[a.action].includes('ref')&&(!Number.isSafeInteger(a.ref)||a.ref!<0))return fail('请使用当前画面中的控件编号。')
  if(['fill','select'].includes(a.action)&&(typeof a.value!=='string'||a.value.length>2000))return fail('请输入不超过2000字的文本或显示的选项。')
  if(a.action==='upload'&&(!Array.isArray(a.files)||!a.files.length||a.files.some(id=>typeof id!=='string')||new Set(a.files).size!==a.files.length))return fail('请选择可用文件列表中的文件，不能重复。')
  if(a.action==='input'){
    if(!Number.isSafeInteger(a.milliseconds)||a.milliseconds!<0||a.milliseconds!>3000)return fail('组合输入时长应在0到3000毫秒之间，之后重新观察。')
    if(Array.isArray(a.keys))a.keys=a.keys.map(k=>typeof k==='string'&&/^[A-Z]$/.test(k)?k.toLowerCase():k)
    if(a.keys!==undefined&&(!Array.isArray(a.keys)||a.keys.length>4||new Set(a.keys).size!==a.keys.length||a.keys.some(k=>!userInputKeys.includes(k))))return fail('请选择允许的页面按键，最多同时4个；不支持系统组合键。')
    const p=a.pointer
    if(p!==undefined&&(!p||typeof p!=='object'||Object.keys(p).some(k=>!['ref','x','y','button'].includes(k))||!Number.isSafeInteger(p.ref)||p.ref<0||![p.x,p.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1)||p.button!==undefined&&!['left','right','middle'].includes(p.button)))return fail('鼠标输入需要当前画布编号和0到1的坐标。')
    if(!a.keys?.length&&!p)return fail('组合输入至少需要按键或画布上的鼠标动作。')
  }
  if(a.action==='wait'&&(!Number.isSafeInteger(a.milliseconds)||a.milliseconds!<0||a.milliseconds!>3000))return fail('每次等待时间应在0到3000毫秒之间，之后重新观察。')
  if(a.action==='draw'&&(!Array.isArray(a.points)||a.points.length<2||a.points.length>50||a.points.some(p=>!p||![p.x,p.y].every(n=>Number.isFinite(n)&&n>=0&&n<=1)||p.delay!==undefined&&(!Number.isSafeInteger(p.delay)||p.delay<0||p.delay>500))))return fail('画线需要2到50个画布内的归一化坐标，点间延时不超过500毫秒。')
  return a
}
