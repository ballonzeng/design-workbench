'use strict';
// Exercise shipped renderer/preload against six explicitly confirmed historical fixtures.
// This process uses only an isolated local database; it never starts a NAS service.
const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Service}=require('../core/service.cjs'),{prepareHistoricalTasks}=require('../core/historical-tasks.cjs');
const rows=[
 {owner:'jiang',product:'蓝山味黑咖啡',qty:3,completedDate:'2026-10-13'},
 {owner:'jiang',product:'西洋参黄芪党参桂圆茶',qty:2,completedDate:'2026-10-15'},
 {owner:'qiu',product:'九制黄精',qty:2,completedDate:'2026-10-15'},
 {owner:'qiu',product:'ag氨基酸云感洁面',qty:2,completedDate:'2026-10-30'},
 {owner:'lv',product:'协和花阿胶膏500g',qty:2,completedDate:'2026-10-19'},
 {owner:'lv',product:'人参黄精肉苁蓉枸杞原浆饮',qty:1,completedDate:'2026-10-16'}
];
const out=path.resolve('outputs/historical-ui-'+Date.now()),november=Date.parse('2026-11-03T10:00:00+08:00');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.on('window-all-closed',()=>{});
process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),results=[],errors=[],calls=[],openedLocations=[];
let win,service,clientRole='manager',nasTouches=0;
const actor=()=>clientRole==='manager'?{role:'manager',personId:'zeng'}:{role:'designer',personId:'jiang'};
const snapshot=()=>({...service.snapshot(actor()),serverTime:november,version:require('../package.json').version,connection:{online:true},nasStatus:{connected:false},addresses:[]});
const evaluate=code=>win.webContents.executeJavaScript(code);
async function until(check,message){const end=Date.now()+7000;while(Date.now()<end){if(await check())return;await wait(40)}throw Error(message)}
async function click(selector){await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.click()})()`);await wait(50)}
async function cardCount(count){await until(()=>evaluate(`document.querySelectorAll('.review-tasks .task-card[data-review-task]').length===${count}`),'expected '+count+' historical cards')}
async function audit(label){
 for(const [width,height]of [[1360,900],[1024,650],[820,640]]){
  win.setSize(width,height);await wait(100);
  const metrics=await evaluate(`(()=>{const r=document.documentElement,m=document.querySelector('main'),s=document.querySelector('dialog[open]'),b=s?.querySelector('#sheet-body,.calendar-content');return {width:innerWidth,height:innerHeight,doc:r.scrollWidth,rootHeight:r.scrollHeight,rootClient:r.clientHeight,main:m.scrollWidth,mainClient:m.clientWidth,sheet:s?{top:s.getBoundingClientRect().top,bottom:s.getBoundingClientRect().bottom,width:b?.clientWidth,scroll:b?.scrollWidth}:null}})()`);
  assert(metrics.doc<=metrics.width+1,label+' document horizontal overflow');assert(metrics.main<=metrics.mainClient+1,label+' main horizontal overflow');assert(metrics.rootHeight<=metrics.rootClient+1,label+' document vertical scroll');
  if(metrics.sheet){assert(metrics.sheet.top>=42&&metrics.sheet.bottom<=height+1,label+' sheet bounds');assert(metrics.sheet.scroll<=metrics.sheet.width+1,label+' sheet horizontal overflow')}
  results.push({check:label,...metrics});
  if(width!==1024)fs.writeFileSync(path.join(out,label+'-'+width+'.png'),(await win.capturePage()).toPNG());
 }
 win.setSize(1360,900);await wait(70);
}
async function makeWindow(){
 win=new BrowserWindow({show:false,width:1360,height:900,frame:false,backgroundColor:'#f5f5f7',webPreferences:{preload:path.resolve('desktop/preload.cjs'),contextIsolation:true,sandbox:true}});
 ipcMain.removeHandler('window-chrome');require('../core/window-chrome.cjs')(win,ipcMain);
 win.webContents.on('console-message',(_e,d)=>{if(d.level==='error'&&!d.message.includes('favicon'))errors.push(d.message)});
 await win.loadFile(path.resolve('ui/index.html'));await until(()=>evaluate(`!!document.querySelector('[data-view="tasks"]')`),'renderer did not load');
}
app.whenReady().then(async()=>{
 service=new Service(path.join(out,'db'));
 const prepared=prepareHistoricalTasks(rows,{now:november,actor:'zeng',source:'user-request-2026-11-03'});
 assert.equal(prepared.summary.totalPoints,48);assert.equal(prepared.summary.totalQty,12);
 for(const task of prepared.records){service.store.put('historicalTask',task.id,task);service.store.event('historical-supplemented','zeng',task.id,{completedDate:task.completedDate})}
 const historicalBefore=service.store.all('historicalTask');
 const forbidden=async()=>{nasTouches++;throw Error('Historical-only validation attempted NAS access')};
 service.ensureNasConnection=forbidden;service.nas.ready=forbidden;service.nas.productDirectory=forbidden;service.nas.readTask=forbidden;service.requirementsSync={check:forbidden};
 ipcMain.handle('workbench:call',async(_e,command,payload={})=>{calls.push({command,payload});try{
  if(command==='snapshot')return {ok:true,value:snapshot()};
  if(command==='task-asset-location'){
   const task=service.store.historicalTasks().find(task=>task.id===payload.taskId);assert(task?.historicalArchive,'location click requires validated archive metadata');
   openedLocations.push(task.historicalArchive.productPath);return {ok:true,value:{opened:true,path:task.historicalArchive.productPath}};
  }
  if(!['task-review','history','task-review-exclude','task-review-restore'].includes(command))throw Error('Unexpected UI operation '+command);
  return {ok:true,value:await service.call(actor(),command,payload)};
 }catch(error){return {ok:false,error:error.message}}});
 await makeWindow();
 const overview=await evaluate(`[...document.querySelectorAll('.overview-number')].map(e=>e.textContent)`);assert.match(overview[0],/^0/);assert.match(overview[1],/^0/);results.push({check:'no fabricated in-hand work',overview});
 await click('[data-view="tasks"]');await until(()=>evaluate(`document.querySelectorAll('.tasks-grid .task-card').length===6`),'historical tasks missing from manager task list');
 await click('[data-filter="unsealed"]');assert.equal(await evaluate(`document.querySelectorAll('.tasks-grid .task-card').length`),0,'unrecorded archiving shown as pending');
 await click('[data-view="review"]');await cardCount(6);
 assert.deepEqual(await evaluate(`[...document.querySelectorAll('.review-metric strong')].map(e=>e.textContent)`),['6','48','0','0']);
 for(const [person,points]of [['jiang',20],['qiu',16],['lv',12]]){
  const text=await evaluate(`document.querySelector('.review-person-card[data-person="${person}"]').textContent`);assert.match(text,new RegExp(points+'\\s*点'));results.push({check:'historical person points',person,points});
 }
 for(const task of prepared.records){
  const card=await evaluate(`document.querySelector('[data-review-task="${task.id}"]').textContent`);assert(card.includes(task.completedDate));assert.match(card,/历史补录/);assert.match(card,/未记录时刻/);assert.doesNotMatch(card,/00:00|0 分钟|0分钟|待封存/);
 }
 await audit('historical-overview');
 await evaluate(`document.querySelector('.review-tasks').scrollIntoView({block:'start',behavior:'instant'})`);await audit('historical-cards');
 const selected=prepared.records[0];await click('[data-review-task="'+selected.id+'"] [data-command="task-detail"]');await until(()=>evaluate(`document.querySelector('#sheet').open`),'historical detail did not open');
 const detail=await evaluate(`document.querySelector('#sheet-body').textContent`);assert(detail.includes(selected.completedDate));assert.match(detail,/实际设计耗时\s*未记录/);assert.doesNotMatch(detail,/00:00|0 分钟|0分钟/);
 for(const command of ['open-requirement','calibration-open','archive-reopen','manager-archive-open','seal-open','task-asset-location'])assert.equal(await evaluate(`document.querySelector('#sheet [data-command="${command}"]')`),null,'historical detail exposes unsupported '+command);
 await audit('historical-detail');await click('[data-command="close-sheet"]');
 await click('[data-review-task="'+selected.id+'"] [data-command="review-exclude-open"]');await click('[data-command="review-exclude-confirm"]');await cardCount(5);
 assert.equal(service.store.all('reviewExclusion').length,1);assert.deepEqual(await evaluate(`[...document.querySelectorAll('.review-metric strong')].map(e=>e.textContent)`),['5','36','0','0']);
 await click('.review-exclusions summary');await click('[data-command="review-restore"][data-task="'+selected.id+'"]');await cardCount(6);assert.equal(service.store.all('reviewExclusion').length,0);assert.deepEqual(service.store.all('historicalTask'),historicalBefore);results.push({check:'historical exclude and restore',pointsBefore:48,pointsExcluded:36,pointsRestored:48});
 const history=await service.call(actor(),'history',{taskId:selected.id});assert.equal(history.filter(event=>event.kind==='historical-supplemented').length,1);
 for(const command of ['requirement-location','action','archive-spec','archive-finish','task-asset-location','calibrate-contribution'])await assert.rejects(service.call(actor(),command,{taskId:selected.id,version:1,action:'start'}),/历史补录/);
 results.push({check:'historical guard and audit',nasTouches});
 assert.equal(nasTouches,0);assert.equal(service.store.all('task').length,0);assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM task_versions').get().n,0);
 // Decorate the immutable completion records with separate, structurally validated
 // archive records. These are fixture paths only; no files are copied or opened.
 const archivedAt=november+90*60000;
 for(const task of prepared.records){
  const productPath=path.join(out,'fake-archive','待69码定位',task.id),deliveryPath=path.join(productPath,'07.包装设计');
  const archive={id:'test-archive-'+task.id,taskId:task.id,author:task.owner,category:'packaging',status:'archived',identification:'pending-code',path:deliveryPath,productPath,at:archivedAt,files:[{path:path.join(deliveryPath,'01.源文件','包装设计.psd'),name:'包装设计.psd',size:128,sha256:'a'.repeat(64)}]};
  service.store.put('historicalArchive',task.id,archive);
 }
 const decorated=service.store.historicalTasks();assert.equal(decorated.filter(task=>task.historicalArchive).length,6);assert.deepEqual(service.store.all('historicalTask'),historicalBefore);
 win.webContents.send('workbench:change',snapshot());
 await until(()=>evaluate(`document.querySelectorAll('.review-metric strong')[2]?.textContent==='6'`),'physical archive metric did not refresh');await cardCount(6);
 assert.deepEqual(await evaluate(`[...document.querySelectorAll('.review-metric strong')].map(e=>e.textContent)`),['6','48','6','0']);
 for(const task of prepared.records){const card=await evaluate(`document.querySelector('[data-review-task="${task.id}"]').textContent`);assert.match(card,/已封存.*待69码定位/);assert(card.includes(task.completedDate));assert.doesNotMatch(card,/00:00|0 分钟|0分钟|待封存/)}
 await audit('archived-historical-overview');await evaluate(`document.querySelector('.review-tasks').scrollIntoView({block:'start',behavior:'instant'})`);await audit('archived-historical-cards');
 await click('[data-review-task="'+selected.id+'"] [data-command="task-detail"]');await until(()=>evaluate(`document.querySelector('#sheet').open`),'archived historical detail missing');
 const field=label=>evaluate(`(()=>{const e=[...document.querySelectorAll('#sheet-body .summary-line')].find(e=>e.querySelector('dt')?.textContent===${JSON.stringify(label)});return e?.querySelector('dd').textContent})()`);
 assert.equal(await field('完成日期'),selected.completedDate+'（未记录时刻）');assert.match(await field('封存情况'),/已封存.*待69码定位/);assert.match(await field('封存时间'),/2026\/11\/03.*11:30/);
 const selectedArchive=service.store.get('historicalArchive',selected.id);assert.equal(await field('文件位置'),selectedArchive.productPath);assert.equal(await field('实际设计耗时'),'未记录');
 for(const command of ['open-requirement','calibration-open','archive-reopen','manager-archive-open','seal-open'])assert.equal(await evaluate(`document.querySelector('#sheet [data-command="${command}"]')`),null,'archived historical detail exposes unsupported '+command);
 await audit('archived-historical-detail');
 for(const [width,height]of [[1360,900],[820,640]]){win.setSize(width,height);await wait(100);await evaluate(`document.querySelector('#sheet-body').scrollTop=document.querySelector('#sheet-body').scrollHeight`);await wait(60);fs.writeFileSync(path.join(out,'archive-location-detail-'+width+'.png'),(await win.capturePage()).toPNG())}
 win.setSize(1360,900);await wait(70);await click('#sheet [data-command="task-asset-location"]');await until(()=>openedLocations.length===1,'archive location action not invoked');assert.equal(openedLocations[0],selectedArchive.productPath);assert.notEqual(openedLocations[0],selectedArchive.path);await click('[data-command="close-sheet"]');
 await evaluate(`(()=>{const e=document.querySelector('#review-state');e.value='sealed';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);await cardCount(6);
 await evaluate(`(()=>{const e=document.querySelector('#review-basis');e.value='sealed';e.dispatchEvent(new Event('change',{bubbles:true}))})()`);await cardCount(0);
 await click('[data-command="review-preset"][data-preset="current"]');await cardCount(6);assert.equal(await evaluate(`document.querySelectorAll('.review-metric strong')[2].textContent`),'6');
 assert(await evaluate(`document.querySelector('.review-tasks .task-timing').textContent.includes('2026/11/03')`),'archive date must be November, not completion month');
 assert.equal(nasTouches,0);assert.deepEqual(service.store.all('historicalTask'),historicalBefore);assert.equal(service.store.all('task').length,0);assert.equal(service.store.db.prepare('SELECT COUNT(*) AS n FROM task_versions').get().n,0);
 results.push({check:'verified physical archives preserve completion dates and open outer product directory',archivedRecords:6,octoberPoints:48,sealedCount:6,openedLocations,archiveTime:new Date(archivedAt).toISOString(),nasTouches});
 win.destroy();clientRole='designer';await makeWindow();assert.equal(await evaluate(`document.querySelector('[data-view="review"]')`),null);assert.equal(await evaluate(`document.querySelectorAll('.task-card').length`),0);assert.equal(service.snapshot(actor()).tasks.length,0);results.push({check:'designer receives no manager-only historical records'});
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,records:6,points:48,personPoints:{jiang:20,qiu:16,lv:12},results,calls,errors,nasTouches,openedLocations},null,2));console.log(JSON.stringify({passed:true,out,checks:results.length}));win.destroy();service.store.close();app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(out,'error.txt'),error.stack||String(error));console.error(error.stack||String(error));if(win&&!win.isDestroyed())win.capturePage().then(image=>fs.writeFileSync(path.join(out,'failure.png'),image.toPNG())).finally(()=>app.exit(1));else app.exit(1)});
