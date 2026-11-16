const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('reference',{action:(name,input)=>ipcRenderer.invoke('reference:action',name,input)})
