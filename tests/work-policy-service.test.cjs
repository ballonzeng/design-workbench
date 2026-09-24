'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Service}=require('../core/service.cjs'),{DEFAULT}=require('../core/work-calendar.cjs');
test('calendar previews are read-only; saves are manager-only, version checked, and month scoped',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'work-policy-')),service=new Service(dir),manager={role:'manager',personId:'zeng'},designer={role:'designer',personId:'hong'};
 try{
 const policy={...DEFAULT,exceptions:{'2026-09-20':false}};
 const preview=await service.call(manager,'work-calendar-preview',{month:'2026-09',policy});assert.equal(preview.calendar.points,134.4);assert.equal(service.store.get('setting','workPolicies'),null);
 await assert.rejects(service.call(designer,'work-policy-save',{month:'2026-09',policy,revision:0}),/负责人/);
 await service.call(manager,'work-policy-save',{month:'2026-09',policy,revision:0});
 await assert.rejects(service.call(manager,'work-policy-save',{month:'2026-09',policy,revision:0}),/已更新/);
 const saved=await service.call(manager,'work-calendar-preview',{month:'2026-09'});assert.equal(saved.calendar.points,134.4);
 await service.call(manager,'work-policy-save',{month:'2026-10',policy:{...DEFAULT,dailyPoints:8},revision:1});
 assert.equal((await service.call(manager,'work-calendar-preview',{month:'2026-09'})).calendar.points,134.4);
 const report=await service.call(manager,'report-data',{frequency:'month',anchor:'2026-09-01'});assert.equal(report.workPolicies['2026-09'].exceptions['2026-09-20'],false);
 assert.equal(service.store.recent().filter(e=>e.kind==='work-policy-updated').length,2);
 }finally{service.store.close();assert(dir.startsWith(path.join(os.tmpdir(),'work-policy-')));fs.rmSync(dir,{recursive:true,force:true})}
});
test('report-data preserves IDs from legacy removed-member records',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'work-policy-')),service=new Service(dir);
 try{
  service.store.put('removedMember','hong',{at:100,by:'zeng'});
  const report=await service.call({role:'manager',personId:'zeng'},'report-data',{frequency:'month',anchor:'2026-09-01'});
  assert.deepEqual(report.removedPeople,[{at:100,by:'zeng',personId:'hong'}]);
  assert.deepEqual(service.store.removedMembers(),report.removedPeople);
 }finally{service.store.close();assert(dir.startsWith(path.join(os.tmpdir(),'work-policy-')));fs.rmSync(dir,{recursive:true,force:true})}
});
