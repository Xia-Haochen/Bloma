const {contextBridge, ipcRenderer} = require('electron')
contextBridge.exposeInMainWorld('reference', {
  load: () => ipcRenderer.invoke('reference:load'),
  speech: file => ipcRenderer.invoke('reference:speech', file),
})
