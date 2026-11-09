'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Service}=require('../core/service.cjs'),{prepareHistoricalTasks}=require('../core/historical-tasks.cjs'),{createReport}=require('../core/report.cjs');
const rows=[
 {owner:'jiang',product:'蓝山味黑咖啡',qty:3,completedDate:'2026-10-13'},
 {owner:'jiang',product:'西洋参黄芪党参桂圆茶',qty:2,completedDate:'2026-10-15'},
 {owner:'qiu',product:'九制黄精',qty:2,completedDate:'2026-10-15'},
 {owner:'qiu',product:'ag氨基酸云感洁面',qty:2,completedDate:'2026-10-30'},
 {owner:'lv',product:'协和花阿胶膏500g',qty:2,completedDate:'2026-10-19'},
 {owner:'lv',product:'人参黄精肉苁蓉枸杞原浆饮',qty:1,completedDate:'2026-10-16'}
];
const manager={role:'manager',personId:'zeng'},november=Date.parse('2026-11-03T10:00:00+08:00'),period={frequency:'month',anchor:'2026-10-01',basis:'completed'};
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'historical-service-')),service=new Service(dir),records=prepareHistoricalTasks(rows,{now:november,actor:'zeng',source:'user-request-2026-11-03'}).records;let touches=0;
 for(const task of records){service.store.put('historicalTask',task.id,task);service.store.event('historical-supplemented','zeng',task.id,{completedDate:task.completedDate,source:task.source,recordOnly:true})}
 const forbidden=async()=>{touches++;throw Error('Unexpected NAS access from historical-only operation')};
 service.ensureNasConnection=forbidden;service.nas.ready=forbidden;service.nas.productDirectory=forbidden;service.nas.readTask=forbidden;service.requirementsSync={check:forbidden};
 return {dir,service,records,touches:()=>touches,cleanup(){service.store.close();const absolute=path.resolve(dir);assert(absolute.startsWith(path.resolve(os.tmpdir())+path.sep+'historical-service-'));fs.rmSync(absolute,{recursive:true,force:true})}};
}

test('the six confirmed packaging completions appear only in manager snapshots and October review, with exact person totals',async()=>{
 const f=fixture();try{
  const snapshot=f.service.snapshot(manager);assert.equal(snapshot.tasks.length,6);assert(snapshot.tasks.every(task=>task.recordOnly));assert(snapshot.tasks.every(task=>task.state===4&&!task.sealed));
  assert.equal(f.service.store.all('task').length,0);assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM task_versions').get().n,0);
  for(const owner of ['jiang','qiu','lv'])assert.deepEqual(f.service.snapshot({role:'designer',personId:owner}).tasks,[]);
  const result=await f.service.call(manager,'task-review',period);assert.equal(result.summary.taskCount,6);assert.equal(result.summary.totalPoints,48);assert.equal(result.summary.pendingArchiveCount,0);assert.equal(result.summary.sealedCount,0);
  assert.deepEqual(Object.fromEntries(result.people.map(person=>[person.id,person.totalPoints])),{qiu:16,lv:12,jiang:20});
  for(const state of ['unsealed','sealed'])assert.equal((await f.service.call(manager,'task-review',{...period,state})).tasks.length,0);
  assert.equal(f.touches(),0);assert.equal(f.service.nas.lease,null);
 }finally{f.cleanup()}
});

test('historical-only records cannot call workbook transitions or upload endpoints, but retain truthful current audit history',async()=>{
 const f=fixture();try{
  const task=f.records[0],before=f.service.store.all('historicalTask'),events=f.service.store.events(task.id),payload={taskId:task.id,version:task.version,action:'start'};
  for(const command of ['requirement-location','action','archive-spec','archive-finish','archive-reopen','task-asset-location','calibrate-contribution','duplicate-inspect','received','read'])await assert.rejects(f.service.call(manager,command,payload),/历史补录/);
  const history=await f.service.call(manager,'history',{taskId:task.id});assert.deepEqual(history,events);assert.equal(history[0].kind,'historical-supplemented');assert(history[0].at>task.completedAt);
  for(const owner of ['jiang','qiu','lv'])await assert.rejects(f.service.call({role:'designer',personId:owner},'task-review',period),error=>error.status===403);
  assert.deepEqual(f.service.store.all('historicalTask'),before);assert.equal(f.touches(),0);assert.equal(f.service.store.all('asset').length,0);assert.equal(f.service.store.all('upload').length,0);
 }finally{f.cleanup()}
});

test('exclude and restore operate on period metadata without modifying historical completion records',async()=>{
 const f=fixture();try{
  const task=f.records[0],before=f.service.store.all('historicalTask'),payload={...period,taskId:task.id,reason:'仅测试本期排除'};
  const first=await f.service.call(manager,'task-review-exclude',payload);assert.equal(first.changed,true);assert.equal(f.service.store.all('reviewExclusion').length,1);
  let review=await f.service.call(manager,'task-review',period);assert.equal(review.summary.taskCount,5);assert.equal(review.summary.totalPoints,36);assert.equal(review.excludedTasks[0].id,task.id);
  assert.equal((await f.service.call(manager,'task-review-exclude',payload)).changed,false);
  await f.service.call(manager,'task-review-restore',payload);review=await f.service.call(manager,'task-review',period);assert.equal(review.summary.totalPoints,48);assert.equal(review.excludedCount,0);
  assert.deepEqual(f.service.store.all('historicalTask'),before);assert.equal(f.service.store.all('task').length,0);assert.equal(f.service.store.db.prepare('SELECT COUNT(*) AS n FROM task_versions').get().n,0);assert.equal(f.touches(),0);
 }finally{f.cleanup()}
});

test('closed October report uses the real stored supplements added in November and reconciles 48 points without time invention',async()=>{
 const f=fixture();try{
  const history=await f.service.call(manager,'report-data',period);assert.equal(history.tasks.length,6);assert(history.tasks.every(task=>task.reportHistoricalBackfill&&task.reportSnapshotAt===undefined));
  const report=createReport(history.tasks,history.events,{...period,generatedAt:november+3600000,unavailable:history.unavailable}),data=report.analysisData;
  assert.equal(data.metrics.completedPoints,48);assert.equal(data.metrics.historicalBackfillTasks,6);assert.equal(data.metrics.effectiveCompleteTasks,0);
  assert.deepEqual(Object.fromEntries(data.tables['人员汇总'].filter(person=>person['周期完成任务']).map(person=>[person['人员ID'],person['完成贡献力（点）']])),{lv:12,qiu:16,jiang:20});
  for(const row of data.tables['任务明细']){assert.match(row['运营确认'],/^2026-10-\d{2}$/);assert.equal(row['本期有效设计记录（小时）'],null);assert.equal(row['累计记录计时（小时）'],null);assert.equal(row['是否封存'],'未记录')}
  assert.equal(f.touches(),0);
 }finally{f.cleanup()}
});
