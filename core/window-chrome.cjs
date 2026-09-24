module.exports=function(win,ipcMain){
  ipcMain.handle('window-chrome',(event,action)=>{
    if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame)throw Error('无权限');
    if(action==='minimize')win.minimize();
    else if(action==='maximize'){win.isMaximized()?win.unmaximize():win.maximize();}
    else if(action==='close')win.close();
    else if(action!=='state')throw Error('不支持的窗口操作');
    return {maximized:win.isMaximized()};
  });
  for(const event of ['maximize','unmaximize'])win.on(event,()=>win.webContents.send('window-chrome-state',{maximized:win.isMaximized()}));
};
