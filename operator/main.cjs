'use strict';
const {app,BrowserWindow,ipcMain,dialog,shell,Notification,Tray,Menu}=require('electron'),path=require('node:path');const {OperatorStore}=require('./store.cjs');app.setName('设计协作·运营端');app.setAppUserModelId('local.kyuan.designworkbench.operator');app.enableSandbox();if(process.env.OPERATOR_SMOKE_OUTPUT)app.setPath('userData',path.join(require('os').tmpdir(),'operator-smoke-'+process.pid));let win,store,timer,tray;let quitting=false;app.on('before-quit',()=>{quitting=true;clearInterval(timer)});let busy=false;let last=new Map();

const {historyInterval}=require('./task-index.cjs');
let sequence=0, polling=false;
const stamp=s=>({...s,sequence:++sequence});
function sendSnapshot(){if(!quitting && !win?.isDestroyed())win?.webContents.send('operator-change',stamp(store.snapshot()))}
async function refreshHistory(force=false){
  const index=store.index;
  if(!index.settings.name)return store.snapshot();
  if(index.history.job){await index.history.job;return store.snapshot()}
  index.historyError='';
  const job=index.scan('history',force);
  sendSnapshot();
  try{await job;index.nextHistoryAt=Date.now()+historyInterval}
  catch(e){index.historyError=e.message;index.nextHistoryAt=Date.now()+60000;throw e}
  finally{if(store.index===index)sendSnapshot()}
  return store.snapshot();
}
async function refreshActive(){
  const index=store.index;
  try{await store.scan();index.activeError=''}catch(e){index.activeError=e.message;throw e}
  if(store.index===index && index.settings.name && !index.history.job && Date.now()>=index.nextHistoryAt)
    setImmediate(()=>{if(!quitting && store.index===index && !index.history.job && Date.now()>=index.nextHistoryAt)refreshHistory().catch(()=>{})});
  return store.snapshot();
}

if(!app.requestSingleInstanceLock())app.quit();else{app.on('second-instance',()=>{win?.show();win?.focus()});app.whenReady().then(async()=>{store=await new OperatorStore(app.getPath('userData')).init();win=new BrowserWindow({icon:path.join(__dirname,'../assets/icon-operator.png'),width:1280,height:850,minWidth:760,minHeight:600,title:'设计协作·运营端',autoHideMenuBar:true,frame:false,titleBarStyle:'hidden',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});win.on('close',event=>{if(!quitting&&!process.env.OPERATOR_SMOKE_OUTPUT){event.preventDefault();win.hide()}});if(!process.env.OPERATOR_SMOKE_OUTPUT){tray=new Tray(path.join(__dirname,'../assets/icon-operator.png'));tray.setToolTip('设计协作 · 运营端（后台运行）');const show=()=>{if(win.isMinimized())win.restore();win.show();win.focus()};tray.setContextMenu(Menu.buildFromTemplate([{label:'打开运营端',click:show},{type:'separator'},{label:'退出软件',click:()=>app.quit()}]));tray.on('double-click',show);tray.on('click',show);}require('../core/window-chrome.cjs')(win,ipcMain);win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());ipcMain.handle('operator',async(event,command,payload={})=>{if(event.sender!==win.webContents)throw Error('无权限');try{if(busy)throw Error('正在流转，请稍后再操作');let result;if(command==='snapshot')result=store.snapshot();
else if(command==='scan'||command==='sync')result=await refreshActive();
else if(command==='refreshHistory')result=await refreshHistory(true);
else if(command==='configure'){
  busy=true;
  try{result=await store.bind(payload);last.clear()}finally{busy=false}
}else if(command==='submitFile'){if(typeof payload.path!=='string'||!path.isAbsolute(payload.path)||!payload.path.toLowerCase().endsWith('.xlsx'))throw Error('请拖入 .xlsx 格式的需求表');busy=true;try{try{result=await store.submit(payload.path)}catch(e){if(e.code!=='COPIED_TASK')throw e;const answer=await dialog.showMessageBox(win,{type:'question',title:'作为新需求提交',message:'检测到旧任务编号',detail:'文件：'+path.basename(payload.path)+'\n如果这是复制旧表填写的新需求，可作为新需求提交。仅清除上传副本的旧编号，保留本地文件和原任务。同名需求仍会拦截。',buttons:['取消','作为新需求提交'],defaultId:0,cancelId:0});if(answer.response!==1)throw Error('已取消，未上传。原任务修改请编辑 NAS 中原表。');result=await store.submit(payload.path,{asNew:true,expectedHash:e.sourceHash})}}finally{busy=false}}else if(command==='submit'){const selected=await dialog.showOpenDialog(win,{properties:['openFile'],filters:[{name:'Excel 需求表',extensions:['xlsx']}]});if(selected.canceled)return {ok:true,value:null};busy=true;try{result=await store.submit(selected.filePaths[0])}finally{busy=false}}else if(command==='approve'){if(busy)throw Error('正在处理，请稍候');busy=true;try{const now=new Date();const date=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(now);const time=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',hourCycle:'h23'}).format(now)+':00';result=await store.approve(payload.id,date,time,payload.ratings)}finally{busy=false}}else if(command==='correctCode'){busy=true;try{result=await store.correctCode(payload.id,payload.code,payload.expectedHash)}finally{busy=false}}else if(command==='open'){const r=await store.own(payload.id,[0,1,2,3,4]);if([1,2].includes(r.t.state))throw Error('此阶段仅提供软件内只读查看');const err=await shell.openPath(r.file);if(err)throw Error('无法打开 Excel：'+err);result={opened:true}}else throw Error('不支持的操作');return {ok:true,value:result?.settings?stamp(store.snapshot()):result}}catch(e){return {ok:false,error:e.message,reasons:e.reasons||[]}}});await win.loadFile(path.join(__dirname,'index.html'));if(process.env.OPERATOR_SMOKE_OUTPUT){setTimeout(async()=>{try{const result=await win.webContents.executeJavaScript(`(()=>{document.querySelector('dialog').close();acceptNative({settings:{name:'测试运营',root:''},tasks:[],checkedAt:Date.now()});modal('任务明细','测试内容',true);return {title:document.title,body:document.body.innerText,bridge:!!window.operatorApi,drawer:getComputedStyle(document.querySelector('dialog')).right,identity:document.querySelector('#identity').innerText,avatar:!!document.querySelector('.person-avatar'),nas:document.querySelector('#nas-status').innerText,mainOverflow:getComputedStyle(document.querySelector('main')).overflowY}})()`);require('fs').writeFileSync(process.env.OPERATOR_SMOKE_OUTPUT,JSON.stringify(result));}finally{app.quit()}},1500);return;}timer=setInterval(async()=>{if(busy||polling||!store.settings.name)return;polling=true;const index=store.index;try{const s=await refreshActive();if(store.index!==index)return;for(const t of s.tasks)if(!last.has(t.filename)&&t.state===3&&Notification.isSupported())new Notification({title:'有需求待确认',body:t.title}).show();last=new Map(s.tasks.filter(t=>t.state===3).map(t=>[t.filename,t.state]));sendSnapshot()}catch(e){if(store.index===index)win?.webContents.send('operator-error',e.message)}finally{polling=false}},15000);app.on('window-all-closed',()=>{if(quitting||process.env.OPERATOR_SMOKE_OUTPUT){clearInterval(timer);app.quit()}})})}
