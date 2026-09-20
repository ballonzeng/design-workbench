const {contextBridge,ipcRenderer,webUtils}=require('electron');contextBridge.exposeInMainWorld('operatorApi',{filePath:file=>webUtils.getPathForFile(file),call:(command,payload)=>ipcRenderer.invoke('operator',command,payload),onChange:fn=>ipcRenderer.on('operator-change',(_,v)=>fn(v)),onError:fn=>ipcRenderer.on('operator-error',(_,v)=>fn(v))});

contextBridge.exposeInMainWorld('windowChrome',{call:action=>ipcRenderer.invoke('window-chrome',action),onState:fn=>ipcRenderer.on('window-chrome-state',(_,state)=>fn(state))});
