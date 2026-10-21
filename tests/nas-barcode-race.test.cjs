'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),nativeFs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Service}=require('../core/service.cjs'),{OperatorStore}=require('../operator/store.cjs'),{workbook}=require('../operator/test-fixture.cjs');
const {parseRequirement,patchBarcode,patchWorkbook,workflowFields}=require('../core/workbook.cjs'),{STAGES,transition}=require('../core/rules.cjs'),{digest}=require('../core/store.cjs');
const manager={role:'manager',personId:'zeng'},designer={role:'designer',personId:'hong'},filename='26090311-九芝堂-西红花-王燕-洪华.xlsx',code='6970855224164';
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nas-barcode-race-')),taskRoot=path.join(root,'requests'),assetRoot=path.join(root,'assets');await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);
 const service=await new Service(path.join(root,'db'),{host:'127.0.0.1',port:0}).start();t.after(async()=>{await service.stop();const absolute=path.resolve(root),temporary=path.resolve(os.tmpdir());assert.ok(absolute.startsWith(temporary+path.sep+'nas-barcode-race-'));await fs.rm(absolute,{recursive:true,force:true})});
 await service.call(manager,'configure',{taskRoot,assetRoot});await service.requirementsSync.stop();service.requirementsSync.stopped=false;
 const source=path.join(taskRoot,STAGES[1],filename);await fs.writeFile(source,workbook());const task=await service.importFile(workbook(),filename,{},1,true),current=()=>service.store.get('task',task.id),bytes=await fs.readFile(source);
 const initialJobs=new Set(service.store.all('job').map(j=>j.id)),jobs=()=>service.store.all('job').filter(j=>!initialJobs.has(j.id));
 const start=()=>service.call(designer,'action',{taskId:task.id,action:'start',version:current().version});
 return {root,taskRoot,source,dest:path.join(taskRoot,STAGES[2],filename),service,task:current(),current,bytes,jobs,start};
}
function assertUnchangedTask(f){assert.equal(f.current().state,1);assert.equal(f.current().code,f.task.code);assert.equal(f.current().version,f.task.version);assert.ok(!f.current().blocked)}

test('an operator barcode correction completed immediately before a workflow rename is retained and can continue after sync',async t=>{
 const f=await fixture(t),operator=await new OperatorStore(path.join(f.root,'operator')).init();await operator.configure({root:f.taskRoot,name:'王燕'});const own=operator.tasks[0],rename=fs.rename;let correctedBytes,intercepted=false;
 t.mock.method(fs,'rename',async(source,dest)=>{if(!intercepted&&source===f.source&&path.basename(dest).startsWith('.workbench-')){intercepted=true;await operator.correctCode(own.id,code,own.sourceHash);correctedBytes=await fs.readFile(f.source)}return rename(source,dest)});
 await assert.rejects(f.start(),/刚刚发生变化/);assert.equal(intercepted,true);assertUnchangedTask(f);assert.deepEqual(await fs.readFile(f.source),correctedBytes);assert.equal(parseRequirement(correctedBytes,filename).code,code);await assert.rejects(fs.access(f.dest));
 const [job]=f.jobs();assert.equal(job.status,'rolled-back');await assert.rejects(fs.access(job.backup));
 await f.service.requirementsSync.checkTask(f.task.id);assert.equal(f.current().code,code);assert.equal(f.current().workbookSyncIssue,null);const started=await f.start();assert.equal(started.state,2);assert.equal(started.code,code);assert.equal(parseRequirement(await fs.readFile(f.dest),filename).code,code);
});

test('a changed source discovered by the final hash check rolls back its journal without blocking the task or moving the saved file',async t=>{
 const f=await fixture(t),latest=patchBarcode(f.bytes,code),createReadStream=nativeFs.createReadStream,rename=fs.rename;let changed=false,moves=0;
 t.mock.method(nativeFs,'createReadStream',(file,...args)=>{if(file===f.source&&!changed){changed=true;nativeFs.writeFileSync(f.source,latest)}return createReadStream(file,...args)});
 t.mock.method(fs,'rename',async(source,dest)=>{if(source===f.source&&path.basename(dest).startsWith('.workbench-'))moves++;return rename(source,dest)});
 await assert.rejects(f.start(),/刚刚发生变化/);assert.equal(changed,true);assert.equal(moves,0);assertUnchangedTask(f);assert.deepEqual(await fs.readFile(f.source),latest);assert.equal(f.jobs()[0].status,'rolled-back');
 await f.service.requirementsSync.checkTask(f.task.id);assert.equal(f.current().code,code);assert.ok(!f.current().blocked);
});

test('a concurrent save recreating the source during rollback is never overwritten or removed and the displaced latest original remains backed up',async t=>{
 const f=await fixture(t),displaced=patchBarcode(f.bytes,code),concurrent=patchWorkbook(displaced,{E4:46269}),rename=fs.rename,unlink=fs.unlink;let intercepted=false,sourceUnlinks=0;
 t.mock.method(fs,'rename',async(source,dest)=>{if(!intercepted&&source===f.source&&path.basename(dest).startsWith('.workbench-')){intercepted=true;await fs.writeFile(source,displaced);await rename(source,dest);await fs.writeFile(source,concurrent);return}return rename(source,dest)});
 t.mock.method(fs,'unlink',async file=>{if(file===f.source)sourceUnlinks++;return unlink(file)});
 await assert.rejects(f.start(),/另一份保存.*备份/);assert.equal(intercepted,true);assert.equal(sourceUnlinks,0);assert.deepEqual(await fs.readFile(f.source),concurrent);await assert.rejects(fs.access(f.dest));
 const [job]=f.jobs();assert.equal(job.status,'prepared');assert.equal(job.phase,'moving');assert.deepEqual(await fs.readFile(job.backup),displaced);assert.equal(f.current().state,1);assert.equal(f.current().code,f.task.code);assert.match(f.current().blocked,/同步待恢复/);
 // Once the operator has preserved and moved the conflicting save, recovery
 // restores the displaced correction and clears only this journal's blockage.
 await fs.writeFile(path.join(f.root,'preserved-concurrent-save.xlsx'),concurrent);await fs.unlink(f.source);await f.service.nas.recoverJob(job);assert.ok(!f.current().blocked);assert.deepEqual(await fs.readFile(f.source),displaced);assert.equal(f.service.store.get('job',job.id).status,'rolled-back');await f.service.requirementsSync.checkTask(f.task.id);assert.equal(f.current().code,code);
});

test('unpublished journals recover the actual moved save across interruption, including an already restored copy',async t=>{
 for(const phase of ['moving','restoring'])await t.test(phase,async t=>{
  const f=await fixture(t),latest=patchBarcode(f.bytes,code),backup=path.join(path.dirname(f.source),'.workbench-'+crypto.randomUUID()+'.bak');await fs.writeFile(backup,latest);await fs.unlink(f.source);if(phase==='restoring')await fs.copyFile(backup,f.source,nativeFs.constants.COPYFILE_EXCL);
  const next=transition(f.task,designer,'start',{version:f.task.version}).task,job={id:crypto.randomUUID(),kind:'workbook',status:'prepared',phase,source:f.source,dest:f.dest,backup,originalHash:digest(f.bytes),nextHash:'0'.repeat(64),next,event:{kind:'start',actor:'hong'},...(phase==='restoring'?{recoveryHash:digest(latest)}:{})};f.service.store.put('job',job.id,job);
  await f.service.nas.recoverJob(job);assertUnchangedTask(f);assert.deepEqual(await fs.readFile(f.source),latest);assert.equal(f.service.store.get('job',job.id).status,'rolled-back');await assert.rejects(fs.access(backup));await assert.rejects(fs.access(f.dest));
 });
});

test('a journal without phase retains legacy completed-publication recovery',async t=>{
 const f=await fixture(t),next=transition(f.task,designer,'start',{version:f.task.version}),output=patchWorkbook(f.bytes,next.patch),backup=path.join(path.dirname(f.source),'.workbench-'+crypto.randomUUID()+'.bak');await fs.rename(f.source,backup);await fs.writeFile(f.dest,output);next.task.workbookHash=digest(output);next.task.workflowFields=workflowFields(output);
 const job={id:crypto.randomUUID(),kind:'workbook',status:'prepared',source:f.source,dest:f.dest,backup,originalHash:digest(f.bytes),nextHash:digest(output),next:next.task,event:{kind:'start',actor:'hong',body:{from:1,to:2}}};f.service.store.put('job',job.id,job);
 await f.service.nas.recoverJob(job);assert.equal(f.current().state,2);assert.equal(f.service.store.get('job',job.id).status,'done');assert.deepEqual(await fs.readFile(f.dest),output);await assert.rejects(fs.access(backup));
});
