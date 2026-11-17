import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium } from 'playwright'

const root=resolve('tests/fixtures/personal-wish'),assets=join(root,'assets')
mkdirSync(assets,{recursive:true})
const records=[]
function record(name,meaning){const bytes=readFileSync(join(assets,name));records.push({name,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,meaning,source:'synthetic_test_fixture'})}
function text(name,content,meaning){writeFileSync(join(assets,name),content,'utf8');record(name,meaning)}
text('meeting.txt','会议记录：小林说展览周六开始。预算尚未决定。\n','与白板日期冲突；预算未知')
text('game-notes.txt','游戏A：石桥村有红色旗帜。游戏B：也有石桥村，但没有证据说明它们是同一地点。\n','同名不同对象，不允许自动合并')
text('personal-records.json',JSON.stringify({objects:[{id:'obj-A',name:'旧外套',exempt:true},{id:'obj-B',name:'旧外套',exempt:false}],rule:{version:1,temporaryOverrides:[]}},null,2),'同名身份及例外')
for(const [name,hz]of [['tone-a.wav',220],['tone-b.wav',330]]){
  const rate=16000,count=rate,buffer=Buffer.alloc(44+count*2)
  buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);buffer.writeUInt32LE(rate,24);buffer.writeUInt32LE(rate*2,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(count*2,40)
  for(let i=0;i<count;i++)buffer.writeInt16LE(Math.round(Math.sin(2*Math.PI*hz*i/rate)*1500),44+i*2)
  writeFileSync(join(assets,name),buffer);record(name,'一秒低音量合成音，禁止伪称用户真实录音')
}
const browser=await chromium.launch({headless:true,...(existsSync(chromium.executablePath())?{executablePath:chromium.executablePath()}:{channel:process.platform==='win32'?'msedge':'chrome'})})
try{
  const page=await browser.newPage({viewport:{width:640,height:400}})
  for(const [name,body,meaning]of [
    ['whiteboard.png','<h1>展览准备白板</h1><p>开幕：周日</p><p>预算：待确认</p>','日期与会议文字冲突，预算仍未知'],
    ['cover.png','<h1>我的收藏小展览</h1><p>原始封面 · 请保留图形</p><svg width="200" height="150"><circle cx="75" cy="75" r="50" fill="#6d8268"/><path d="M100 15L160 120H40Z" fill="#d9bd83"/></svg>','必须使用资源，与风格参考区分'],
    ['game.png','<h1>石桥村</h1><p>截图编号 A-01</p><div style="font-size:70px">⚑</div>','合成游戏场景；不能推断未给出的游戏机制']]){
    await page.setContent(`<html><meta charset="utf-8"><body style="background:#fffefb;color:#30342f;padding:28px;font-family:Arial">${body}</body></html>`)
    await page.screenshot({path:join(assets,name)});record(name,meaning)
  }
  // Optional real video fixture; absence remains explicit, never substituted by an image.
  let videoContext
  try{
    videoContext=await browser.newContext({viewport:{width:320,height:240},recordVideo:{dir:resolve('run-artifacts/personal-wish-video'),size:{width:320,height:240}}})
    const clip=await videoContext.newPage();await clip.setContent('<html><body><h1>Practice 01</h1><div id="dot" style="width:30px;height:30px;background:green;position:absolute"></div><script>let x=0;setInterval(()=>{document.querySelector("#dot").style.left=(x++%200)+"px"},30)</script></body></html>')
    await clip.waitForTimeout(1200);const video=clip.video();await videoContext.close();videoContext=undefined
    copyFileSync(await video.path(),join(assets,'practice.webm'));record('practice.webm','真实浏览器录制的合成运动片段，非用户录像')
  }catch(error){records.push({name:'practice.webm',status:'unavailable',reason:String(error).slice(0,300)})}
  finally{await videoContext?.close()}
}finally{await browser.close()}
writeFileSync(join(root,'assets-manifest.json'),JSON.stringify({version:1,scope:'synthetic_inputs_not_generated_product_acceptance',assets:records},null,2)+'\n')
console.log(JSON.stringify({assets:records.map(r=>({name:r.name,status:r.status??'prepared'})),model_requests:0}))
