'use strict';
const {app,BrowserWindow,ipcMain,Menu,Tray,Notification,nativeImage,dialog,safeStorage,shell,clipboard,session}=require('electron');
const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');const {pathToFileURL}=require('node:url');
const {Service}=require('../core/service.cjs');const {Client,decodeCode}=require('../core/client.cjs');const {fileHash,isInside,guarded}=require('../core/nas.cjs');const {PEOPLE}=require('../core/rules.cjs');
const {scanDelivery}=require('./delivery.cjs');
const {normalizeDeliveryFolder,ignoredDeliveryEntry}=require('../core/delivery.cjs');
const pkg=require('../package.json'),role=pkg.clientRole==='designer'?'designer':'manager';
const {createReport,periodRange}=require('../core/report.cjs');
const {notificationOptions}=require('./notifications.cjs');
const name=role==='manager'?'设计协作·负责人端':'设计协作·设计端';
const smokeIndex=process.argv.indexOf('--smoke-test'),smoke=smokeIndex>=0,smokeOutput=smoke?process.argv[smokeIndex+1]:null;
if(smoke&&(!smokeOutput||!path.isAbsolute(smokeOutput)))throw Error('Smoke check requires an absolute output path');
if(smoke)app.setPath('userData',path.join(path.dirname(smokeOutput),'profile'));
app.setName(name);app.setAppUserModelId('local.kyuan.designworkbench.'+role);app.enableSandbox();
const appDir=path.resolve(__dirname,'..'),uiFile=path.join(appDir,'ui','index.html'),appURL=pathToFileURL(uiFile).href,iconFile=path.join(appDir,'assets',role==='manager'?'icon-manager.png':'icon-designer.png');
let win,tray,service,client,settings={},online=role==='manager',connectionError='',quitting=false,uploading=false,currentSnapshot=null,refreshPromise=null,refreshQueued=false,saveQueue=Promise.resolve(),smokeFinished=false;
const chosen=new Map(),notifications=new Set(),manager={role:'manager',personId:'zeng'};
const report={role,packaged:app.isPackaged,version:app.getVersion(),loaded:false,rendererReady:false,errors:[]};
function show(){if(!win||win.isDestroyed())return;if(win.isMinimized())win.restore();win.show();win.focus()}
function syncStatus(status){if(currentSnapshot)currentSnapshot.workbookSync=status;win?.webContents.send('workbench:sync-status',status)}
async function save(){
 const value=JSON.stringify(settings);
 saveQueue=saveQueue.catch(()=>{}).then(async()=>{const bytes=await safeStorage.encryptStringAsync(value),file=path.join(app.getPath('userData'),'settings.enc');await fsp.mkdir(path.dirname(file),{recursive:true});await fsp.writeFile(file+'.tmp',bytes);await fsp.rename(file+'.tmp',file)});
 return saveQueue;
}
async function load(){
 const file=path.join(app.getPath('userData'),'settings.enc');
 if(fs.existsSync(file)){const result=await safeStorage.decryptStringAsync(await fsp.readFile(file));settings=JSON.parse(result.result)}
}
function notifyTask(task){
 if(smoke||!Notification.isSupported())return;
 const n=new Notification(notificationOptions(task,settings,iconFile));
 notifications.add(n);n.on('close',()=>notifications.delete(n));n.on('failed',()=>notifications.delete(n));
 n.on('click',()=>{show();win.webContents.send('workbench:open-task',task.id)});n.show();
}
function localAddresses(){return Object.entries(os.networkInterfaces()).flatMap(([adapter,entries])=>entries.filter(e=>e.family==='IPv4'&&!e.internal&&!e.address.startsWith('169.254.')&&!e.address.startsWith('198.18.')).map(e=>({address:e.address,adapter})))}
async function openService(){
 const dir=path.join(app.getPath('userData'),'workspaces',settings.workspace||'unconfigured');
 service=new Service(dir,{identity:settings.identity,saveIdentity:async identity=>{settings.identity=identity;await save()},host:smoke?'127.0.0.1':'0.0.0.0',port:smoke?0:47831});
 await service.start();service.on('change',()=>refresh().catch(()=>{}));service.on('presence',()=>refresh().catch(()=>{}));service.on('sync-status',syncStatus);
}
function connectClient(){
 client?.close();client=new Client(settings.connection);
 client.events(message=>message?.kind==='sync-status'?syncStatus(message.status):refresh().catch(()=>{}),(connected,error)=>{online=connected;connectionError=error||'';if(!connected&&currentSnapshot){currentSnapshot={...currentSnapshot,connection:{online:false,error:connectionError}};win?.webContents.send('workbench:change',currentSnapshot)}});
}
async function invoke(command,payload={}){
 if(role==='manager'&&!settings.remoteManager){if(!service?.server?.listening)throw Error(connectionError||'负责人服务尚未启动');return service.call(manager,command,payload,crypto.randomUUID())}
 if(!client)throw Error('请先连接负责人端');
 return client.rpc(command,payload);
}
async function refresh(){
 if(refreshPromise){refreshQueued=true;return refreshPromise}
 refreshPromise=(async()=>{
  do{refreshQueued=false;
  try{
   let snapshot;
   if(role==='designer'&&!client)snapshot={role,person:null,tasks:[],people:[],nasStatus:{connected:false},requiresPairing:true};
   else snapshot=await invoke('snapshot');
   online=role==='manager'||!!client;connectionError='';
   currentSnapshot={...snapshot,remoteManager:!!settings.remoteManager,role,version:pkg.version,connection:{online,error:''},addresses:role==='manager'?localAddresses():[],preferences:{autostart:app.getLoginItemSettings().openAtLogin,mute:!!settings.mute}};
   if(role==='designer'&&client){
    const seen=new Set(settings.seenNotifications||[]);
    for(const task of snapshot.tasks.filter(t=>t.assignmentId)){
     if(task.state<4&&!seen.has(task.assignmentId)){notifyTask(task);seen.add(task.assignmentId)}
     if(!task.receivedAt)await client.rpc('received',{taskId:task.id,assignmentId:task.assignmentId});
    }
    settings.seenNotifications=[...seen].slice(-2000);settings.cachedSnapshot=currentSnapshot;await save();
   }
  }catch(e){
   online=false;connectionError=e.message;currentSnapshot={...(settings.cachedSnapshot||currentSnapshot||{role,tasks:[],people:[],nasStatus:{connected:false}}),remoteManager:!!settings.remoteManager,role,connection:{online:false,error:e.message},addresses:role==='manager'?localAddresses():[],version:pkg.version};
  }
  win?.webContents.send('workbench:change',currentSnapshot);
  }while(refreshQueued&&!quitting);
  return currentSnapshot;
 })().finally(()=>{refreshPromise=null});
 return refreshPromise;
}
async function selectFiles(payload){
 if(role!=='designer')throw Error('仅设计端可以上传封存');
 if(uploadBatchActive||uploading)throw Error('已有文件正在上传，请等待封存完成');
 let paths=payload.paths;
 if(payload.selectionId){const prior=chosen.get(payload.selectionId);if(!prior?.root||prior.taskId!==payload.taskId)throw Error('选择已失效，请重新选择文件夹');paths=[prior.root]}
 if(paths===undefined){const result=await dialog.showOpenDialog(win,{title:'选择整个交付文件夹',properties:['openDirectory']});if(result.canceled)return null;paths=result.filePaths}
 if(!Array.isArray(paths)||paths.length!==1)throw Error('每次请拖入一个完整的交付文件夹');
 const root=path.resolve(paths[0]),info=await invoke('archive-spec',{taskId:payload.taskId});
 if(info.namingVersion!==4||!info.namingRepairVersion)throw Error('请先更新负责人主机，才能使用命名纠正');
 const {batch,preview}=await require('./delivery-selection.cjs').planSelection(root,info,folder=>invoke('archive-spec',{taskId:payload.taskId,folder}),payload.naming||{repair:true});
 const id=crypto.randomUUID();chosen.clear();chosen.set(id,{root,taskId:payload.taskId,namingIssues:preview.namingIssues,batch:batch.map(s=>({...s,taskId:payload.taskId,productDecision:payload.productDecision}))});
 return {selectionId:id,...preview};
}
let uploadBatchActive=false;
let uploadBatchProgress=null;
function sendUploadProgress(progress){
 const batch=uploadBatchProgress;let percent=progress.percent;
 if(batch){const phase=progress.phase==='校验文件'?percent*.15:progress.phase==='上传产物'?15+percent*.7:90;percent=Math.floor((batch.index+phase/100)/batch.count*100);progress={...progress,phase:(batch.index+1)+' / '+batch.count+' 类 · '+batch.label+' · '+progress.phase,percent}}
 win?.webContents.send('workbench:progress',progress);
}
async function upload(payload){
 if(uploadBatchActive||uploading)throw Error('已有文件正在上传');const selected=chosen.get(payload.selectionId);if(!selected?.batch)throw Error('请重新选择交付文件夹');if(selected.taskId!==payload.taskId)throw Error('任务选择已变化，请重新选择');if(selected.namingIssues?.length)throw Error('请先处理命名预览中的问题，再上传');if(payload.selfChecked!==true)throw Error('请先确认命名预览');
 uploadBatchActive=true;
 try{let completed=0;for(const selection of selected.batch){uploadBatchProgress={index:completed,count:selected.batch.length,label:selection.spec.categoryName};const id=crypto.randomUUID();chosen.set(id,selection);try{const result=await uploadOne({...payload,selectionId:id});if(result?.pending)return {...result,completed,total:selected.batch.length};completed++}catch(e){chosen.delete(id);throw Error('已归档 '+completed+' / '+selected.batch.length+' 类；'+selection.folder+' 未完成：'+e.message+'。已成功的类别不会回滚，重新选择会跳过已归档类别。')}}chosen.delete(payload.selectionId);return {completed}}
 finally{chosen.clear();uploadBatchActive=false;uploadBatchProgress=null}
}
async function uploadOne(payload){
 if(role!=='designer'||!client)throw Error('设计端尚未连接');if(uploading)throw Error('已有文件正在上传');
 const selection=chosen.get(payload.selectionId);if(!selection)throw Error('请重新选择文件');if(payload.selfChecked!==true)throw Error('请先完成自检');
 uploading=true;
 try{
  const fresh=await scanDelivery(selection.root,selection.spec,{automatic:true,naming:selection.naming});
  const signature=s=>JSON.stringify({dirs:s.originalDirectories,files:s.files.map(f=>[f.relativePath,f.size,f.mtimeMs])});
  if(signature(fresh)!==signature(selection))throw Error('交付文件夹内容已变化，请重新拖入并自检');
  const files=[];for(let i=0;i<selection.files.length;i++){
   const f=selection.files[i];sendUploadProgress({phase:'校验文件',current:i+1,count:selection.files.length,percent:Math.round(i/selection.files.length*100)});
   await guarded(selection.root,...f.relativePath.split('/'));
   const stat=await fsp.lstat(f.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==f.size||stat.mtimeMs!==f.mtimeMs)throw Error('文件已变化，请重新选择：'+f.relativePath);
   const sha256=await fileHash(f.file),after=await fsp.lstat(f.file);
   if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('文件正在被修改，请保存后重新上传：'+f.relativePath);
   files.push({...f,sha256});
  }
   const batch=await client.rpc('archive-prepare',{taskId:selection.taskId,selfChecked:true,productDecision:selection.productDecision,delivery:{version:1,namingVersion:4,folder:selection.folder,directories:selection.originalDirectories,naming:selection.naming},files:files.map(({file,mtimeMs,...f})=>f)});
  let sent=0;const total=files.reduce((n,f)=>n+f.size,0);
  for(let i=0;i<files.length;i++){
   if(!batch.received[String(i)]){
    await guarded(selection.root,...files[i].relativePath.split('/'));
    await client.upload(batch.id,batch.files[i],files[i].file,loaded=>sendUploadProgress({phase:'上传产物',current:i+1,count:files.length,percent:total?Math.round((sent+loaded)/total*100):100}));
   }
   sent+=files[i].size;
  }
  sendUploadProgress({phase:'归档并回填需求表',percent:100});
  const result=await client.rpc('archive-commit',{uploadId:batch.id});chosen.delete(payload.selectionId);await refresh();return result;
 }finally{uploading=false}
}
 const COMMANDS=new Set(['snapshot','sync-requirements','configure','pair','pair-code','revoke','manager-connect','manager-pair-code','manager-revoke','member-remove','draft-pick','import','scan','action','received','read','archive-spec','archive-finish','archive-reopen','asset-pick','asset-drop','asset-upload','assets','history','recover','backup','export-report','product-groups','product-group-update','product-variant-move','open-requirement','open-asset','copy','preferences','pick-root','test-notification','duplicate-inspect','duplicate-repair','task-asset-location','calibrate-contribution','asset-replan','work-policy-save','work-calendar-preview']);
async function handle(command,payload){
 if(!COMMANDS.has(command))throw Error('不支持的操作');
 if(command==='snapshot')return refresh();
 if(command==='test-notification'){
  if(role!=='designer')throw Error('请在设计端测试通知');if(!Notification.isSupported())throw Error('这台电脑暂不支持系统通知');
  notifyTask({id:'notification-test',title:'通知测试：工作台提醒已启用',items:[{points:0}]});return {sent:true};
 }
 if(command==='manager-connect'){
  if(role!=='manager')throw Error('仅负责人端支持管理连接');
  if(service?.nas?.lease)throw Error('本机正在运行 NAS 主服务，不能切换为连接端');
  let decoded;try{decoded=decodeCode(String(payload.code||'').trim())}catch{throw Error('连接码格式不完整，请从原主机重新复制完整的 DW1. 管理连接码')}
  const next=new Client(decoded);let connection;
  try{connection=await next.pair()}catch(e){throw Error('连接 '+decoded.host+':'+decoded.port+' 失败：'+e.message+'。请检查主机是否运行、连接码是否有效及两台电脑间的网络连通性')}
  if(connection.role!=='manager')throw Error('此码不是管理连接码，请在原主机的多电脑管理中重新生成');
  try{await next.rpc('snapshot')}catch(e){throw Error('已绑定但读取主机任务失败：'+e.message)}
  const previous=settings;settings={...settings,remoteManager:true,connection,cachedSnapshot:null};
  try{await save()}catch(e){settings=previous;throw Error('管理绑定成功，但保存本机连接失败：'+e.message+'。请重新生成连接码后重试')}
  if(service){try{await service.stop();service=null}catch(e){throw Error('连接已保存，但停止本机旧服务失败，请退出后重新打开软件：'+e.message)}}
  client?.close();currentSnapshot=null;connectClient();const snapshot=await refresh();if(!snapshot.connection?.online)throw Error('连接已保存，但读取任务失败：'+snapshot.connection?.error);return snapshot;
 }
 if(command==='configure'){if(settings.remoteManager)throw Error('NAS 连接由负责人主机维护');
  if(role!=='manager')throw Error('仅负责人可以配置 NAS');
  if(typeof payload.taskRoot!=='string'||typeof payload.assetRoot!=='string'||!path.isAbsolute(payload.taskRoot)||!path.isAbsolute(payload.assetRoot))throw Error('请输入完整的 NAS 路径');
  const key=crypto.createHash('sha256').update(path.resolve(payload.taskRoot).toLowerCase()+'|'+path.resolve(payload.assetRoot).toLowerCase()).digest('hex').slice(0,20);
  if(key!==settings.workspace){
   if(service)await service.stop();settings.workspace=key;await save();await openService();
  }
  const result=await invoke('configure',payload);await refresh();return result;
 }
 if(command==='pair'){
  if(role!=='designer')throw Error('负责人端无需绑定');
  const next=new Client(decodeCode(payload.code));const connection=await next.pair();if(connection.role==='manager')throw Error('请在负责人端使用管理连接码');client?.close();settings.connection=connection;settings.seenNotifications=[];settings.cachedSnapshot=null;await save();connectClient();return refresh();
 }
  if(command==='draft-pick'){
  if(role!=='manager')throw Error('仅负责人可以导入需求');
  const result=await dialog.showOpenDialog(win,{title:'上传需求表',properties:['openFile'],filters:[{name:'公司需求表',extensions:['xlsx']}]});if(result.canceled)return null;
  const file=result.filePaths[0];if((await fsp.stat(file)).size>50*1024*1024)throw Error('需求表不能超过 50 MB');
   return invoke('draft',{filename:path.basename(file),...(settings.remoteManager?{bytesBase64:(await fsp.readFile(file)).toString('base64')}:{bytes:await fsp.readFile(file)})});
  }
  if(command==='export-report'){
   if(role!=='manager')throw Error('仅负责人可以导出分析数据');
   if(!service&&!client)throw Error('负责人数据服务尚未启动');
   const range=periodRange(payload.frequency,payload.anchor),generatedAt=Date.now(),cutoff=Math.min(generatedAt,range.end-1),remote=settings.remoteManager?await invoke('report-data',payload):null,history=remote||service.store.reportTasks(cutoff);
   const report=createReport(history.tasks,remote?remote.events:service.store.reportEvents(range.start,Math.min(range.end,generatedAt+1)),{frequency:payload.frequency,anchor:payload.anchor,generatedAt:remote?.generatedAt||generatedAt,unavailable:history.unavailable,workPolicies:remote?remote.workPolicies||{}:service.store.get('setting','workPolicies')||{},removedPeople:remote?remote.removedPeople||[]:service.store.removedMembers()});
   const filename='设计协作数据-'+report.range.fileKey+'.zip';
   const saveResult=await dialog.showSaveDialog(win,{title:'导出分析包',defaultPath:path.join(app.getPath('documents'),filename),filters:[{name:'分析包（Excel、JSON、提示词与校验脚本）',extensions:['zip']}]});
   if(saveResult.canceled||!saveResult.filePath)return null;
   await fsp.writeFile(saveResult.filePath,report.bundleBytes,{flag:'w'});
   return {path:saveResult.filePath,label:report.range.label,counts:report.counts};
  }
 if(command==='asset-pick'||command==='asset-replan')return selectFiles(payload);
 if(command==='asset-drop'){if(!Array.isArray(payload.paths))throw Error('请拖入交付文件夹');return selectFiles(payload)}
 if(command==='asset-upload')return upload(payload);
 if(command==='open-requirement'){
  const location=await invoke('requirement-location',{taskId:payload.taskId});
  const error=await shell.openPath(location.path);if(error)throw Error('本机无法打开 NAS 原表，请先在文件资源管理器中连接共享盘：'+error);
  if(role==='designer')await invoke('read',{taskId:location.taskId,assignmentId:location.assignmentId});
  return {opened:true};
 }
 if(command==='task-asset-location'){
  const result=await invoke(command,payload);const error=await shell.openPath(result.path);if(error)throw Error('无法打开产品目录，请检查本机 NAS 访问权限');return {opened:true};
 }
 if(command==='open-asset'){
  const assets=await invoke('assets'),asset=assets.find(a=>a.id===payload.assetId);if(!asset)throw Error('资产不存在');
  const error=await shell.openPath(asset.path);if(error)throw Error('无法打开 NAS 目录，请检查本机共享盘访问权限');return {opened:true};
 }
 if(command==='copy'){if(typeof payload.text!=='string'||payload.text.length>16000)throw Error('复制内容无效');clipboard.writeText(payload.text);return {copied:true}}
 if(command==='preferences'){
  if(typeof payload.autostart==='boolean')app.setLoginItemSettings({openAtLogin:payload.autostart,path:process.env.PORTABLE_EXECUTABLE_FILE||process.execPath});
  if(typeof payload.mute==='boolean')settings.mute=payload.mute;await save();return refresh();
 }
 if(command==='pick-root'){
  if(role!=='manager')throw Error('仅负责人可以配置 NAS');const result=await dialog.showOpenDialog(win,{title:'选择 NAS 文件夹',properties:['openDirectory']});return result.canceled?null:result.filePaths[0];
 }
 return invoke(command,payload);
}
async function finishSmoke(error){
 if(!smoke||smokeFinished)return;smokeFinished=true;if(error)report.errors.push(String(error));report.passed=report.loaded&&report.rendererReady&&!report.errors.length;
 if(report.passed)try{const screenshot=path.join(path.dirname(smokeOutput),'window.png');await fsp.writeFile(screenshot,(await win.webContents.capturePage()).toPNG());report.screenshot=screenshot}catch(e){report.errors.push('Screenshot: '+e.message);report.passed=false}
 await fsp.mkdir(path.dirname(smokeOutput),{recursive:true});await fsp.writeFile(smokeOutput,JSON.stringify(report,null,2));quitting=true;client?.close();await service?.stop();app.exit(report.passed?0:1);
}
async function quit(){
 if(uploading){await dialog.showMessageBox(win,{message:'文件正在上传，请等待封存结果后再退出。',type:'info'});return}
 if(role==='manager'&&!smoke){const result=await dialog.showMessageBox(win,{type:'question',message:'退出后，设计端将暂时无法同步任务。',detail:'只需关闭窗口即可保持后台服务在线。',buttons:['留在后台','退出软件'],defaultId:0,cancelId:0});if(result.response===0){win.hide();return}}
 quitting=true;client?.close();await service?.stop();await saveQueue.catch(()=>{});app.quit();
}
if(!smoke&&!app.requestSingleInstanceLock())app.quit();
else{
 app.on('second-instance',show);
 app.whenReady().then(async()=>{
  await load();
  win=new BrowserWindow({width:1360,height:940,minWidth:820,minHeight:640,show:false,title:name+' · Design by Mason Zeng',icon:iconFile,backgroundColor:'#f5f5f7',frame:false,titleBarStyle:'hidden',webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,spellcheck:false,webSecurity:true}});
  require('../core/window-chrome.cjs')(win,ipcMain);
  session.defaultSession.setPermissionRequestHandler((_w,_p,callback)=>callback(false));session.defaultSession.setPermissionCheckHandler(()=>false);
  const allowed=new Set(['index.html','app.js','style.css','bridge.js','calendar.js','chrome.js','vendor/lucide.min.js'].map(f=>pathToFileURL(path.join(appDir,'ui',f)).href));for(const icon of ['icon.png','icon-manager.png','icon-designer.png'])allowed.add(pathToFileURL(path.join(appDir,'assets',icon)).href);
  session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!allowed.has(details.url)}));
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',(e,url)=>{if(url!==appURL)e.preventDefault()});win.webContents.on('will-attach-webview',e=>e.preventDefault());
  ipcMain.handle('workbench:call',async(event,command,payload)=>{if(event.sender!==win.webContents||event.senderFrame!==win.webContents.mainFrame||event.senderFrame.url!==appURL)throw Error('无效来源');try{return {ok:true,value:await handle(command,payload||{})}}catch(e){return {ok:false,error:e.reasons?.join('；')||e.message}}});
  ipcMain.on('workbench:ready',event=>{if(event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&event.senderFrame.url===appURL){report.rendererReady=true;if(smoke&&report.loaded)setTimeout(()=>finishSmoke(),500)}});
  win.webContents.on('did-finish-load',()=>{report.loaded=true;if(smoke&&report.rendererReady)setTimeout(()=>finishSmoke(),500)});
  win.webContents.on('did-fail-load',(_e,code,description)=>finishSmoke(code+': '+description));
  win.webContents.on('console-message',(_e,details)=>{if(smoke&&details.level==='error')report.errors.push(details.message)});
  win.webContents.on('render-process-gone',(_e,details)=>finishSmoke(details.reason));
  try{if(role==='manager'&&!settings.remoteManager)await openService();else if(settings.connection)connectClient()}catch(e){connectionError=e.message;online=false}
  Menu.setApplicationMenu(null);
  if(!smoke){tray=new Tray(nativeImage.createFromPath(iconFile).resize({width:20,height:20}));tray.setToolTip(name);tray.setContextMenu(Menu.buildFromTemplate([{label:'打开工作台',click:show},{label:'退出软件',click:()=>quit()}]));tray.on('double-click',show)}
  win.on('close',event=>{if(!quitting&&tray){event.preventDefault();win.hide()}});win.once('ready-to-show',()=>{if(!smoke)show()});
  if(smoke)setTimeout(()=>finishSmoke('Startup timeout'),25000);await win.loadFile(uiFile);
 }).catch(e=>{if(smoke)finishSmoke(e.stack);else{dialog.showErrorBox('工作台启动失败',e.message);app.quit()}});
 app.on('window-all-closed',()=>{if(quitting||!tray)app.quit()});app.on('before-quit',()=>{quitting=true});
}
