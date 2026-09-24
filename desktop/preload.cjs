'use strict';
const {contextBridge,ipcRenderer,webUtils}=require('electron');
contextBridge.exposeInMainWorld('windowChrome',{call:action=>ipcRenderer.invoke('window-chrome',action),onState:callback=>{const fn=(_event,value)=>callback(value);ipcRenderer.on('window-chrome-state',fn);return ()=>ipcRenderer.removeListener('window-chrome-state',fn)}});
contextBridge.exposeInMainWorld('workbench',{
 call:(command,payload={})=>ipcRenderer.invoke('workbench:call',command,payload),
 dropAssets:(files,payload={})=>{
  const paths=Array.from(files).map(file=>webUtils.getPathForFile(file));
  if(!paths.length||paths.some(p=>!p))throw Error('请从文件资源管理器拖入真实的交付文件夹');
  return ipcRenderer.invoke('workbench:call','asset-drop',{taskId:payload.taskId,itemId:payload.itemId,productDecision:payload.productDecision,naming:payload.naming,paths});
 },
 onChange:callback=>{const fn=(_event,value)=>callback(value);ipcRenderer.on('workbench:change',fn);return ()=>ipcRenderer.removeListener('workbench:change',fn)},
 onSyncStatus:callback=>{const fn=(_event,value)=>callback(value);ipcRenderer.on('workbench:sync-status',fn);return ()=>ipcRenderer.removeListener('workbench:sync-status',fn)},
 onProgress:callback=>{const fn=(_event,value)=>callback(value);ipcRenderer.on('workbench:progress',fn);return ()=>ipcRenderer.removeListener('workbench:progress',fn)},
 onOpenTask:callback=>{const fn=(_event,value)=>callback(value);ipcRenderer.on('workbench:open-task',fn);return ()=>ipcRenderer.removeListener('workbench:open-task',fn)},
 ready:()=>ipcRenderer.send('workbench:ready')
});
