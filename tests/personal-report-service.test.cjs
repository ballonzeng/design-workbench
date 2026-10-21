'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Service}=require('../core/service.cjs');
const at=value=>Date.parse(value+'+08:00');
const designer={role:'designer',personId:'lv'},colleague={role:'designer',personId:'liu'};
const week={frequency:'week',anchor:'2026-08-26'};
function fixture(t){
 const prefix=path.join(os.tmpdir(),'personal-report-service-'),dir=fs.mkdtempSync(prefix),service=new Service(dir);
 t.after(()=>{service.store.close();assert(path.resolve(dir).startsWith(path.resolve(prefix)));fs.rmSync(dir,{recursive:true,force:true})});
 return service;
}
function task(id,owner){return {id,owner,state:4,version:1,title:id+'任务',filename:id+'需求.xlsx',requestedAt:at('2026-08-24T09:00:00'),createdAt:at('2026-08-24T09:00:00'),assignedAt:at('2026-08-24T10:00:00'),completedAt:at('2026-08-26T12:00:00'),items:[{type:'creative',qty:2,points:4}]}}

test('personal report uses authenticated identity and returns no colleagues or events',async t=>{
 const service=fixture(t);t.mock.method(Date,'now',()=>at('2026-08-26T14:00:00'));
 service.store.put('task','mine',task('mine','lv'));service.store.put('task','colleague-secret',task('colleague-secret','liu'));service.store.put('task','unassigned-secret',task('unassigned-secret',null));
 service.store.event('confirm','liu','colleague-secret',{secret:'private-event'});
 service.store.event('confirm','lv','mine',{});
 const data=await service.call(designer,'personal-report-data',{...week,personId:'liu',owner:'liu',role:'manager',personName:'伪造姓名'});
 assert.deepEqual(Object.keys(data).sort(),['generatedAt','personId','personName','tasks','unavailable']);
 assert.equal(data.personId,'lv');assert.equal(data.personName,'吕慧芸');assert.equal(data.generatedAt,Date.now());
 assert.deepEqual(data.tasks.map(value=>value.id),['mine']);assert.equal(data.tasks[0].owner,'lv');assert.deepEqual(data.unavailable,[]);
 assert.doesNotMatch(JSON.stringify(data),/colleague-secret|unassigned-secret|private-event/);
});

test('historical ownership is resolved before filtering after a task is reassigned',async t=>{
 const service=fixture(t);let time=at('2026-08-26T14:00:00');t.mock.method(Date,'now',()=>time);
 const original=task('reassigned','lv');service.store.put('task',original.id,original);
 time=at('2026-09-02T10:00:00');service.store.put('task',original.id,{...original,owner:'liu',assignedAt:time,title:'后续修改',items:[{type:'creative',qty:6,points:12}]});
 const historical=await service.call(designer,'personal-report-data',week),others=await service.call(colleague,'personal-report-data',week);
 assert.equal(historical.tasks.length,1);assert.equal(historical.tasks[0].owner,'lv');assert.equal(historical.tasks[0].title,original.title);assert.equal(historical.tasks[0].items[0].points,4);assert.deepEqual(others.tasks,[]);
 assert.deepEqual((await service.call(designer,'personal-report-data',{frequency:'week',anchor:'2026-09-02'})).tasks,[]);
 assert.equal((await service.call(colleague,'personal-report-data',{frequency:'week',anchor:'2026-09-02'})).tasks[0].items[0].points,12);
});

test('unrestorable history reveals no task identity, filename or personal ownership claim',async t=>{
 const service=fixture(t);t.mock.method(Date,'now',()=>at('2026-09-02T10:00:00'));
 service.store.put('task','legacy-mine-secret',task('legacy-mine-secret','lv'));service.store.put('task','legacy-other-secret',task('legacy-other-secret','liu'));
 const mine=await service.call(designer,'personal-report-data',week),other=await service.call(colleague,'personal-report-data',week);
 assert.deepEqual(mine.tasks,[]);assert.deepEqual(other.tasks,[]);assert.equal(mine.unavailable.length,1);assert.deepEqual(mine.unavailable,other.unavailable);
 assert.deepEqual(Object.keys(mine.unavailable[0]),['reason']);assert.match(mine.unavailable[0].reason,/无法还原/);
 assert.doesNotMatch(JSON.stringify(mine),/legacy-mine-secret|legacy-other-secret|需求\.xlsx/);
});

test('personal report rejects managers, invalid accounts and removed designers before reading history',async t=>{
 const service=fixture(t);let reads=0;t.mock.method(service.store,'reportTasks',()=>{reads++;return {tasks:[],unavailable:[]}});
 await assert.rejects(service.call({role:'manager',personId:'zeng'},'personal-report-data',week),error=>error.status===403&&/设计师/.test(error.message));
 await assert.rejects(service.call({role:'anonymous',personId:'lv'},'personal-report-data',week),/无效账号/);
 await assert.rejects(service.call({role:'designer',personId:'unknown'},'personal-report-data',week),/无效账号/);
 service.store.put('removedMember','lv',{at:Date.now(),by:'zeng'});
 await assert.rejects(service.call(designer,'personal-report-data',week),error=>error.status===403&&/移出组织/.test(error.message));
 assert.equal(reads,0);
});

test('personal report validates all dates before requesting a historical snapshot',async t=>{
 const service=fixture(t);let reads=0;t.mock.method(service.store,'reportTasks',()=>{reads++;return {tasks:[],unavailable:[]}});
 const invalid=[
  {frequency:'day',anchor:'2026-08-26'},
  {frequency:'week',anchor:'2026-02-30'},
  {frequency:'month',anchor:'not-a-date'},
  {frequency:'custom',startDate:'2026-08-31',endDate:'2026-08-01'},
  {frequency:'custom',startDate:'2025-01-01',endDate:'2026-01-02'},
  {frequency:'custom',startDate:'2026-08-01',endDate:'2026-09-31'},
  {frequency:'custom',startDate:'2026-08-01'}
 ];
 for(const payload of invalid)await assert.rejects(service.call(designer,'personal-report-data',payload));
 assert.equal(reads,0);
});

test('personal report snapshots stop at the inclusive Beijing end date or generation time',async t=>{
 const service=fixture(t),now=at('2026-09-02T12:30:00'),cutoffs=[];t.mock.method(Date,'now',()=>now);
 t.mock.method(service.store,'reportTasks',cutoff=>{cutoffs.push(cutoff);return {tasks:[],unavailable:[]}});
 await service.call(designer,'personal-report-data',week);
 await service.call(designer,'personal-report-data',{frequency:'custom',startDate:'2026-08-27',endDate:'2026-08-28'});
 await service.call(designer,'personal-report-data',{frequency:'month',anchor:'2026-09-01'});
 assert.deepEqual(cutoffs,[at('2026-08-31T00:00:00')-1,at('2026-08-29T00:00:00')-1,now]);
});

test('snapshot advertises personal report protocol support',async t=>{
 const service=fixture(t),snapshot=await service.call(designer,'snapshot');
 assert.equal(snapshot.personalReportVersion,1);
});
