'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Service}=require('../core/service.cjs'),{prepareHistoricalTasks}=require('../core/historical-tasks.cjs'),W=require('../core/work-calendar.cjs');
const H=W.HOUR,at=value=>Date.parse(value+'+08:00'),friday=at('2026-10-09T17:00:00'),monday=at('2026-10-12T10:00:00');
function fixture(id,extra={}){return {id,state:2,sealed:false,owner:'hong',version:1,title:id,product:'耗时验证产品',brand:'测试品牌',code:'6970855224163',operator:'测试运营',filename:id+'.xlsx',items:[{id:'row-6',row:6,type:'basic',typeName:'基础元素替换',qty:1,points:.8}],createdAt:friday,requestedAt:friday,assignedAt:friday,updatedAt:monday,startedAt:friday,reviewAt:null,elapsedMs:65*H,runningSince:null,timingTracked:true,timingIncomplete:false,workIntervals:[{owner:'hong',start:friday,end:monday}],...extra}}
function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-duration-service-')),service=new Service(dir);t.after(()=>{service.store.close();const resolved=path.resolve(dir);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'task-duration-service-'));fs.rmSync(resolved,{recursive:true,force:true})});return service}
function snapshotAt(service,actor,when=monday){const realNow=Date.now;try{Date.now=()=>when;return service.snapshot(actor)}finally{Date.now=realNow}}

test('manager and designer snapshots deliver effective durations, preserving raw 65-hour counters and excluding makeup Saturday',t=>{
 const service=setup(t);service.store.put('task','weekend',fixture('weekend'));service.store.put('task','other-owner',fixture('other-owner',{owner:'lv'}));
 service.store.put('task','saturday-only',fixture('saturday-only',{startedAt:at('2026-10-10T09:00:00'),elapsedMs:9*H,workIntervals:[{owner:'hong',start:at('2026-10-10T09:00:00'),end:at('2026-10-10T18:00:00')}]}));
 const before=service.store.all('task'),writes=service.store.db.prepare('SELECT total_changes() AS n').get().n;
 assert.equal(W.dayInfo('2026-10-10').working,true,'planning calendar still includes official makeup Saturday');
 for(const role of ['manager','designer']){
  const snapshot=snapshotAt(service,{role,personId:role==='manager'?'zeng':'hong'}),task=snapshot.tasks.find(t=>t.id==='weekend');
  assert.equal(snapshot.durationCalculationVersion,1);assert.equal(task.elapsedMs,65*H);assert.equal(task.designTiming.source,'recorded');assert.equal(task.designTiming.complete,true);assert.equal(task.designTiming.ms,2*H);assert.equal(task.designTiming.displayMs,2*H);assert.equal(task.effectiveElapsedMs,2*H);assert.equal(task.effectiveTimingComplete,true);assert.equal(task.designTiming.intervals,undefined,'snapshot strips large internal interval arrays');
  assert.equal(snapshot.tasks.find(t=>t.id==='saturday-only').designTiming.displayMs,0);assert.equal(snapshot.tasks.some(t=>t.id==='other-owner'),role==='manager');
 }
 assert.equal(service.nas.lease,null);assert.deepEqual(service.store.all('task'),before);assert.equal(service.store.db.prepare('SELECT total_changes() AS n').get().n,writes,'snapshot derivation must not write corrected values to saved raw records');
});

test('snapshots keep partial, estimated and unknown evidence distinct from complete design hours',t=>{
 const service=setup(t);
 for(const task of [fixture('partial',{importedTiming:true}),fixture('estimate',{timingTracked:false,importedTiming:true,workIntervals:[],reviewAt:monday}),fixture('unknown',{timingTracked:false,workIntervals:[],startedAt:null})])service.store.put('task',task.id,task);
 for(const role of ['manager','designer']){
  const snapshot=snapshotAt(service,{role,personId:role==='manager'?'zeng':'hong'}),find=id=>snapshot.tasks.find(t=>t.id===id);
  const partial=find('partial');assert.equal(partial.designTiming.source,'partial');assert.equal(partial.designTiming.complete,false);assert.equal(partial.designTiming.ms,null);assert.equal(partial.designTiming.recordedMs,2*H);assert.equal(partial.effectiveTimingComplete,false);assert.match(partial.designTiming.label,/不完整/);
  const estimate=find('estimate');assert.equal(estimate.designTiming.source,'span-estimate');assert.equal(estimate.designTiming.complete,false);assert.equal(estimate.designTiming.ms,null);assert.equal(estimate.designTiming.estimatedMs,2*H);assert.match(estimate.designTiming.label,/推算/);assert.equal(estimate.effectiveElapsedMs,null);
  const unknown=find('unknown');assert.equal(unknown.designTiming.source,'unknown');assert.equal(unknown.designTiming.displayMs,null);assert.equal(unknown.designTiming.ms,null);assert.equal(unknown.effectiveElapsedMs,null);assert.match(unknown.designTiming.label,/未记录/);
 }
});

test('confirmation wait uses effective hours; history supplements remain unknown and manager-only',t=>{
 const service=setup(t),waiting=fixture('waiting',{state:3,startedAt:at('2026-10-09T16:00:00'),reviewAt:friday,elapsedMs:H,workIntervals:[{owner:'hong',start:at('2026-10-09T16:00:00'),end:friday}]});service.store.put('task',waiting.id,waiting);
 const historical=prepareHistoricalTasks([{owner:'hong',product:'补录包装',qty:1,completedDate:'2026-10-09'}],{now:monday,actor:'zeng'}).records[0];service.store.put('historicalTask',historical.id,historical);
 for(const role of ['manager','designer']){
  const snapshot=snapshotAt(service,{role,personId:role==='manager'?'zeng':'hong'}),task=snapshot.tasks.find(t=>t.id==='waiting');assert.equal(task.confirmationWaitingMs,2*H);assert.equal(task.designTiming.displayMs,H);
  const row=snapshot.tasks.find(t=>t.id===historical.id);
  if(role==='designer')assert.equal(row,undefined);else{assert.equal(row.designTiming.source,'unknown');assert.equal(row.designTiming.displayMs,null);assert.equal(row.confirmationWaitingMs,null);assert.match(row.designTiming.reason,/历史补录/)}
 }
});

test('analysis export receives two effective hours rather than raw 65 hours and leaves incomplete cumulative time blank',()=>{
 const {createReport}=require('../core/report.cjs');
 const tasks=[fixture('recorded',{state:4,reviewAt:monday,completedAt:monday}),fixture('partial',{state:4,reviewAt:monday,completedAt:monday,importedTiming:true}),fixture('estimate',{state:4,reviewAt:monday,completedAt:monday,timingTracked:false,workIntervals:[],importedTiming:true}),fixture('unknown',{state:4,completedAt:monday,startedAt:null,timingTracked:false,workIntervals:[]}),fixture('waiting',{state:3,startedAt:at('2026-10-09T16:00:00'),reviewAt:friday,elapsedMs:H,workIntervals:[{owner:'hong',start:at('2026-10-09T16:00:00'),end:friday}]})];
 const report=createReport(tasks,[],{frequency:'month',anchor:'2026-10-01',generatedAt:monday}),sheet=report.sheets.find(s=>s.name==='任务明细'),find=id=>sheet.rows.find(r=>r[0]===id),cell=(row,label)=>row[sheet.rows[0].indexOf(label)];
 assert.equal(cell(find('recorded'),'累计记录计时（小时）').v,2);assert.equal(cell(find('recorded'),'需求至确认（小时）').v,2);assert.equal(cell(find('recorded'),'本期有效设计记录（小时）').v,2);
 for(const id of ['partial','estimate','unknown'])assert.equal(cell(find(id),'累计记录计时（小时）'),'','unknown complete hours must remain blank');
 assert.match(cell(find('partial'),'计时完整性'),/不完整/);assert.match(cell(find('estimate'),'计时完整性'),/推算/);assert.match(cell(find('unknown'),'计时完整性'),/未记录/);
 const waiting=report.sheets.find(s=>s.name==='待处理环节').rows.find(r=>r[0]==='waiting');assert.equal(waiting[5].v,2);
});
