'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {Service}=require('../core/service.cjs');
const manager={role:'manager',personId:'zeng'},designer={role:'designer',personId:'lv'};
function setup(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'service-archive-retry-')),service=new Service(dir);
 t.after(()=>{service.store.close();assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));assert.ok(path.basename(dir).startsWith('service-archive-retry-'));fs.rmSync(dir,{recursive:true,force:true})});
 return service;
}
function task(id='pending',extra={}){return {id,state:4,sealed:false,version:7,owner:'lv',title:'合成创意图',product:'合成商品',brand:'测试品牌',code:'6999999999901',filename:'合成需求.xlsx',items:[{id:'row-6',row:6,type:'complex',qty:3,points:4.5}],archiveRound:2,...extra}}
function upload(t,id='batch',extra={}){return {id,taskId:t.id,actor:t.owner,archiveRound:t.archiveRound,status:'publishing',files:[{id:'0',name:'合成文件.txt',size:1}],received:{0:true},...extra}}
const payload=t=>({taskId:t.id,version:t.version,action:'rollback',confirmed:true});

test('rollback returns a publishing conflict immediately despite a busy store, without reading the workbook',async t=>{
 const service=setup(t),current=task();service.store.put('task',current.id,current);service.store.put('upload','batch',upload(current,'batch',{error:'EPERM rename 原需求表'}));
 let checks=0,release,entered;
 service.requirementsSync={checkTask:async()=>{checks++;throw Error('Must not inspect a publishing task')}};
 const waiting=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const held=service.store.exclusive(async()=>{entered();await waiting});await started;
 try{
  let rejection;
  const call=service.call(manager,'action',payload(current)).catch(e=>{rejection=e});
  await new Promise(setImmediate);
  assert.ok(rejection,'The rejection must arrive before releasing the write queue');assert.equal(rejection.status,409);assert.match(rejection.message,/等待归档回填恢复/);assert.match(rejection.message,/EPERM/);assert.equal(checks,0);
  assert.deepEqual(service.store.get('task',current.id),current);assert.equal(service.store.events(current.id).length,0);await call;
 }finally{release();await held}
});

test('fast rollback conflict retains manager authorization and detects an in-flight file before it publishes',async t=>{
 const service=setup(t),current=task();service.store.put('task',current.id,current);service.store.put('upload','batch',upload(current,'batch',{status:'uploading'}));service.assets.inflight.add('batch/0');
 service.requirementsSync={checkTask:async()=>{throw Error('Must not inspect active transmission')}};
 await assert.rejects(service.call(designer,'action',payload(current)),e=>e.status===403);
 await assert.rejects(service.call(manager,'action',payload(current)),e=>e.status===409&&/写入或传输/.test(e.message));assert.deepEqual(service.store.get('task',current.id),current);
});

test('rollback checks publication again under the lock after the workbook check',async t=>{
 const service=setup(t),current=task();service.store.put('task',current.id,current);let checks=0;
 service.requirementsSync={checkTask:async()=>{checks++;service.store.put('upload','batch',upload(current));return {checked:true}}};
 await assert.rejects(service.call(manager,'action',payload(current)),e=>e.status===409&&/写入或传输/.test(e.message));assert.equal(checks,1);assert.deepEqual(service.store.get('task',current.id),current);assert.equal(service.store.events(current.id).length,0);
});

test('prior archive rounds do not block rollback preflight and stale task versions still fail',async t=>{
 const service=setup(t),current=task();service.store.put('task',current.id,current);service.store.put('upload','batch',upload(current,'batch',{archiveRound:1}));let checks=0;
 service.requirementsSync={checkTask:async()=>{checks++;return {checked:true}}};
 await assert.rejects(service.call(manager,'action',{...payload(current),version:current.version-1}),/任务已更新/);assert.equal(checks,1);assert.deepEqual(service.store.get('task',current.id),current);
});

test('background recovery failures do not starve unrelated uploads and remain visible only to managers',async t=>{
 const service=setup(t),blocked=task('blocked',{blocked:'文件同步待恢复'}),ready=task('ready');
 for(const current of [blocked,ready]){service.store.put('task',current.id,current);service.store.put('upload',current.id,upload(current,current.id))}
 const calls=[];
 service.nas.recover=async()=>{calls.push('workbooks');throw Error('Unrelated workbook permission failure')};
 service.assets.recover=async()=>{calls.push('assets');throw Error('One asset maintenance failed')};
 service.assets.commit=async(id,actor)=>{calls.push('commit:'+id);assert.equal(id,'ready');assert.deepEqual(actor,{role:'designer',personId:'lv'});const u=service.store.get('upload',id);service.store.put('upload',id,{...u,status:'done'});return ready};
 const report=await service.store.exclusive(()=>service.retryArchives());
 assert.deepEqual(calls,['workbooks','assets','commit:ready']);assert.equal(report.restored,1);assert.deepEqual(report.errors,[{phase:'workbooks',message:'Unrelated workbook permission failure'},{phase:'assets',message:'One asset maintenance failed'}]);assert.equal(service.store.get('upload','ready').status,'done');assert.equal(service.store.get('upload','blocked').status,'publishing');assert.deepEqual(service.store.get('task','blocked'),blocked);
 assert.deepEqual(service.snapshot(manager).archiveRetry,report);assert.equal(service.snapshot(designer).archiveRetry,undefined);
 service.nas.recover=async()=>{};service.assets.recover=async()=>{};
 const recovered=await service.store.exclusive(()=>service.retryArchives());assert.equal(recovered.restored,0);assert.deepEqual(recovered.errors,[]);assert.deepEqual(service.snapshot(manager).archiveRetry,recovered);
});

test('an unresolved workbook journal blocks only its own upload even before its task is marked blocked',async t=>{
 const service=setup(t),pending=task('unresolved'),ready=task('ready');
 for(const current of [pending,ready]){service.store.put('task',current.id,current);service.store.put('upload',current.id,upload(current,current.id))}
 const journal={id:'unresolved-journal',kind:'workbook',status:'prepared',phase:'publishing',next:{id:pending.id},error:'Cannot access workbook backup'};service.store.put('job',journal.id,journal);
 service.nas.recover=async()=>{throw Error('Cannot access workbook backup')};service.assets.recover=async()=>{};
 const committed=[];service.assets.commit=async(id)=>{committed.push(id);service.store.put('upload',id,{...service.store.get('upload',id),status:'done'});return service.store.get('task',id)};
 const report=await service.store.exclusive(()=>service.retryArchives());assert.equal(report.restored,1);assert.deepEqual(committed,['ready']);assert.equal(service.store.get('task',pending.id).blocked,undefined);assert.equal(service.store.get('upload',pending.id).status,'publishing');assert.equal(service.store.get('job',journal.id).status,'prepared');
 // A caller explicitly requesting this task must not force publication either.
 assert.equal(await service.assets.retryPending(pending.id),0);assert.deepEqual(committed,['ready']);
 service.store.put('job',journal.id,{...journal,status:'rolled-back'});
 assert.equal(await service.assets.retryPending(pending.id),1);assert.deepEqual(committed,['ready','unresolved']);assert.equal(service.store.get('upload',pending.id).status,'done');
});
