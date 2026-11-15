const transcript = document.querySelector('#transcript')
const reply = document.querySelector('#reply')
const audio = document.querySelector('#audio')
const status = document.querySelector('#status')
function show(record) {
  transcript.textContent = record.text
  reply.textContent = record.reply
}
window.reference.load().then(record => { if(record) show(record) })
document.querySelector('#input').addEventListener('change', async event => {
  status.textContent = '处理中'
  try {
    const file = event.target.files[0]
    // webUtils is unnecessary here: fixture input is read as bytes by the UI.
    const bytes = new Uint8Array(await file.arrayBuffer())
    let encoded = ''
    for (const byte of bytes) encoded += String.fromCharCode(byte)
    const result = await window.reference.speech(btoa(encoded))
    show(result)
    audio.src = 'data:audio/wav;base64,' + result.audio
    audio.onended = () => { status.textContent = '播放完成' }
    await audio.play()
  } catch(error) { status.textContent = String(error) }
})
