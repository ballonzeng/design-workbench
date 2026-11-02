'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {queryTaskReview,reviewRange,reviewExclusionKey}=require('../core/task-review.cjs');
const at=text=>Date.parse(text+'+08:00');
const november=at('2026-11-02T12:00:00');
const people=[{id:'lv',name:'吕慧芸'},{id:'hong',name:'洪华',removed:true}];
const task=(id,overrides={})=>({id,title:'创意图',product:'胶原蛋白肽',brand:'九芝堂',code:'6976869180136',owner:'lv',state:4,sealed:false,requestedAt:at('2026-09-28T09:00:00'),completedAt:at('2026-10-02T10:00:00'),items:[{type:'creative',qty:2,points:4}],...overrides});

test('default review is previous Shanghai calendar month, including year rollover',()=>{
 assert.deepEqual(reviewRange({},november),{frequency:'month',start:at('2026-10-01T00:00:00'),end:at('2026-11-01T00:00:00'),label:'2026 年 10 月',anchor:'2026-10-01',startDate:'2026-10-01',endDate:'2026-10-31',timezone:'Asia/Shanghai'});
 const december=reviewRange({},at('2027-01-01T00:00:00'));assert.equal(december.startDate,'2026-12-01');assert.equal(december.endDate,'2026-12-31');
 assert.equal(reviewRange({anchor:'2024-02'}).endDate,'2024-02-29');
});

test('month, week, day and inclusive custom dates use end-exclusive Shanghai midnight',()=>{
 const week=reviewRange({frequency:'week',anchor:'2026-11-01'});assert.equal(week.startDate,'2026-10-26');assert.equal(week.endDate,'2026-11-01');
 const day=reviewRange({frequency:'day',anchor:'2026-10-31'});assert.equal(day.end,at('2026-11-01T00:00:00'));
 const custom=reviewRange({frequency:'custom',start:'2026-09-30',end:'2026-10-01'});assert.equal(custom.start,at('2026-09-30T00:00:00'));assert.equal(custom.end,at('2026-10-02T00:00:00'));
 const result=queryTaskReview([task('start',{completedAt:day.start}),task('last',{completedAt:day.end-1}),task('end',{completedAt:day.end}),task('before',{completedAt:day.start-1})],people,{frequency:'day',anchor:'2026-10-31'},november);
 assert.deepEqual(result.tasks.map(t=>t.id),['last','start']);
});

test('invalid periods and malformed filter values reject instead of silently changing dates',()=>{
 for(const options of [{frequency:'year'},{anchor:'2026-02-29'},{anchor:'2026-13-01'},{anchor:'2026-10-32'},{anchor:'x'},{frequency:'week',anchor:'2026-10'},{frequency:'custom',start:'2026-10-03',end:'2026-10-02'},{frequency:'custom',start:'2026-10-01',end:'2026-02-30'}])assert.throws(()=>reviewRange(options,november));
 for(const options of [{basis:'created'},{basis:'__proto__'},{basis:'constructor'},{basis:{}},{state:'5'},{personId:42},{query:42},{query:'a'.repeat(301)}])assert.throws(()=>queryTaskReview([],[],options,november));
 assert.throws(()=>reviewRange(null,november));
});

test('historical imported tasks remain visible even if first stored in following month',()=>{
 const source=task('imported',{createdAt:november,updatedAt:november,reviewAt:at('2026-10-01T09:00:00'),completedMonth:'2026-10',deliveries:[{id:'asset-1'}]});
 const result=queryTaskReview([source],people,{},november);
 assert.equal(result.tasks.length,1);assert.equal(result.tasks[0].matchedAt,source.completedAt);assert.equal(result.tasks[0].reviewAt,source.reviewAt);assert.equal(result.tasks[0].deliveries[0].id,'asset-1');assert.equal(source.totalPoints,undefined);assert.match(result.definitions.state,/当前保存值/);
});

test('selected time basis keeps demand, assignment, completion and sealing separate across months',()=>{
 const source=task('cross-month',{assignedAt:at('2026-10-01T09:00:00'),sealedAt:at('2026-11-01T10:00:00'),sealed:true});
 assert.equal(queryTaskReview([source],people,{basis:'requested'},november).tasks.length,0);
 assert.equal(queryTaskReview([source],people,{basis:'assigned'},november).tasks.length,1);
 assert.equal(queryTaskReview([source],people,{basis:'completed'},november).tasks.length,1);
 assert.equal(queryTaskReview([source],people,{basis:'sealed'},november).tasks.length,0);
 assert.equal(queryTaskReview([source],people,{basis:'sealed',anchor:'2026-11'},november).tasks.length,1);
});

test('missing chosen timestamps are scoped by other filters and never fall back to import or creation',()=>{
 const tasks=[task('missing',{completedAt:null,createdAt:at('2026-10-05T10:00:00')}),task('other-person-missing',{owner:'hong',completedAt:null}),task('with-time')];
 const result=queryTaskReview(tasks,people,{personId:'lv'},november);
 assert.deepEqual(result.tasks.map(t=>t.id),['with-time']);assert.equal(result.quality.missingTimestampCount,1);
 assert.equal(queryTaskReview(tasks,people,{personId:'lv',query:'with-time'},november).quality.missingTimestampCount,0);
 assert.match(result.definitions.missingTimestamp,/无法确定所属日期/);
});

test('estimated confirmations remain visible but do not inflate verified completion totals',()=>{
 const tasks=[task('verified'),task('folder',{completionFromFolder:true}),task('file',{completionTimeSource:'file-estimate'}),task('review',{completionTimeSource:'review-estimate'})];
 const result=queryTaskReview(tasks,people,{},november);
 assert.equal(result.summary.taskCount,4);assert.equal(result.summary.totalPoints,16);assert.equal(result.summary.completedCount,1);assert.equal(result.summary.completedPoints,4);assert.equal(result.quality.estimatedTimestampCount,3);
 assert.equal(result.people[0].completedPoints,4);
 assert.equal(queryTaskReview(tasks.map(t=>({...t,requestedAt:t.completedAt})),people,{basis:'requested'},november).quality.estimatedTimestampCount,0);
});

test('people, current workflow/archiving status and Chinese search combine while removed owners are excluded',()=>{
 const tasks=[task('removed',{owner:'hong',sealed:true}),task('pending'),task('active',{state:2}),task('unassigned',{owner:null,state:0})];
 const departed=queryTaskReview(tasks,people,{personId:'hong',state:'sealed',query:'洪华'},november);assert.equal(departed.tasks.length,0);assert.equal(departed.people.length,0);assert.equal(departed.summary.taskCount,0);
 assert.equal(queryTaskReview(tasks,people,{state:'unsealed'},november).summary.pendingArchiveCount,1);
 assert.equal(queryTaskReview(tasks,people,{state:2,query:' 九芝堂 '},november).tasks[0].id,'active');
 assert.equal(queryTaskReview(tasks,people,{state:'0',personId:'_unassigned'},november).people[0].name,'未分配');
 assert.equal(queryTaskReview(tasks,people,{query:'6976869180136'},november).tasks.length,3);
});

test('removed owners contribute no tasks, points, people or date quality counts even when queried explicitly',()=>{
 const tasks=[task('active'),task('unassigned',{owner:null}),task('removed-sealed',{owner:'hong',sealed:true}),task('removed-estimated',{owner:'hong',completionFromFolder:true}),task('removed-missing',{owner:'hong',completedAt:null}),task('removed-points',{owner:'hong',items:[{type:'unknown',qty:1}]})];
 const saved=structuredClone(tasks),result=queryTaskReview(tasks,people,{},november);
 assert.deepEqual(result.tasks.map(t=>t.id),['active','unassigned']);
 assert.deepEqual(result.people.map(p=>p.id),['lv','_unassigned']);
 assert.deepEqual(result.summary,{taskCount:2,totalPoints:8,completedCount:2,completedPoints:8,sealedCount:0,pendingArchiveCount:2});
 assert.deepEqual(result.quality,{missingTimestampCount:0,estimatedTimestampCount:0,missingPointsCount:0});
 for(const options of [{personId:'hong'},{query:'洪华'},{personId:'hong',basis:'requested',anchor:'2026-09'}]){
  const filtered=queryTaskReview(tasks,people,options,november);assert.equal(filtered.tasks.length,0);assert.equal(filtered.people.length,0);assert.equal(filtered.summary.totalPoints,0);assert.equal(filtered.quality.missingTimestampCount,0);
 }
 assert.deepEqual(tasks,saved);
});

test('deleted and suppressed missing-workbook duplicates stay out of historical search',()=>{
 const missing={message:'五个状态文件夹内未找到原需求表，请检查是否被移动或改名'},tasks=[task('deleted',{deleted:true}),task('suppressed',{state:1,workbookSyncIssue:missing}),task('completed-existing',{workbookSyncIssue:missing}),task('other-issue',{state:2,workbookSyncIssue:{message:'Excel 正在编辑'}})];
 assert.deepEqual(queryTaskReview(tasks,people,{},november).tasks.map(t=>t.id),['completed-existing','other-issue']);
});

test('points retain saved calibration, recover known rates, and disclose unresolvable amounts',()=>{
 const source=task('points',{items:[{type:'creative',qty:1,points:8},{type:'resize',qty:2},{type:'unknown',qty:1}]});
 const result=queryTaskReview([source],people,{},november);
 assert.equal(result.summary.totalPoints,8.8);assert.equal(result.tasks[0].pointsIncomplete,true);assert.equal(result.quality.missingPointsCount,1);
});

test('manual period exclusions remove task and quality totals while keeping an unfiltered restore list',()=>{
 const october=reviewRange({},november),tasks=[task('kept'),task('long',{completionFromFolder:true}),task('missing',{completedAt:null}),task('removed',{owner:'hong'}),task('deleted',{deleted:true})];
 const saved=structuredClone(tasks),exclusions=['long','missing','removed','deleted'].map(taskId=>({taskId,startDate:october.startDate,endDate:october.endDate,reason:'长期项目',at:november,by:'zeng'}));
 const result=queryTaskReview(tasks,people,{},november,exclusions);
 assert.deepEqual(result.tasks.map(t=>t.id),['kept']);assert.equal(result.summary.totalPoints,4);assert.equal(result.summary.pendingArchiveCount,1);assert.equal(result.people[0].taskCount,1);assert.deepEqual(result.quality,{missingTimestampCount:0,estimatedTimestampCount:0,missingPointsCount:0});
 assert.deepEqual(result.excludedTasks.map(t=>t.id),['long','missing']);assert.equal(result.excludedCount,2);assert.equal(result.excludedTasks[0].exclusion.reason,'长期项目');assert.equal(result.excludedTasks[1].matchedAt,null);
 const otherFilters=queryTaskReview(tasks,people,{personId:'_unassigned',state:'0',query:'没有匹配',basis:'sealed'},november,exclusions);
 assert.equal(otherFilters.tasks.length,0);assert.deepEqual(otherFilters.excludedTasks.map(t=>t.id),['long','missing']);assert.equal(otherFilters.excludedTasks[0].matchedAt,null);assert.deepEqual(tasks,saved);
});

test('exclusions are isolated to exact date bounds and shared only by equivalent periods',()=>{
 const source=task('long'),october=reviewRange({},november),exclusion={taskId:source.id,startDate:october.startDate,endDate:october.endDate,reason:'长期项目',at:november,by:'zeng'};
 assert.equal(queryTaskReview([source],people,{basis:'completed'},november,[exclusion]).tasks.length,0);
 const requested=queryTaskReview([source],people,{basis:'requested'},november,[exclusion]);assert.equal(requested.excludedCount,1);
 const custom=queryTaskReview([source],people,{frequency:'custom',start:'2026-10-01',end:'2026-10-31'},november,[exclusion]);assert.equal(custom.tasks.length,0);assert.equal(custom.excludedCount,1);assert.equal(reviewExclusionKey(custom.range,source.id),reviewExclusionKey(october,source.id));
 const day=queryTaskReview([source],people,{frequency:'day',anchor:'2026-10-02'},november,[exclusion]);assert.equal(day.tasks.length,1);assert.equal(day.excludedCount,0);
 const next=queryTaskReview([source],people,{anchor:'2026-11'},november,[exclusion]);assert.equal(next.excludedCount,0);
});

test('manual review exclusions persist, audit once, respect permissions and restore without modifying task records',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Service}=require('../core/service.cjs');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'task-review-exclude-'));let service=new Service(temporary);
 const manager={role:'manager',personId:'zeng'},designer={role:'designer',personId:'lv'},options={taskId:'long',frequency:'month',anchor:'2026-10-01',basis:'completed',reason:'  长周期需求，不计入本月回顾  '};
 try{
  service.store.put('task','long',task('long'));service.store.put('task','retained',task('retained'));service.store.put('task','removed',task('removed',{owner:'hong'}));service.store.put('removedMember','hong',{at:november,by:'zeng'});
  const before=service.store.all('task'),versionsBefore=service.store.db.prepare('SELECT COUNT(*) AS count FROM task_versions').get().count;
  for(const command of ['task-review-exclude','task-review-restore'])await assert.rejects(service.call(designer,command,options),e=>e.status===403);
  for(const reason of [42,{},'a'.repeat(301)])await assert.rejects(service.call(manager,'task-review-exclude',{...options,reason}),/300/);
  await assert.rejects(service.call(manager,'task-review-exclude',{...options,taskId:'none'}),e=>e.status===404);
  await assert.rejects(service.call(manager,'task-review-exclude',{...options,anchor:'2026-11-01'}),e=>e.status===409);
  await assert.rejects(service.call(manager,'task-review-exclude',{...options,taskId:'removed'}),e=>e.status===409);
  assert.equal(service.store.all('reviewExclusion').length,0);
  const first=await service.call(manager,'task-review-exclude',options);assert.equal(first.changed,true);assert.equal(first.exclusion.reason,'长周期需求，不计入本月回顾');assert.equal(first.exclusion.by,'zeng');assert.equal(first.range.startDate,'2026-10-01');
  const repeated=await service.call(manager,'task-review-exclude',{...options,reason:'重复点击'});assert.equal(repeated.changed,false);assert.deepEqual(repeated.exclusion,first.exclusion);assert.equal(service.store.events('long').filter(e=>e.kind==='task-review-excluded').length,1);
  let result=await service.call(manager,'task-review',{anchor:'2026-10'});assert.deepEqual(result.tasks.map(t=>t.id),['retained']);assert.equal(result.excludedCount,1);assert.equal(result.summary.totalPoints,4);
  service.store.close();service=new Service(temporary);result=await service.call(manager,'task-review',{anchor:'2026-10',basis:'sealed',query:'不存在',personId:'_unassigned'});assert.equal(result.tasks.length,0);assert.equal(result.excludedTasks[0].id,'long');assert.deepEqual(result.excludedTasks[0].exclusion,first.exclusion);
  const day=await service.call(manager,'task-review',{frequency:'day',anchor:'2026-10-02'});assert.deepEqual(day.tasks.map(t=>t.id),['long','retained']);assert.equal(day.excludedCount,0);
  const different=await service.call(manager,'task-review-restore',{...options,frequency:'day',anchor:'2026-10-02'});assert.equal(different.changed,false);assert.equal(service.store.all('reviewExclusion').length,1);
  const restored=await service.call(manager,'task-review-restore',{taskId:'long',frequency:'custom',start:'2026-10-01',end:'2026-10-31'});assert.equal(restored.changed,true);assert.equal(service.store.all('reviewExclusion').length,0);
  const again=await service.call(manager,'task-review-restore',options);assert.equal(again.changed,false);assert.equal(service.store.events('long').filter(e=>e.kind==='task-review-restored').length,1);
  result=await service.call(manager,'task-review',{anchor:'2026-10'});assert.deepEqual(result.tasks.map(t=>t.id),['long','retained']);assert.equal(result.excludedCount,0);assert.equal(result.summary.totalPoints,8);
  assert.deepEqual(service.store.all('task'),before);assert.equal(service.store.db.prepare('SELECT COUNT(*) AS count FROM task_versions').get().count,versionsBefore);assert.equal(service.nas.lease,null);
 }finally{service.store.close();const absolute=path.resolve(temporary);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep+'task-review-exclude-'));fs.rmSync(absolute,{recursive:true,force:true})}
});

test('manager query is read-only and available without NAS; designer access is denied',async()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{Service}=require('../core/service.cjs');
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'task-review-')),service=new Service(temporary);
 try{
  service.store.put('task','persisted',task('persisted',{owner:'hong',createdAt:november}));service.store.put('task','retained-active',task('retained-active'));service.store.put('removedMember','hong',{at:november,by:'zeng'});
  const before=service.store.all('task'),events=service.store.recent();
  const result=await service.call({role:'manager',personId:'zeng'},'task-review',{anchor:'2026-10'});
  assert.deepEqual(result.tasks.map(t=>t.id),['retained-active']);assert.equal(result.people.some(p=>p.removed),false);assert.equal(result.summary.taskCount,1);assert.deepEqual(service.store.all('task'),before);assert.deepEqual(service.store.recent(),events);assert.equal(service.nas.lease,null);
  await assert.rejects(service.call({role:'designer',personId:'lv'},'task-review',{anchor:'2026-10'}),e=>e.status===403);
 }finally{service.store.close();const absolute=path.resolve(temporary);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep+'task-review-'));fs.rmSync(absolute,{recursive:true,force:true})}
});
