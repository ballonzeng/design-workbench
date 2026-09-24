'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Store}=require('../core/store.cjs'),{Service}=require('../core/service.cjs'),{RequirementsSync}=require('../core/requirements-sync.cjs'),{createReport}=require('../core/report.cjs'),{notificationOptions}=require('../desktop/notifications.cjs'),{unzipSync,strFromU8}=require('fflate');
const at=s=>Date.parse(s+'+08:00');
const task={id:'historical-task',version:1,state:3,owner:'lv',requestedAt:at('2026-08-28T09:00:00'),createdAt:at('2026-08-28T09:00:00'),assignedAt:at('2026-08-28T10:00:00'),startedAt:at('2026-08-28T11:00:00'),reviewAt:at('2026-08-28T12:00:00'),elapsedMs:3600000,brand:'测试品牌',product:'测试产品',code:'6900000000000',title:'测试主图',operator:'测试运营',filename:'测试需求.xlsx',items:[{type:'creative',qty:2,points:4}]};
function xmlSheet(bytes,index){return strFromU8(unzipSync(bytes)['xl/worksheets/sheet'+index+'.xml'])}
function cell(xml,ref){return xml.match(new RegExp('<c\\b[^>]*r="'+ref+'"[^>]*>([\\s\\S]*?)</c>'))?.[1]}
test('notification mute preference maps directly to silent',()=>{assert.equal(notificationOptions(task,{}).silent,false);assert.equal(notificationOptions(task,{mute:false}).silent,false);assert.equal(notificationOptions(task,{mute:true}).silent,true)});
test('refresh without a lease reports not checked and preserves last successful timestamp',async()=>{
 const sync=new RequirementsSync({store:{all:()=>[]},nas:{config:null,lease:null},broadcast(){}});sync.status.lastCheckedAt=123;
 const result=await sync.check(true);assert.equal(result.checked,false);assert.match(result.error,/未连接/);assert.equal(result.lastCheckedAt,123);
});
test('shared asset search includes colleagues and historical product directories while mine filters them',async()=>{
 const service={store:{get:()=>null,all:()=>[{id:'mine',author:'lv',code:'6900000000000',files:[]},{id:'other',author:'liu',code:'6900000000001',files:[]},{id:'missing',author:'lv',missingAt:123}]},products:{all:()=>[{id:'family',canonicalName:'测试产品系列',aliases:['别名'],variants:[{code:'6900000000000'},{code:'6900000000002',name:'历史产品',path:'fixture-folder'}]}]}};
 const actor={role:'designer',personId:'lv'},shared=await Service.prototype.call.call(service,actor,'assets');assert.equal(shared.length,3);assert.ok(shared.some(a=>a.id==='other'));assert.ok(shared.some(a=>a.source==='nas-index'));assert.deepEqual(shared[0].aliases,['测试产品系列','别名']);
 assert.deepEqual((await Service.prototype.call.call(service,actor,'assets',{mine:true})).map(a=>a.id),['mine']);
 await assert.rejects(Service.prototype.call.call(service,{role:'anonymous',personId:'lv'},'assets'),/无效账号/);
});
test('period snapshot survives later reassignment, point edits and restart; rollback leaves no revision',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'report-revisions-'));let store=new Store(dir);t.after(()=>store.close());
 let time=at('2026-08-28T12:00:00');t.mock.method(Date,'now',()=>time);store.put('task',task.id,task);
 const cutoff=at('2026-09-01T00:00:00')-1;
 const make=()=>{const h=store.reportTasks(cutoff);return createReport(h.tasks,[],{frequency:'month',anchor:'2026-08-15',generatedAt:time,unavailable:h.unavailable})};
 time=at('2026-09-05T12:00:00');const before=xmlSheet(make().bytes,2);
 store.put('task',task.id,{...task,owner:'liu',assignedAt:time,items:[{...task.items[0],qty:5,points:10}]});
 assert.throws(()=>store.atomic(()=>{store.put('task','rolled-back',{...task,id:'rolled-back'});throw Error('rollback')}));assert.equal(store.db.prepare('SELECT COUNT(*) n FROM task_versions WHERE taskId=?').get('rolled-back').n,0);
 store.close();store=new Store(dir);const after=xmlSheet(make().bytes,2);assert.equal(cell(before,'P2'),cell(after,'P2'));assert.equal(cell(before,'R2'),cell(after,'R2'));assert.match(cell(after,'P2'),/吕慧芸/);assert.match(cell(after,'R2'),/>4</);
});
test('legacy periods without a version are disclosed, and estimated confirmations do not inflate completion',t=>{
 const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),'report-quality-')));t.after(()=>store.close());t.mock.method(Date,'now',()=>at('2026-09-05T12:00:00'));store.put('task',task.id,task);
 const historical=store.reportTasks(at('2026-09-01T00:00:00')-1);assert.equal(historical.tasks.length,0);assert.equal(historical.unavailable.length,1);
 const estimate={...task,state:4,completedAt:at('2026-09-03T12:00:00'),completionFromFolder:true,completionTimeSource:'file-estimate',importedTiming:true};
 const r=createReport([estimate],[],{frequency:'month',anchor:'2026-09-05',generatedAt:Date.now(),unavailable:historical.unavailable});
 const rows=xmlSheet(r.bytes,2);assert.match(cell(rows,'X2'),/否/);assert.doesNotMatch(cell(rows,'S2'),/<v>0<\/v>/);assert.match(xmlSheet(r.bytes,7),/该周期早于/);assert.match(xmlSheet(r.bytes,7),/确认时间为推定/);
});

test('explicit completed calibration updates prior-month report points and preserves cutoff workflow',t=>{
 const store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),'report-calibration-')));t.after(()=>store.close());let time=at('2026-08-28T14:00:00');t.mock.method(Date,'now',()=>time);
 const complete={...task,state:4,completedAt:time,completedMonth:'2026-08',sealed:true};store.put('task',task.id,complete);const cutoff=at('2026-09-01T00:00:00')-1;
 time=at('2026-09-23T12:00:00');const items=[{type:'creative',qty:5,points:10}],correction={at:time,completedAt:complete.completedAt,owner:complete.owner,code:complete.code,items};store.put('task',task.id,{...complete,items,contributionCalibration:correction});store.put('contributionCalibration',task.id+':'+complete.completedAt+':'+complete.owner,correction);
 const history=store.reportTasks(cutoff),report=createReport(history.tasks,[],{frequency:'month',anchor:'2026-08-15',generatedAt:time});assert.equal(history.tasks[0].completedAt,complete.completedAt);assert.equal(history.tasks[0].reportCalibrationAt,time);assert.match(cell(xmlSheet(report.bytes,2),'R2'),/>10</);assert.match(cell(xmlSheet(report.bytes,4),'H2'),/>10</);
 store.put('task',task.id,{...complete,state:3,contributionCalibration:null});assert.equal(store.reportTasks(cutoff).tasks[0].items[0].points,10);store.put('contributionCalibration',task.id+':'+complete.completedAt+':'+complete.owner,{...correction,completedAt:time});assert.equal(store.reportTasks(cutoff).tasks[0].items[0].points,4);
});

test('report calibrations stay with their own archive round when completion hour and owner repeat',t=>{
 const {calibrationKey}=require('../core/store.cjs'),store=new Store(fs.mkdtempSync(path.join(os.tmpdir(),'report-calibration-rounds-')));t.after(()=>store.close());
 let time=at('2026-09-24T14:00:00');t.mock.method(Date,'now',()=>time);
 const complete={...task,state:4,completedAt:time,completedMonth:'2026-09',archiveRound:0};store.put('task',task.id,complete);const firstCutoff=time;
 const first={at:++time,completedAt:complete.completedAt,owner:complete.owner,code:complete.code,archiveRound:0,items:[{type:'creative',qty:5,points:10}]};store.put('contributionCalibration',calibrationKey(complete),first);
 time++;store.put('task',task.id,{...complete,state:3,archiveRound:1,completedAt:null});
 const next={...complete,archiveRound:1,items:[{type:'creative',qty:3,points:6}]};time++;store.put('task',task.id,next);const nextCutoff=time;
 assert.equal(store.reportTasks(firstCutoff).tasks[0].items[0].points,10);assert.equal(store.reportTasks(nextCutoff).tasks[0].items[0].points,6);
 const second={...first,at:++time,archiveRound:1,items:[{type:'creative',qty:7,points:14}]};store.put('contributionCalibration',calibrationKey(next),second);
 assert.equal(store.reportTasks(firstCutoff).tasks[0].items[0].points,10);assert.equal(store.reportTasks(nextCutoff).tasks[0].items[0].points,14);
 // Legacy corrections have no round field and must never cross into rework.
 store.remove('contributionCalibration',calibrationKey(next));store.put('contributionCalibration',complete.id+':'+complete.completedAt+':'+complete.owner,{...first,archiveRound:undefined});
 assert.equal(store.reportTasks(nextCutoff).tasks[0].items[0].points,6);
});
