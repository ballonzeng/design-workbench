'use strict';
// Real renderer + sandboxed preload + isolated local Service. No NAS connection.
const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Service}=require('../core/service.cjs'),{prepareHistoricalTasks}=require('../core/historical-tasks.cjs');
app.disableHardwareAcceleration();
const H=3600000,at=s=>Date.parse(s+'+08:00'),friday=at('2026-10-09T17:00:00'),monday=at('2026-10-12T10:00:00');
const out=path.resolve('outputs/task-duration-ui-'+Date.now());fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.on('window-all-closed',()=>{});process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
let win,service,role='manager',nasTouches=0,historicalId;const results=[],errors=[],calls=[];
const actor=()=>({role,personId:role==='manager'?'zeng':'hong'});
function snapshot(){const realNow=Date.now;try{Date.now=()=>monday;return {...service.snapshot(actor()),version:require('../package.json').version,connection:{online:true},nasStatus:{connected:false},addresses:[]}}finally{Date.now=realNow}}
function task(id,title,extra={}){return {id,title,state:2,sealed:false,owner:'hong',version:1,product:'有效耗时验证产品',brand:'测试品牌',code:'6970855224163',operator:'测试运营',filename:id+'.xlsx',items:[{id:'row-6',row:6,type:'basic',typeName:'基础元素替换',qty:1,points:.8}],createdAt:friday,requestedAt:friday,assignedAt:friday,updatedAt:monday,startedAt:friday,reviewAt:null,elapsedMs:65*H,runningSince:null,timingTracked:true,timingIncomplete:false,workIntervals:[{owner:'hong',start:friday,end:monday}],...extra}}
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms)),evaluate=code=>win.webContents.executeJavaScript(code);
async function until(check,message){const end=Date.now()+7000;while(Date.now()<end){if(await check())return;await wait(40)}throw Error(message)}
async function click(selector){await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.click()})()`);await wait(50)}
async function detail(id){await click('[data-card="'+id+'"] [data-command="task-detail"]');await until(()=>evaluate(`document.querySelector('#sheet').open`),'detail missing: '+id);return evaluate(`document.querySelector('#sheet-body').textContent`)}
async function audit(label){for(const [width,height]of [[1360,900],[820,640]]){win.setSize(width,height);await wait(90);if(label.includes('-detail')){await evaluate("document.querySelector('#sheet-body dl')?.lastElementChild?.scrollIntoView({block:'center',behavior:'instant'})");await wait(50)}const metrics=await evaluate(`(()=>{const root=document.documentElement,m=document.querySelector('main'),d=document.querySelector('dialog[open]'),b=d?.querySelector('#sheet-body');return {width:innerWidth,height:innerHeight,rootWidth:root.scrollWidth,rootHeight:root.scrollHeight,rootClientHeight:root.clientHeight,mainWidth:m.clientWidth,mainScrollWidth:m.scrollWidth,dialog:d?{top:d.getBoundingClientRect().top,bottom:d.getBoundingClientRect().bottom,bodyWidth:b?.clientWidth,bodyScrollWidth:b?.scrollWidth}:null}})()`);assert(metrics.rootWidth<=metrics.width+1,label+' document overflow');assert(metrics.rootHeight<=metrics.rootClientHeight+1,label+' document vertical scroll');assert(metrics.mainScrollWidth<=metrics.mainWidth+1,label+' main overflow');if(metrics.dialog){assert(metrics.dialog.top>=42&&metrics.dialog.bottom<=height+1,label+' dialog bounds');assert(metrics.dialog.bodyScrollWidth<=metrics.dialog.bodyWidth+1,label+' detail overflow')}results.push({check:label,...metrics});fs.writeFileSync(path.join(out,label+'-'+width+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())}win.setSize(1360,900);await wait(70)}
async function makeWindow(){win=new BrowserWindow({show:false,width:1360,height:900,frame:false,backgroundColor:'#f5f5f7',webPreferences:{preload:path.resolve('desktop/preload.cjs'),contextIsolation:true,sandbox:true}});ipcMain.removeHandler('window-chrome');require('../core/window-chrome.cjs')(win,ipcMain);win.webContents.on('console-message',(_e,d)=>{if(d.level==='error'&&!d.message.includes('favicon'))errors.push(d.message)});await win.loadFile(path.resolve('ui/index.html'));await until(()=>evaluate(`!!document.querySelector('[data-view="tasks"]')`),'renderer did not load');await click('[data-view="tasks"]');await until(()=>evaluate(`!!document.querySelector('[data-card="recorded"]')`),'task cards missing')}
app.whenReady().then(async()=>{
 service=new Service(path.join(out,'db'));
 const fixtures=[task('recorded','完整记录跨周末'),task('saturday','调休周六不累计',{startedAt:at('2026-10-10T09:00:00'),elapsedMs:9*H,workIntervals:[{owner:'hong',start:at('2026-10-10T09:00:00'),end:at('2026-10-10T18:00:00')}]}),task('partial','不完整记录',{importedTiming:true}),task('estimate','推算记录',{timingTracked:false,importedTiming:true,workIntervals:[],reviewAt:monday}),task('unknown','旧累计未知',{timingTracked:false,workIntervals:[],startedAt:null}),task('waiting','运营确认等待',{state:3,startedAt:at('2026-10-09T16:00:00'),reviewAt:friday,elapsedMs:H,workIntervals:[{owner:'hong',start:at('2026-10-09T16:00:00'),end:friday}]}),task('other-owner','别人的任务',{owner:'lv'})];
 for(const t of fixtures)service.store.put('task',t.id,t);
 const historical=prepareHistoricalTasks([{owner:'hong',product:'历史包装未知计时',qty:1,completedDate:'2026-10-09'}],{now:monday,actor:'zeng'}).records[0];historicalId=historical.id;service.store.put('historicalTask',historical.id,historical);
 const before={native:service.store.all('task'),historical:service.store.all('historicalTask')},writes=service.store.db.prepare('SELECT total_changes() AS n').get().n;
 const forbidden=()=>{nasTouches++;throw Error('Duration check must not access NAS')};service.ensureNasConnection=forbidden;service.nas.ready=forbidden;service.nas.readTask=forbidden;service.nas.productDirectory=forbidden;service.requirementsSync={check:forbidden};
 ipcMain.handle('workbench:call',async(_e,command,payload={})=>{calls.push({role,command});try{if(command==='snapshot')return {ok:true,value:snapshot()};if(command==='history')return {ok:true,value:await service.call(actor(),command,payload)};throw Error('Unexpected read-only verification operation: '+command)}catch(e){return {ok:false,error:e.message}}});
 for(const clientRole of ['manager','designer']){
  role=clientRole;await makeWindow();assert.equal(snapshot().durationCalculationVersion,1);
  const text=id=>evaluate(`document.querySelector('[data-card="${id}"] .task-timing').textContent`);
  const recorded=await text('recorded');assert.match(recorded,/有效设计耗时\s*2 小时 0 分钟/);assert.doesNotMatch(recorded,/65 小时/);results.push({check:role+' recorded card',text:recorded});
  const saturday=await text('saturday');assert.match(saturday,/有效设计耗时\s*0 分钟/);assert.doesNotMatch(saturday,/9 小时/);results.push({check:role+' Saturday zero effective time',text:saturday});
  const partial=await text('partial');assert.match(partial,/记录不完整/);assert.match(partial,/2 小时 0 分钟/);assert.doesNotMatch(partial,/65 小时/);results.push({check:role+' partial card',text:partial});
  const estimate=await text('estimate');assert.match(estimate,/工作时段历时（推算）/);assert.match(estimate,/2 小时 0 分钟/);assert.doesNotMatch(estimate,/有效设计耗时|65 小时/);results.push({check:role+' estimate card',text:estimate});
  const unknown=await text('unknown');assert.match(unknown,/有效设计耗时未记录/);assert.doesNotMatch(unknown,/65 小时|0 分钟/);results.push({check:role+' unknown card',text:unknown});
  const waiting=await text('waiting');assert.match(waiting,/待确认有效历时 2 小时 0 分钟/);assert.match(waiting,/有效设计耗时 1 小时 0 分钟/);results.push({check:role+' confirmation wait',text:waiting});
  assert.equal(await evaluate(`!!document.querySelector('[data-card="other-owner"]')`),role==='manager');assert.equal(await evaluate(`!!document.querySelector('[data-card="${historical.id}"]')`),role==='manager');
  await audit(role+'-cards');
  for(const id of ['recorded','partial','estimate','unknown']){
   const body=await detail(id);assert.doesNotMatch(body,/65 小时/);
   if(id==='recorded'){assert.match(body,/有效设计耗时\s*2 小时 0 分钟/);assert.match(body,/排除周六、周日/)}
   if(id==='partial'){assert.match(body,/已记录有效耗时（记录不完整）\s*2 小时 0 分钟/);assert.match(body,/不代表完整设计工时/)}
   if(id==='estimate'){assert.match(body,/工作时段历时（推算）\s*2 小时 0 分钟/);assert.match(body,/不能当作真实记录工时/)}
   if(id==='unknown'){assert.match(body,/有效耗时未记录\s*未记录/);assert.match(body,/完整有效耗时未知/);assert.doesNotMatch(body,/0 分钟/)}
   results.push({check:role+' '+id+' detail evidence label'});if(['recorded','estimate','unknown'].includes(id))await audit(role+'-'+id+'-detail');await click('[data-command="close-sheet"]');
  }
  if(role==='manager'){const body=await detail(historical.id);assert.match(body,/实际设计耗时\s*未记录/);assert.doesNotMatch(body,/0 分钟|0分钟/);results.push({check:'historical supplement duration remains unknown'});await click('[data-command="close-sheet"]')}
  win.destroy();
 }
 assert.equal(nasTouches,0);assert.deepEqual(service.store.all('task'),before.native);assert.deepEqual(service.store.all('historicalTask'),before.historical);assert.equal(service.store.db.prepare('SELECT total_changes() AS n').get().n,writes);assert.deepEqual(errors,[]);service.store.close();
 fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,version:require('../package.json').version,results,calls,errors,nasTouches,productionAccess:false},null,2));console.log(JSON.stringify({passed:true,out,checks:results.length,nasTouches}));app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(out,'error.txt'),error.stack||String(error));console.error(error.stack||String(error));if(win&&!win.isDestroyed())win.capturePage().then(image=>fs.writeFileSync(path.join(out,'failure.png'),image.toPNG())).finally(()=>app.exit(1));else app.exit(1)});
