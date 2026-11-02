'use strict';
// Real renderer + preload IPC, backed by a private fixture database. No NAS connection.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Service}=require('../core/service.cjs'),R=require('../core/rules.cjs');
const out=path.resolve('outputs/task-review-ui-'+Date.now());
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.on('window-all-closed',()=>{});
process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),TZ=8*3600000;
const current=new Date(Date.now()+TZ),year=current.getUTCFullYear(),month=current.getUTCMonth();
const local=(offset,day=1,hour=12,minute=0)=>Date.UTC(year,month+offset,day,hour,minute)-TZ;
const dayKey=at=>new Date(at+TZ).toISOString().slice(0,10),previousMonth=dayKey(local(-1)).slice(0,7),currentMonth=dayKey(local(0)).slice(0,7);
const actor={role:'manager',personId:'zeng'},results=[],errors=[],queries=[];
let service,win,failNext=false,holdNext=false,heldResolve,active=0,clientRole='manager';
const currentActor=()=>clientRole==='manager'?actor:{role:'designer',personId:'hong'};
const snapshot=()=>({...service.snapshot(currentActor()),version:require('../package.json').version,connection:{online:true},nasStatus:{connected:false},addresses:[]});
function task(id,overrides={}){
 return {id,state:4,sealed:false,owner:'hong',title:'上月主图',product:'示例产品',brand:'测试品牌',code:'6970855224163',operator:'测试运营',filename:id+'.xlsx',items:[{id:'row-6',row:6,type:'basic',typeName:'单图任务',qty:2,points:4}],version:1,createdAt:local(-2),requestedAt:local(-1,2),assignedAt:local(-1,3),startedAt:local(-1,4),reviewAt:local(-1,5,11),completedAt:local(-1,5),completedMonth:previousMonth,updatedAt:local(0),elapsedMs:3600000,runningSince:null,...overrides};
}
async function evaluate(code){return win.webContents.executeJavaScript(code)}
async function until(fn,message){const end=Date.now()+7000;while(Date.now()<end){if(await fn())return;await wait(40)}throw Error(message)}
async function click(selector){await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.click()})()`);await wait(40)}
async function select(selector,value){await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing select');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`);await wait(40)}
async function rowIds(){return evaluate(`[...document.querySelectorAll('.review-tasks .task-card[data-review-task]')].map(e=>e.dataset.reviewTask).sort()`)}
async function rows(expected,label){await until(async()=>JSON.stringify(await rowIds())===JSON.stringify([...expected].sort()),label+' unexpected rows');results.push({check:label,rows:await rowIds()})}
async function calendar(which,date){await click('[data-calendar="'+which+'"]');await until(()=>evaluate(`!!document.querySelector('.date-picker[open]')`),'calendar did not open');await click('.date-picker [data-date="'+date+'"]');await until(()=>evaluate(`!document.querySelector('.date-picker[open]')`),'calendar did not close')}
async function audit(label){
 for(const [width,height] of [[1360,900],[1024,650],[820,640]]){
  win.setSize(width,height);await wait(120);
  const metrics=await evaluate(`(()=>{const main=document.querySelector('main'),root=document.documentElement,controls=document.querySelector('.window-controls'),r=controls.getBoundingClientRect(),open=document.querySelector('dialog[open]'),body=open?.querySelector('#sheet-body,.calendar-content');return {width:innerWidth,height:innerHeight,doc:root.scrollWidth,rootHeight:root.scrollHeight,rootClient:root.clientHeight,main:main.scrollWidth,mainWidth:main.clientWidth,controls:{top:r.top,right:r.right,width:r.width},dialog:open?{top:open.getBoundingClientRect().top,bottom:open.getBoundingClientRect().bottom,width:body?.clientWidth,scroll:body?.scrollWidth}:null}})()`);
  assert(metrics.doc<=metrics.width+1,label+' document horizontal overflow '+JSON.stringify(metrics));
  assert(metrics.main<=metrics.mainWidth+1,label+' main horizontal overflow '+JSON.stringify(metrics));
  assert(metrics.rootHeight<=metrics.rootClient+1,label+' document vertical scroll');
  assert.equal(metrics.controls.top,0,label+' window controls top');assert(metrics.controls.right<=metrics.width+1,label+' controls right');
  if(metrics.dialog){assert(metrics.dialog.top>=42&&metrics.dialog.bottom<=metrics.height+1,label+' dialog bounds');assert(metrics.dialog.scroll<=metrics.dialog.width+1,label+' dialog body overflow')}
  results.push({check:label,...metrics});
  if(['exclude-dialog','excluded-tasks'].includes(label)&&width!==1024)fs.writeFileSync(path.join(out,label+'-'+width+'.png'),(await win.capturePage()).toPNG());
 }
 win.setSize(1360,900);await wait(100);fs.writeFileSync(path.join(out,label+'.png'),(await win.capturePage()).toPNG());
}
app.whenReady().then(async()=>{
 service=new Service(path.join(out,'db'));
 const fixtures=[
  task('prev-sealed',{sealed:true,sealedAt:local(-1,6)}),
  task('prev-pending',{owner:'chang',title:'上月SKU',completedAt:local(0,1,0)-1,items:[{id:'row-6',row:6,type:'basic',typeName:'单图任务',qty:3,points:2.4}]}),
  task('removed-task',{owner:'lv',title:'已移除成员任务',items:[{id:'row-6',row:6,type:'basic',typeName:'单图任务',qty:1,points:999}]}),
  task('prev-estimated',{title:'上月详情页',completedAt:local(-1,10),completionFromFolder:true,completionTimeSource:'file-estimate'}),
  task('cross-month',{title:'跨月主图',completedAt:local(0,1),completedMonth:currentMonth}),
  task('current-only',{title:'本月主图',requestedAt:local(0,1,9),assignedAt:local(0,1,10),completedAt:local(0,1),completedMonth:currentMonth}),
  task('missing-date',{owner:'chang',title:'缺少确认日期',completedAt:null,completedMonth:null}),
  task('old-task',{title:'更早任务',requestedAt:local(-2,2),assignedAt:local(-2,3),completedAt:local(-2,5),completedMonth:dayKey(local(-2)).slice(0,7)})
 ];
 for(const t of fixtures)service.store.put('task',t.id,t);
 service.store.put('removedMember','lv',{at:local(0),by:'zeng'});
 const before=service.store.db.prepare('SELECT total_changes() AS n').get().n;
 ipcMain.handle('workbench:call',async(_event,command,payload={})=>{
  try{
   if(command==='snapshot')return {ok:true,value:snapshot()};
   if(command==='task-review'){
    active++;queries.push(structuredClone(payload));
    try{
     const value=await service.call(actor,command,payload);
     if(holdNext){holdNext=false;await new Promise(resolve=>heldResolve=resolve)}
     if(failNext){failNext=false;return {ok:false,error:'测试连接失败，请重试'}}
     return {ok:true,value};
    }finally{active--}
   }
   if(['task-review-exclude','task-review-restore'].includes(command))return {ok:true,value:await service.call(actor,command,payload)};
   if(command==='history')return {ok:true,value:[]};
   throw Error('Unexpected operation during read-only review: '+command);
  }catch(e){return {ok:false,error:e.message}}
 });
 win=new BrowserWindow({show:false,width:1360,height:900,frame:false,backgroundColor:'#f5f5f7',webPreferences:{preload:path.resolve('desktop/preload.cjs'),contextIsolation:true,sandbox:true}});
 require('../core/window-chrome.cjs')(win,ipcMain);
 win.webContents.on('console-message',(_e,d)=>{if(d.level==='error'&&!d.message.includes('favicon'))errors.push(d.message)});
 await win.loadFile(path.resolve('ui/index.html'));
 await until(()=>evaluate(`!!document.querySelector('[data-view="review"]')`),'review navigation missing');
 await click('[data-view="review"]');
 await rows(['prev-sealed','prev-pending','prev-estimated'],'default previous month');
 assert.equal(await evaluate(`document.querySelector('#review-basis').value`),'completed');
 assert(await evaluate(`document.querySelector('.task-review').textContent.includes(${JSON.stringify(previousMonth.slice(0,4))})`),'history year not displayed');
 assert(await evaluate(`!!document.querySelector('#review-results-status[aria-live]')`),'results status must announce changes');
 assert(await evaluate(`document.querySelector('.task-review').textContent.includes('推定')`),'inferred time note missing');
 assert(await evaluate(`document.querySelector('.task-review').textContent.includes('缺少')`),'missing time note missing');
 assert.equal(await evaluate(`document.querySelector('.review-table')`),null,'review details must use cards, not table');
 assert(await evaluate(`[...document.querySelectorAll('.review-tasks .task-card')].every(c=>c.querySelector('.task-top')&&c.querySelector('.task-content')&&c.querySelector('.task-footer')&&c.querySelector('.point-display')&&c.querySelector('.task-title'))`),'review cards must retain existing task-card structure');
 assert(await evaluate(`document.querySelector('[data-review-task="prev-pending"]').textContent.includes('2.4')&&document.querySelector('[data-review-task="prev-pending"]').textContent.includes('单图任务')`),'card must show points and contribution items');
 assert(await evaluate(`document.querySelector('[data-review-task="prev-pending"]').textContent.includes('运营确认完成时间')`),'card must show selected timestamp basis');
 assert(await evaluate(`[...document.querySelectorAll('.review-tasks .task-footer [data-command]')].every(e=>['task-detail','task-asset-location','review-exclude-open'].includes(e.dataset.command))`),'review cards must not expose workflow mutation actions');
 results.push({check:'existing task cards preserve points, items, timestamps and detail links'});
 await audit('previous-month');
 assert.equal(await evaluate(`document.querySelector('#review-person option[value="lv"]')`),null,'removed member must not appear in personnel filter');
 assert.equal(await evaluate(`document.querySelector('.review-person-card[data-person="lv"]')`),null,'removed member must not appear in personnel totals');
 assert.deepEqual((await service.call(actor,'task-review',{personId:'lv',frequency:'month',anchor:previousMonth})).tasks,[],'direct query must not return removed member tasks');
 assert.equal(await evaluate(`document.querySelector('.review-metric:nth-child(2) strong').textContent`),'10.4','removed member points leaked into total');
 assert.equal(service.store.get('task','removed-task').items[0].points,999,'excluding removed members must preserve original task');
 results.push({check:'removed members excluded from options, tasks and totals'});
 await select('#review-person','chang');await rows(['prev-pending'],'active member history');
 await select('#review-person','');await select('#review-state','sealed');await rows(['prev-sealed'],'current sealed filter');
 await select('#review-state','unsealed');await rows(['prev-pending','prev-estimated'],'current pending archive filter');
 await select('#review-state','all');await select('#review-basis','requested');
 await rows(['prev-sealed','prev-pending','prev-estimated','cross-month','missing-date'],'requested date includes cross-month work');
 await select('#review-basis','sealed');await rows(['prev-sealed'],'archive timestamp');
 await select('#review-basis','completed');
 await click('[data-command="review-preset"][data-preset="current"]');await rows(['cross-month','current-only'],'current month');
 await click('[data-command="review-preset"][data-preset="previous"]');await rows(['prev-sealed','prev-pending','prev-estimated'],'previous month shortcut');
 await click('[data-command="review-shift"][data-step="-1"]');await rows(['old-task'],'month backward');
 await click('[data-command="review-shift"][data-step="1"]');await rows(['prev-sealed','prev-pending','prev-estimated'],'month forward');
 await click('[data-calendar="review-anchor"]');await audit('month-picker');await click('.date-picker [data-close]');
 await click('[data-command="review-period"][data-period="custom"]');
 await calendar('review-start',dayKey(local(-1,5)));await calendar('review-end',dayKey(local(-1,5)));
 await rows(['prev-sealed'],'custom same-day inclusive');
 await click('[data-command="review-period"][data-period="day"]');await calendar('review-anchor',dayKey(local(-1,5)));
 await rows(['prev-sealed'],'single day');
 await click('[data-command="review-period"][data-period="week"]');
 const weekday=new Date(local(-1,5)+TZ).getUTCDay(),weekStart=local(-1,5,0)-((weekday+6)%7)*86400000;
 await rows(fixtures.filter(t=>t.owner!=='lv'&&Number.isFinite(t.completedAt)&&t.completedAt>=weekStart&&t.completedAt<weekStart+7*86400000).map(t=>t.id),'Monday to Sunday week');
 await click('[data-command="review-preset"][data-preset="previous"]');await rows(['prev-sealed','prev-pending','prev-estimated'],'reset before search');
 const q=queries.length;
 await evaluate(`(()=>{const e=document.querySelector('#review-search');e.focus();e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));e.value='主';e.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'主'}))})()`);
 await wait(300);assert.equal(queries.length,q,'Chinese composition triggered premature query');
 assert(await evaluate(`document.activeElement===document.querySelector('#review-search')&&document.querySelector('#review-search').value==='主'`),'Chinese composition focus lost');
 await evaluate(`(()=>{const e=document.querySelector('#review-search');e.value='主图';e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'主图'}))})()`);
 await rows(['prev-sealed'],'Chinese search commits once');
 await click('.review-tasks .task-title[data-command="task-detail"]');await until(()=>evaluate(`document.querySelector('#sheet').open`),'task detail not opened');
 assert(await evaluate(`document.querySelector('#sheet-title').textContent.includes('主图')`));await audit('task-detail');await click('[data-command="close-sheet"]');
 await evaluate(`(()=>{const e=document.querySelector('#review-search');e.value='';e.dispatchEvent(new InputEvent('input',{bubbles:true}))})()`);
 await rows(['prev-sealed','prev-pending','prev-estimated'],'search clear');
 // Return an old response after the current selection to verify request ordering.
 holdNext=true;await click('[data-command="review-preset"][data-preset="current"]');await until(()=>!!heldResolve,'request not held');
 await click('[data-command="review-preset"][data-preset="previous"]');await rows(['prev-sealed','prev-pending','prev-estimated'],'new selection resolves before old response');
 heldResolve();heldResolve=null;await until(()=>active===0,'held response did not finish');await wait(150);assert.deepEqual(await rowIds(),['prev-estimated','prev-pending','prev-sealed'],'stale response overwrote current selection');
 failNext=true;await click('[data-command="review-preset"][data-preset="current"]');
 await until(()=>evaluate(`document.querySelector('.task-review').textContent.includes('测试连接失败')`),'query failure not visible');
 await click('[data-command="review-refresh"]');await rows(['cross-month','current-only'],'retry after failure');
 await click('[data-command="review-preset"][data-preset="previous"]');await rows(['prev-sealed','prev-pending','prev-estimated'],'final previous month');
 await audit('final-review');
 for(const [width,height] of [[1360,900],[820,640]]){
  win.setSize(width,height);await wait(100);await evaluate(`document.querySelector('.review-tasks').scrollIntoView({block:'center',behavior:'instant'})`);await wait(100);
  fs.writeFileSync(path.join(out,'task-cards-'+width+'.png'),(await win.capturePage()).toPNG());
 }
 assert.equal(service.store.db.prepare('SELECT total_changes() AS n').get().n,before,'review mutated fixture database');
 // Exclusion changes only the review-period preference; source workflow records stay intact.
 const taskBeforeExclusion=service.store.get('task','prev-pending');
 await click('[data-command="review-exclude-open"][data-task="prev-pending"]');
 await until(()=>evaluate(`document.querySelector('#sheet').open`),'exclusion explanation did not open');
 await audit('exclude-dialog');
 await evaluate(`(()=>{const e=document.querySelector('#review-exclude-reason');if(e)e.value='跨月长期任务，本月单独核对'})()`);
 await click('[data-command="review-exclude-confirm"]');
 await rows(['prev-sealed','prev-estimated'],'exclude current-period task');
 assert.equal(await evaluate(`document.querySelector('.review-metric:nth-child(2) strong').textContent`),'8','excluded task points must leave totals');
 assert(await evaluate(`document.querySelector('.review-exclusions').textContent.includes('上月SKU')`),'excluded task must remain available for restoration');
 await evaluate(`(()=>{const e=document.querySelector('.review-exclusions');e.open=true;e.scrollIntoView({block:'start',behavior:'instant'})})()`);await audit('excluded-tasks');
 await click('[data-command="review-refresh"]');await rows(['prev-sealed','prev-estimated'],'exclusion survives query refresh');
 await select('#review-basis','requested');await rows(['prev-sealed','prev-estimated','cross-month','missing-date'],'exclusion follows same period across timestamp bases');
 await select('#review-basis','completed');
 await click('[data-command="review-period"][data-period="day"]');await calendar('review-anchor',dayKey(local(0,1,0)-1));
 await rows(['prev-pending'],'different period retains the excluded task');
 await click('[data-command="review-preset"][data-preset="previous"]');await rows(['prev-sealed','prev-estimated'],'returning to original period preserves exclusion');
 await evaluate(`document.querySelector('.review-exclusions').open=true`);
 await click('[data-command="review-restore"][data-task="prev-pending"]');await rows(['prev-sealed','prev-pending','prev-estimated'],'restore excluded task');
 assert.equal(await evaluate(`document.querySelector('.review-metric:nth-child(2) strong').textContent`),'10.4','restored task points must return');
 assert.deepEqual(service.store.get('task','prev-pending'),taskBeforeExclusion,'review exclusion or restore changed task workflow, points or timestamps');
 results.push({check:'period-only exclusion and restoration preserve original workflow'});

 // Add enough private records to verify real pagination, then freeze the write baseline again.
 for(let i=0;i<45;i++){const id='page-'+String(i).padStart(2,'0');service.store.put('task',id,task(id,{title:'分页测试主图'+i,completedAt:local(-1,15,12,i)}))}
 const pageBaseline=service.store.db.prepare('SELECT total_changes() AS n').get().n;
 await click('[data-command="review-refresh"]');await until(async()=>(await rowIds()).length===40,'first page must contain 40 records');
 const firstPage=await rowIds();assert.equal(await evaluate(`document.querySelector('[data-command="review-page"][data-step="-1"]').disabled`),true);
 await click('[data-command="review-page"][data-step="1"]');await until(async()=>(await rowIds()).length===8,'last page must contain remaining 8 records');
 const lastPage=await rowIds();assert.equal(new Set([...firstPage,...lastPage]).size,48,'pagination must not omit or repeat tasks');
 assert.equal(await evaluate(`document.querySelector('[data-command="review-page"][data-step="1"]').disabled`),true);
 await select('#review-state','sealed');await rows(['prev-sealed'],'filter resets pagination');
 await select('#review-state','all');await until(async()=>(await rowIds()).length===40,'removing filter resets to first page');
 await evaluate(`(()=>{const e=document.querySelector('#review-search');e.value='分页';e.dispatchEvent(new InputEvent('input',{bubbles:true}))})()`);
 await until(()=>evaluate(`document.querySelector('#review-results-status').textContent.includes('45 项任务')`),'all matched count must span pages');
 assert.equal((await rowIds()).length,40);await click('[data-command="review-page"][data-step="1"]');await until(async()=>(await rowIds()).length===5,'search last page must contain 5 records');
 const searchPage2=await rowIds(),queryCount=queries.length;win.webContents.send('workbench:change',snapshot());
 await until(()=>queries.length>queryCount&&active===0,'live change did not refresh query');await wait(80);
 assert.deepEqual(await rowIds(),searchPage2,'background synchronization reset pagination');
 assert.equal(await evaluate(`document.querySelector('#review-search').value`),'分页','background synchronization cleared search');
 results.push({check:'pagination and background update',pageSize:40,totalRecords:48,searchRecords:45,lastPage:5});
 const composingQueries=queries.length;
 await evaluate(`(()=>{const e=document.querySelector('#review-search');e.focus();e.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));e.value='分页测';e.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true,data:'测'}))})()`);
 win.webContents.send('workbench:change',snapshot());await wait(400);
 assert.equal(queries.length,composingQueries,'live synchronization queried unfinished Chinese composition');
 assert(await evaluate(`document.activeElement===document.querySelector('#review-search')&&document.querySelector('#review-search').value==='分页测'`),'live synchronization interrupted Chinese composition');
 await evaluate(`(()=>{const e=document.querySelector('#review-search');e.value='分页测试';e.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'试'}))})()`);
 await until(()=>queries.length>composingQueries&&active===0,'Chinese composition did not commit after live update');
 await until(async()=>(await rowIds()).length===40,'new committed search must reset to first page');
 assert.equal(await evaluate(`document.querySelector('#review-search').value`),'分页测试');
 results.push({check:'live synchronization preserves Chinese composition'});
 assert.equal(service.store.db.prepare('SELECT total_changes() AS n').get().n,pageBaseline,'pagination or live refresh mutated database');
 // The same shipped renderer must hide manager history navigation for designers.
 win.destroy();clientRole='designer';
 win=new BrowserWindow({show:false,width:1360,height:900,frame:false,backgroundColor:'#f5f5f7',webPreferences:{preload:path.resolve('desktop/preload.cjs'),contextIsolation:true,sandbox:true}});
 ipcMain.removeHandler('window-chrome');require('../core/window-chrome.cjs')(win,ipcMain);await win.loadFile(path.resolve('ui/index.html'));
 await until(()=>evaluate(`!!document.querySelector('[data-view="tasks"]')`),'designer renderer did not load');
 assert.equal(await evaluate(`document.querySelector('[data-view="review"]')`),null,'designer must not see manager review navigation');
 assert.equal(await evaluate(`document.querySelector('[data-command="review-open"]')`),null,'designer must not see manager shortcut');
 results.push({check:'designer manager-only navigation hidden'});
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,queries:queries.length,results,errors},null,2));
 console.log(JSON.stringify({passed:true,out,checks:results.length,queries:queries.length}));win.destroy();service.store.close();app.exit(0);
}).catch(error=>{
 fs.writeFileSync(path.join(out,'error.txt'),error.stack||String(error));console.error(error.stack||String(error));
 if(win&&!win.isDestroyed())win.capturePage().then(image=>fs.writeFileSync(path.join(out,'failure.png'),image.toPNG())).finally(()=>app.exit(1));else app.exit(1);
});
