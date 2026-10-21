'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {zipSync,strToU8}=require('fflate'),{Service}=require('../core/service.cjs'),{digest}=require('../core/store.cjs');
const {workbook}=require('../operator/test-fixture.cjs'),{parseRequirement,identifyWorkbook,patchWorkbook,workflowFields,unpack}=require('../core/workbook.cjs'),{STAGES}=require('../core/rules.cjs');
const manager={role:'manager',personId:'zeng'},owner={role:'designer',personId:'zhu'};
async function fixture(t,{delivery=false}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'member-offboarding-')),taskRoot=path.join(root,'requests'),assetRoot=path.join(root,'assets');await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);
 const service=new Service(path.join(root,'db'));t.after(async()=>{await service.stop();const target=path.resolve(root);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep+'member-offboarding-'));await fs.rm(target,{recursive:true,force:true})});await service.nas.connect({taskRoot,assetRoot});
 const addTask=async(title='西洋参',withDelivery=false)=>{
  const id=crypto.randomUUID(),filename='26090311-九芝堂-'+title+'-王燕-朱文梅.xlsx',wb=unpack(workbook());wb.entries[wb.status.file]=strToU8(wb.status.content.replaceAll('西红花',title));
  const bytes=identifyWorkbook(patchWorkbook(Buffer.from(zipSync(wb.entries)),{G4:'朱文梅',H4:46268,I4:12,J4:46268,K4:13,M4:46268,N4:14}),id),parsed=parseRequirement(bytes,filename),file=path.join(taskRoot,STAGES[4],filename);
  const task={...parsed,id,owner:'zhu',state:4,version:7,sealed:false,deliveries:[],archiveRound:0,assignmentId:crypto.randomUUID(),assignedAt:parsed.templateTimes.assignedAt,startedAt:parsed.templateTimes.startedAt,reviewAt:parsed.templateTimes.reviewAt,completedAt:parsed.templateTimes.completedAt,completedMonth:'2026-09',elapsedMs:123456,workbookHash:digest(bytes),workflowFields:workflowFields(bytes),ratings:{quality:[{row:6,value:80}],timeliness:'满意'}};await fs.writeFile(file,bytes);
  let finalFile,finalBytes;
  if(withDelivery){const assetId=crypto.randomUUID();finalFile=path.join(assetRoot,assetId+'.txt');finalBytes=Buffer.from('verified final design output');await fs.writeFile(finalFile,finalBytes);task.deliveries=[{id:assetId,category:'main',path:assetRoot,at:task.completedAt}];service.store.put('asset',assetId,{id:assetId,taskId:id,author:'zhu',category:'main',files:[{name:'final.txt',path:finalFile,size:finalBytes.length,sha256:digest(finalBytes)}]})}
  service.store.put('task',id,task);return {task,file,bytes,finalFile,finalBytes,current:()=>service.store.get('task',id)};
 };
 const one=await addTask('西洋参',delivery);return {root,taskRoot,assetRoot,service,addTask,...one,remove:()=>service.call(manager,'member-remove',{personId:'zhu'}),finish:version=>service.call(manager,'archive-finish',{taskId:one.task.id,version:version??one.current().version})};
}

test('removing a departed designer preserves unarchived completed demands, ownership, ratings and all history without inventing a seal',async t=>{
 const f=await fixture(t),second=await f.addTask('已上传待封存',true),before=f.service.store.all('task');
 f.service.store.event('approved','zeng',f.task.id,{score:80});const history=f.service.store.events(f.task.id);
 for(const kind of ['token','pair']){f.service.store.put(kind,'departed-'+kind,{personId:'zhu',revoked:false,used:false});f.service.store.put(kind,'other-'+kind,{personId:'hong',revoked:false,used:false})}
 let ended=0,otherEnded=0;f.service.streams.set('departed',{actor:owner,res:{write(){},end(){ended++}}});f.service.streams.set('other',{actor:{role:'designer',personId:'hong'},res:{write(){},end(){otherEnded++}}});
 assert.deepEqual(await f.remove(),{removed:true});assert.equal(ended,1);assert.equal(otherEnded,0);assert.equal(f.service.streams.has('departed'),false);assert.deepEqual(f.service.store.all('task'),before);assert.deepEqual(f.service.store.events(f.task.id),history);assert.deepEqual(await fs.readFile(f.file),f.bytes);assert.deepEqual(await fs.readFile(second.file),second.bytes);assert.equal(f.current().sealed,false);assert.deepEqual(f.current().deliveries,[]);
 for(const kind of ['token','pair']){assert.equal(f.service.store.get(kind,'departed-'+kind).revoked,true);assert.equal(f.service.store.get(kind,'departed-'+kind).used,true);assert.equal(f.service.store.get(kind,'other-'+kind).revoked,false)}
 assert.equal(f.service.snapshot(manager).people.find(p=>p.id==='zhu').removed,true);await assert.rejects(f.service.call(owner,'snapshot'),/移出组织/);await assert.rejects(f.service.call(manager,'pair-code',{personId:'zhu',host:'127.0.0.1'}),/移出组织/);
 await assert.rejects(f.finish(),/至少一类最终产物/);assert.equal(f.current().sealed,false);
});

test('pending-design, in-design and review work still must be reassigned before member removal',async t=>{
 for(const state of [1,2,3])await t.test('stage '+state,async t=>{const f=await fixture(t),task={...f.current(),state};f.service.store.put('task',task.id,task);await assert.rejects(f.remove(),/未完成.*改派/);assert.equal(f.service.store.get('removedMember','zhu'),null);assert.deepEqual(f.current(),task)});
});

test('member removal retains active upload and in-flight transfer guards',async t=>{
 for(const mode of ['uploading','publishing','inflight'])await t.test(mode,async t=>{
  const f=await fixture(t),upload={id:'pending-upload',taskId:f.task.id,actor:'zhu',archiveRound:0,status:mode==='inflight'?'done':mode};f.service.store.put('upload',upload.id,upload);if(mode==='inflight')f.service.assets.inflight.add(upload.id+'/file-0');
  await assert.rejects(f.remove(),/上传待处理/);assert.equal(f.service.store.get('removedMember','zhu'),null);assert.deepEqual(f.service.store.get('upload',upload.id),upload);assert.equal(f.current().sealed,false);
 });
});

test('manager assistance seals only a removed member task after checking the existing files and records the real manager',async t=>{
 const f=await fixture(t,{delivery:true});await assert.rejects(f.finish(),/仅任务设计师/);await assert.rejects(f.service.assets.finish(f.task.id,{role:'operator',personId:'zeng'},f.current().version),/仅任务设计师/);await assert.rejects(f.service.assets.finish(f.task.id,{role:'designer',personId:'hong'},f.current().version),/自己/);
 await f.remove();const before=f.current(),sealed=await f.finish();assert.equal(sealed.sealed,true);assert.equal(sealed.owner,'zhu');for(const key of ['state','completedAt','completedMonth','ratings','items','deliveries','elapsedMs','assignmentId','assignedAt','startedAt','reviewAt'])assert.deepEqual(sealed[key],before[key],key);assert.deepEqual(await fs.readFile(f.file),f.bytes);assert.deepEqual(await fs.readFile(f.finalFile),f.finalBytes);
 const [event]=f.service.store.events(f.task.id);assert.equal(event.kind,'sealed');assert.equal(event.actor,'zeng');assert.equal(event.body.assistedFor,'zhu');assert.deepEqual(event.body.categories,['main']);assert.equal((await f.finish(before.version)).version,sealed.version);assert.equal(f.service.store.events(f.task.id).filter(e=>e.kind==='sealed').length,1);
 await assert.rejects(f.service.call(owner,'archive-finish',{taskId:f.task.id,version:sealed.version}),/移出组织/);
});

test('manager assistance never bypasses missing or changed files, stale versions, workbook locks or original synchronization checks',async t=>{
 const cases=[
  ['missing final file',async f=>fs.unlink(f.finalFile),/缺少文件/],
  ['changed final bytes',async f=>fs.writeFile(f.finalFile,Buffer.alloc(f.finalBytes.length,1)),/文件已改变/],
  ['changed final size',async f=>fs.writeFile(f.finalFile,'short'),/文件已改变/],
  ['saved workbook edit',async f=>fs.writeFile(f.file,patchWorkbook(f.bytes,{F4:12})),/原需求表已修改/],
  ['Excel owner lock',async f=>fs.writeFile(path.join(path.dirname(f.file),'~$'+f.task.filename),'active'),/Excel|占用/],
  ['workbook sync issue',async f=>f.service.store.put('task',f.task.id,{...f.current(),workbookSyncIssue:{message:'原表待核对'}}),/原表异常/],
  ['unfinished workflow journal',async f=>f.service.store.put('task',f.task.id,{...f.current(),blocked:'文件同步待恢复'}),/未恢复的文件同步/],
  ['active upload',async f=>f.service.store.put('upload','active',{id:'active',taskId:f.task.id,actor:'zhu',archiveRound:0,status:'uploading'}),/仍有产物正在上传/]
 ];
 for(const [name,mutate,expected]of cases)await t.test(name,async t=>{const f=await fixture(t,{delivery:true});await f.remove();await mutate(f);await assert.rejects(f.finish(),expected);assert.equal(f.current().sealed,false);assert.equal(f.service.store.events(f.task.id).filter(e=>e.kind==='sealed').length,0)});
 await t.test('stale version',async t=>{const f=await fixture(t,{delivery:true});await f.remove();await assert.rejects(f.finish(f.current().version-1),/任务已更新/);assert.equal(f.current().sealed,false)});
});
