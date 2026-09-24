'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../ui/app.js'),'utf8').replace(/\r\n/g,'\n');
test('a blocked designer action opens a reminder and never reports successful flow',async()=>{
 let sheet=null,accepted=false;
 const context=vm.createContext({api:async()=>{throw Error('需求表正在被 Excel 占用，请关闭后重试')},manager:()=>false,flowReminders:new Map(),render:()=>{},openSheet:(...args)=>sheet=args,esc:String,states:['待分配','待设计'],button:()=>'',taskName:t=>t.title,accept:()=>{accepted=true}});
 vm.runInContext(source.slice(source.indexOf('async function taskAction('),source.indexOf('\nfunction accept(')),context);
 await context.taskAction({id:'t',state:1,filename:'需求.xlsx',version:1},'start');
 assert.equal(accepted,false);assert.equal(sheet[0],'开始设计未完成');assert.match(sheet[1],/需求.xlsx/);assert.match(context.flowReminders.get('t').message,/保存并关闭/);
});
test('Chinese composition retains the search node until commit, including background renders',()=>{
 const handlers={},context=vm.createContext({document:{addEventListener:(name,fn)=>handlers[name]=fn}});
 const guard=source.match(/function render\(\{animate=false\}=\{\}\)\{\s*if\(composingSearch\)return;/)[0];
 vm.runInContext('let composingSearch=false,query="",renders=0;'+guard+'renders++;}'+source.slice(source.indexOf('const isSearch='),source.indexOf("document.addEventListener('change'")),context);
 for(const id of ['task-search','asset-search','product-search']){
  const target={id,value:'xi'};handlers.compositionstart({target});const before=vm.runInContext('renders',context);
  handlers.input({target,isComposing:true});vm.runInContext('render()',context);assert.equal(vm.runInContext('renders',context),before);
  target.value='西红花';handlers.compositionend({target});assert.equal(vm.runInContext('query',context),'西红花');assert.equal(vm.runInContext('renders',context),before+1);
 }
});
test('asset day, Monday week, and month ranges use Shanghai boundaries across year and leap day',()=>{
 const start=source.indexOf('function assetRange()'),end=source.indexOf('\nconst peopleName=',start),context=vm.createContext({Intl,Date});
 vm.runInContext('let assetDate="2026-01-01",assetPeriod="week";'+source.slice(start,end),context);
 let r=vm.runInContext('assetRange()',context);assert.equal(r.from,Date.parse('2025-12-29T00:00:00+08:00'));assert.equal(r.to,Date.parse('2026-01-05T00:00:00+08:00'));
 r=vm.runInContext('assetDate="2024-02-29";assetPeriod="month";assetRange()',context);assert.equal(r.to-r.from,29*86400000);
 r=vm.runInContext('assetPeriod="day";assetRange()',context);assert.equal(r.from,Date.parse('2024-02-29T00:00:00+08:00'));assert.equal(r.to-r.from,86400000);
});

test('pending archive filter excludes sealed and unfinished tasks',()=>{
 const start=source.indexOf('function selectedTasks()'),end=source.indexOf('\nfunction tasksPage()',start),context=vm.createContext({data:{tasks:[{id:'pending',state:4,sealed:false},{id:'sealed',state:4,sealed:true},{id:'working',state:2,sealed:false}]},person:null,view:'tasks',filter:'unsealed',query:''});vm.runInContext(source.slice(start,end),context);assert.equal(context.selectedTasks().map(t=>t.id).join(','),'pending');
});
test('navigation renders before NAS response and late response cannot change the selected view',async()=>{
 let resolve,rendered=0;const context=vm.createContext({pageLoads:{assets:{busy:false,error:''}},api:()=>new Promise(r=>resolve=r),render:()=>rendered++,window:{scrollTo:()=>{}}});
 const load=source.slice(source.indexOf('async function loadPage('),source.indexOf('\nconst dayKey='));const nav=source.slice(source.indexOf('async function navigate('),source.indexOf('\n',source.indexOf('async function navigate(')));
 vm.runInContext('let view="team",filter="all",person=null,query="",assets=[],productGroups=[];'+load+nav,context);const pending=context.navigate('assets');assert.ok(rendered>=2);await context.navigate('tasks');resolve([{id:'late'}]);await pending;assert.equal(vm.runInContext('view',context),'tasks');assert.equal(vm.runInContext('pageLoads.assets.busy',context),false);
});

test('background upload keeps its own job when another dialog opens, and reports failures',async()=>{
 const start=source.indexOf('   const context=dialogContext,selection=context.selection;if(!selection||uploadJob?'),end=source.indexOf("\n  }\n  else if(command==='archive-reopen')",start);assert.ok(start>0);
 for(const fail of [false,true]){let finish,closed=0;const context=vm.createContext({data:{tasks:[{id:'t',title:'测试产物'}]},taskName:t=>t.title,$:()=>({checked:true}),closeSheet:()=>closed++,drawUpload:()=>{},toast:()=>{},accept:()=>{},api:(command,payload)=>{if(command==='asset-upload'){assert.equal(payload.taskId,'t');assert.equal(payload.selectionId,'s');assert.equal(payload.selfChecked,true);return new Promise((resolve,reject)=>finish=()=>fail?reject(Error('网络断开')):resolve({}))}return Promise.resolve({})}});
 vm.runInContext('let uploadJob=null,dialogContext={taskId:"t",selection:{selectionId:"s"}};async function upload(){'+source.slice(start,end)+'}',context);const pending=context.upload();assert.equal(closed,1);assert.equal(vm.runInContext('uploadJob.status',context),'running');vm.runInContext('dialogContext={taskId:"another"}',context);finish();await pending;assert.equal(closed,1);assert.equal(vm.runInContext('dialogContext.taskId',context),'another');assert.equal(vm.runInContext('uploadJob.status',context),fail?'error':'done');
 }
});

test('modified workbook and permission errors are not presented as Excel editing locks',async()=>{
 for(const message of ['NAS 原需求表已修改，请保存并关闭 Excel，点击刷新同步后再操作','EACCES: permission denied']){
  let sheet;const context=vm.createContext({api:async()=>{throw Error(message)},manager:()=>false,flowReminders:new Map(),render:()=>{},openSheet:(...args)=>sheet=args,esc:String,states:['待分配','待设计'],button:()=>'',taskName:t=>t.title});
  vm.runInContext(source.slice(source.indexOf('async function taskAction('),source.indexOf('\nfunction accept(')),context);
  await context.taskAction({id:'t',state:1,filename:'需求.xlsx',version:1},'start');
  assert.match(sheet[1],/实际原因/);assert.ok(sheet[1].includes(message));assert.ok(!sheet[1].includes('程序不会自动关闭 Excel'));
 }
});

test('completed calibration button submits the version shown when its dialog opened',async()=>{
 const start=source.indexOf("  else if(command==='calibration-confirm'){"),end=source.indexOf("  else if(command==='asset-scope')",start);assert.ok(start>=0&&end>start);let sent,notice;
 const context=vm.createContext({command:'calibration-confirm',t:{id:'t',version:8},dialogContext:{calibrationVersion:7,calibrationPreview:{workbookHash:'reviewed'}},closeSheet:()=>{},accept:()=>{},fmt:String,toast:text=>notice=text,api:async(command,payload)=>{if(command==='calibrate-contribution'){sent=payload;return {previousPoints:1.5,nextPoints:6}}return {}}});
 await vm.runInContext('(async()=>{'+source.slice(start,end).replace('else if','if')+'})()',context);assert.equal(sent.taskId,'t');assert.equal(sent.version,7);assert.equal(sent.expectedHash,'reviewed');assert.match(notice,/1.5 → 6/);
});

test('renderer upload reaches desktop batch handler and rejects a different task',async()=>{
 const desktop=fs.readFileSync(path.join(__dirname,'../desktop/main.cjs'),'utf8').replace(/\r\n/g,'\n');
 let uploaded=0;const chosen=new Map([['s',{taskId:'t',batch:[{taskId:'t',folder:'六面图',spec:{categoryName:'六面图'}}]}]]);
 const main=vm.createContext({chosen,crypto:{randomUUID:()=> 'child'},uploadOne:async payload=>{assert.equal(payload.taskId,'t');uploaded++;return {}}});
 vm.runInContext('let uploadBatchActive=false,uploading=false,uploadBatchProgress=null;'+desktop.slice(desktop.indexOf('async function upload(payload)'),desktop.indexOf('async function uploadOne(payload)')),main);
 await assert.rejects(main.upload({selectionId:'s',taskId:'other',selfChecked:true}),/任务选择/);assert.equal(uploaded,0);
 const context=vm.createContext({data:{tasks:[{id:'t',title:'六面图'}]},taskName:t=>t.title,$:()=>({checked:true}),closeSheet:()=>{},drawUpload:()=>{},toast:()=>{},accept:()=>{},api:(command,payload)=>command==='asset-upload'?main.upload(payload):Promise.resolve({})});
 const start=source.indexOf('   const context=dialogContext,selection=context.selection;if(!selection||uploadJob?'),end=source.indexOf("\n  }\n  else if(command==='archive-reopen')",start);
 vm.runInContext('let uploadJob=null,dialogContext={taskId:"t",selection:{selectionId:"s"}};async function upload(){'+source.slice(start,end)+'}',context);
 await context.upload();assert.equal(uploaded,1);assert.equal(vm.runInContext('uploadJob.status',context),'done');
});
