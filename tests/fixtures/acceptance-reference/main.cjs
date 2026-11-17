const {app, BrowserWindow, ipcMain} = require('electron')
const {spawn} = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const config = require('./calibration-config.json')
const data = process.env.APP_DATA_DIR
if (!data) throw Error('REFERENCE_DATA_DIRECTORY_REQUIRED')
fs.mkdirSync(data, {recursive: true})
const record = path.join(data, 'conversation.json')
function runSpeech(input) {
  return new Promise((resolve, reject) => {
    const inputFile = path.join(data, 'input.wav')
    fs.writeFileSync(inputFile, Buffer.from(input, 'base64'))
    const child = spawn(process.env.BLOMA_SPEECH_PYTHON || config.python, ['-I', '-B', path.join(__dirname, 'voice.py'), inputFile, data, config.tts], {
      cwd: __dirname, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = '', error = ''
    const timer = setTimeout(() => child.kill(), 60000)
    child.stdout.on('data', bytes => { output += bytes })
    child.stderr.on('data', bytes => { error += bytes })
    child.on('error', reject)
    child.on('close', code => {
      clearTimeout(timer)
      if (code !== 0) return reject(Error(error || 'REFERENCE_SPEECH_FAILED'))
      try {
        const result = JSON.parse(output.trim().split('\n').at(-1))
        fs.writeFileSync(record, JSON.stringify(result))
        resolve({...result, audio: fs.readFileSync(result.file).toString('base64')})
      } catch (failure) { reject(failure) }
    })
  })
}
app.whenReady().then(() => {
  ipcMain.handle('reference:load', () => fs.existsSync(record) ? JSON.parse(fs.readFileSync(record)) : null)
  ipcMain.handle('reference:speech', (_event, file) => runSpeech(file))
  const window = new BrowserWindow({width: 700, height: 500, webPreferences: {preload: path.join(__dirname, 'preload.cjs')}})
  window.loadFile('index.html')
})
app.on('window-all-closed', () => app.quit())
