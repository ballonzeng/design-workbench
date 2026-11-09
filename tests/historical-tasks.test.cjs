'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prepareHistoricalTasks,isHistoricalTask,assertNoWorkbookOps,historicalId}=require('../core/historical-tasks.cjs');
const now=Date.parse('2026-11-03T15:00:00+08:00'),at=value=>Date.parse(value+'T00:00:00+08:00');
const row=(overrides={})=>({owner:'lv',product:'未知69码产品（规格 A/B*2）',qty:2,completedDate:'2026-10-18',...overrides});

test('historical supplements use packaging points and honest date-only completion without invented metadata',()=>{
 const input=row(),saved=structuredClone(input),result=prepareHistoricalTasks([input],{now});
 assert.deepEqual(input,saved);assert.deepEqual(result.summary,{inputCount:1,createdCount:1,skippedCount:0,totalQty:2,totalPoints:8});assert.equal(result.skipped.length,0);
 const t=result.records[0];assert.equal(isHistoricalTask(t),true);assert.equal(t.owner,'lv');assert.equal(t.product,input.product);assert.equal(t.title,input.product);assert.equal(t.items[0].type,'packaging-design');assert.equal(t.items[0].category,'packaging');assert.equal(t.items[0].points,8);assert.equal(t.items[0].qty,2);
 assert.equal(t.completedAt,at('2026-10-18'));assert.equal(t.completedDate,'2026-10-18');assert.equal(t.completedTimePrecision,'day');assert.equal(t.completedMonth,'2026-10');assert.equal(t.completionTimeSource,'user-confirmed-date');assert.equal(t.completionFromFolder,false);
 for(const key of ['requestedAt','assignedAt','startedAt','reviewAt','sealedAt','filename','brand','workbookBrand','code','operator'])assert.equal(t[key],null);
 assert.equal(t.createdAt,now);assert.equal(t.supplementedAt,now);assert.equal(t.updatedAt,now);assert.equal(t.confirmedBy,'zeng');assert.equal(t.source,'historical-supplement');assert.equal(t.supplementSource,'user-confirmed-historical');assert.equal(t.recordOnly,true);assert.equal(t.state,4);assert.equal(t.sealed,false);assert.equal(t.archiveStatus,'not-recorded');assert.equal(t.elapsedMs,0);assert.equal(t.runningSince,null);assert.equal(t.timingIncomplete,true);assert.equal(t.importedTiming,true);assert.deepEqual(t.workIntervals,[]);
 assert.match(t.id,/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);assert.equal(t.id,historicalId('lv',input.product,input.completedDate,input.qty));
});

test('exact designer names resolve and optional real metadata is preserved without product normalization',()=>{
 const product='  B420 14g（2g*7）/盒  ',t=prepareHistoricalTasks([row({owner:'江雨婷',product,qty:3,brand:' 九芝堂 ',code:'6970855224163',operator:'真实运营',note:'仅补录确认日期',sourceKey:'user-row-3'})],{now,actor:'zeng',source:'chat-confirmation'}).records[0];
 assert.equal(t.owner,'jiang');assert.equal(t.product,product);assert.equal(t.items[0].product,product);assert.equal(t.brand,'九芝堂');assert.equal(t.code,'6970855224163');assert.equal(t.items[0].code,t.code);assert.equal(t.operator,'真实运营');assert.equal(t.note,'仅补录确认日期');assert.equal(t.sourceKey,'user-row-3');assert.equal(t.supplementSource,'chat-confirmation');assert.equal(isHistoricalTask(t),true);
});

test('invalid dates, future completion, invalid quantity, removed owners and fabricated metadata reject',()=>{
 const invalid=[{owner:'unknown'},{owner:'zeng'},{product:' '},{qty:0},{qty:1.5},{qty:10001},{completedDate:'2026-02-29'},{completedDate:'2026-13-01'},{completedDate:'2026-10-32'},{completedDate:'2026-11-04'},{completedDate:'10/18'},{code:'unknown'},{brand:42}];
 for(const override of invalid)assert.throws(()=>prepareHistoricalTasks([row(override)],{now}),JSON.stringify(override));
 const people=[{id:'lv',name:'吕慧芸',title:'设计师',removed:true}];assert.throws(()=>prepareHistoricalTasks([row()],{now,people}),/移出组织/);
 assert.throws(()=>prepareHistoricalTasks([],{now}));assert.throws(()=>prepareHistoricalTasks(null,{now}));assert.throws(()=>prepareHistoricalTasks([row()],{now:Infinity}));
 const result=prepareHistoricalTasks([row({completedDate:'2026-11-03'})],{now:Date.parse('2026-11-02T23:59:59Z')});assert.equal(result.records.length,1);
});

test('IDs and exact duplicates are stable across repeated preparation, names and input order',()=>{
 const initial=prepareHistoricalTasks([row()],{now}),t=initial.records[0];
 assert.equal(prepareHistoricalTasks([row({owner:'吕慧芸'})],{now:now+1000}).records[0].id,t.id);
 const duplicate=prepareHistoricalTasks([row()],{now,existingHistorical:initial.records});assert.equal(duplicate.records.length,0);assert.equal(duplicate.skipped.length,1);assert.equal(duplicate.skipped[0].id,t.id);
 const sameBatch=prepareHistoricalTasks([row(),row()],{now});assert.equal(sameBatch.records.length,1);assert.equal(sameBatch.skipped.length,1);assert.equal(sameBatch.summary.totalPoints,8);
 const other=prepareHistoricalTasks([row({completedDate:'2026-10-19'})],{now});assert.notEqual(other.records[0].id,t.id);
});

test('completed native packaging records deduplicate and quantity conflicts never overwrite prior history',()=>{
 const native={id:'native',state:4,owner:'lv',product:row().product,completedAt:at('2026-10-18')+10*3600000,items:[{type:'packaging-design',qty:1},{type:'packaging-design',qty:1},{type:'creative',qty:3}]},before=structuredClone(native);
 const result=prepareHistoricalTasks([row()],{now,existingTasks:[native]});assert.equal(result.records.length,0);assert.equal(result.skipped[0].id,'native');assert.deepEqual(native,before);
 assert.throws(()=>prepareHistoricalTasks([row({qty:3})],{now,existingTasks:[native]}),e=>e.status===409);
 assert.throws(()=>prepareHistoricalTasks([row(),row({qty:3})],{now}),e=>e.status===409);
 assert.equal(prepareHistoricalTasks([row()],{now,existingTasks:[{...native,deleted:true}]}).records.length,1);
 assert.equal(prepareHistoricalTasks([row()],{now,existingTasks:[{...native,state:2}]}).records.length,1);
});

test('invalid or mutated supplements are not considered valid reporting records and workbook operations are blocked',()=>{
 const original=prepareHistoricalTasks([row()],{now}).records[0];
 for(const changed of [{recordOnly:false},{source:'other'},{requestedAt:now},{assignedAt:now},{startedAt:now},{reviewAt:now},{filename:'invented.xlsx'},{completedTimePrecision:'hour'},{completedAt:original.completedAt+3600000},{completedMonth:'2026-11'},{code:'bad'},{elapsedMs:60000},{sealed:true},{id:'forged'}])assert.equal(isHistoricalTask({...original,...changed}),false,JSON.stringify(changed));
 assert.equal(isHistoricalTask({...original,items:[{...original.items[0],points:999}]}),false);assert.equal(isHistoricalTask(null),false);
 assert.throws(()=>assertNoWorkbookOps(original),e=>e.status===409);assert.throws(()=>assertNoWorkbookOps({recordOnly:true}),e=>e.status===409);assert.doesNotThrow(()=>assertNoWorkbookOps({filename:'original.xlsx'}));
});

test('backfilled history is appended explicitly to cutoff reports without fabricated task versions and survives restart',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Store}=require('../core/store.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'historical-records-'));let store=new Store(dir);
 try{
  const [t]=prepareHistoricalTasks([row()],{now}).records;store.put('historicalTask',t.id,t);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_versions').get().n,0);assert.equal(store.all('task').length,0);
  const cutoff=at('2026-11-01')-1,result=store.reportTasks(cutoff);assert.equal(result.tasks.length,1);assert.equal(result.unavailable.length,0);assert.equal(result.tasks[0].reportHistoricalBackfill,true);assert.equal(result.tasks[0].reportSupplementedAt,now);assert.equal(result.tasks[0].createdAt,now);assert.equal(result.tasks[0].reportSnapshotAt,undefined);
  assert.equal(store.reportTasks(t.completedAt-1).tasks.length,0);assert.equal(store.reportTasks(t.completedAt).tasks.length,1);
  store.put('historicalTask','invalid',{...t,id:'invalid',filename:'fake.xlsx'});assert.equal(store.reportTasks(cutoff).tasks.length,1);
  store.close();store=new Store(dir);assert.equal(store.reportTasks(cutoff).tasks[0].id,t.id);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM task_versions').get().n,0);assert.equal(store.all('historicalTask').length,2);
 }finally{store.close();const absolute=path.resolve(dir);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep+'historical-records-'));fs.rmSync(absolute,{recursive:true,force:true})}
});
