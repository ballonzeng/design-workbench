'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Readable}=require('node:stream'),{zipSync,strToU8}=require('fflate');
const {workbook}=require('../operator/test-fixture.cjs'),{Store,digest}=require('../core/store.cjs'),{Nas,fileHash,exists}=require('../core/nas.cjs'),{Assets}=require('../core/assets.cjs');
const {unpack,parseRequirement,identifyWorkbook,workflowFields}=require('../core/workbook.cjs'),R=require('../core/rules.cjs');
const actor={role:'designer',personId:'hong'},filename='26090311-合成品牌-权限恢复-测试运营-洪华.xlsx',folder='0903-洪华-主图';
function completedWorkbook(id){
 const wb=unpack(workbook());let xml=wb.status.content;
 const cells={D4:'测试运营',H4:46268,I4:12,J4:46268,K4:13,M4:46268,N4:14,B6:'合成品牌',C6:'合成商品',D6:'6999999999901',F6:'单图任务（复杂元素替换）',G6:3,J6:80,K6:'满意'};
 for(const [address,value] of Object.entries(cells)){
  const expression=new RegExp('<c\\b(?=[^>]*\\br="'+address+'")[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)');assert.match(xml,expression);
  const encoded=typeof value==='number'?'<v>'+value+'</v>':'<is><t>'+String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</t></is>';
  xml=xml.replace(expression,'<c r="'+address+'"'+(typeof value==='number'?'':' t="inlineStr"')+'>'+encoded+'</c>');
 }
 wb.entries[wb.status.file]=strToU8(xml);return identifyWorkbook(Buffer.from(zipSync(wb.entries)),id);
}

test('published assets survive an EPERM workbook rename and automatic retry commits the original batch exactly once',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'archive-permission-retry-')),taskRoot=path.join(root,'requests'),assetRoot=path.join(root,'assets');
 await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);const store=new Store(path.join(root,'db')),nas=new Nas(store),assets=new Assets(store,nas);
 t.after(async()=>{await nas.release();store.close();const resolved=path.resolve(root);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith('archive-permission-retry-'));await fs.rm(resolved,{recursive:true,force:true})});
 await nas.connect({taskRoot,assetRoot});const id=crypto.randomUUID(),original=completedWorkbook(id),parsed=parseRequirement(original,filename),completedAt=parsed.templateTimes.completedAt;
 const task={...parsed,id,workbookTaskId:id,state:4,owner:actor.personId,version:7,sealed:false,completedAt,completedMonth:R.monthKey(completedAt),assignedAt:parsed.templateTimes.assignedAt,startedAt:parsed.templateTimes.startedAt,reviewAt:parsed.templateTimes.reviewAt,elapsedMs:456789,assignmentId:crypto.randomUUID(),receivedAt:101,readAt:102,confirmationMethod:'合成运营确认',confirmedBy:'nas',workflowFields:workflowFields(original),workbookHash:digest(original)};
 store.put('task',id,task);const current=()=>store.get('task',id),source=nas.taskPath(task);await fs.writeFile(source,original);const before=current(),beforeStat=await fs.stat(source);assert.equal(R.total(before),4.5);
 // Existing PNG bytes are copied unchanged; the PSD header is a source-format fixture.
 const image=await fs.readFile(path.join(__dirname,'../assets/icon-manager.png')),bytes=[Buffer.concat([Buffer.from([56,66,80,83,0,1]),Buffer.alloc(24),Buffer.from('synthetic editable source')]),image,image,image];
 const files=bytes.map((bytes,index)=>({relativePath:index?'主图0'+index+'.png':'合成源稿.psd',size:bytes.length,sha256:digest(bytes)}));
 const upload=await assets.prepare(before,null,actor,{selfChecked:true,delivery:{version:1,namingVersion:2,folder,directories:[]},files});
 for(const file of upload.files)await assets.receive(upload.id,file.id,actor,Readable.from([bytes[Number(file.id)]]),file.size);
 const received=store.get('upload',upload.id).received,rename=fs.rename;let denied=0;
 const fault=t.mock.method(fs,'rename',async(from,to)=>{
  if(String(from)===source&&/^\.workbench-.*\.bak$/.test(path.basename(String(to)))){denied++;const error=new Error('EPERM: operation not permitted, rename synthetic requirement');Object.assign(error,{code:'EPERM',syscall:'rename',path:from,dest:to});throw error}
  return rename(from,to);
 });
 await assert.rejects(assets.commit(upload.id,actor),error=>error.code==='EPERM'&&/NAS.*重命名/.test(error.message)&&/无需重传/.test(error.message));assert.equal(denied,1);
 assert.deepEqual(current(),before,'The uncommitted workbook journal must not change business state');assert.deepEqual(await fs.readFile(source),original);assert.equal(await fileHash(source),before.workbookHash);assert.equal((await fs.stat(source)).mtimeMs,beforeStat.mtimeMs);
 const pending=store.get('upload',upload.id);assert.equal(pending.status,'publishing');assert.deepEqual(pending.received,received);assert.match(pending.error,/EPERM/);assert.equal(Object.keys(pending.published).length,bytes.length);assert.equal(store.all('asset').length,0);assert.equal(store.events(id).length,0);
 const failedJobs=store.all('job');assert.equal(failedJobs.length,1);assert.equal(failedJobs[0].status,'rolled-back');assert.equal(failedJobs[0].phase,'moving');assert.equal(await exists(failedJobs[0].backup),false);assert.deepEqual((await fs.readdir(path.dirname(source))).filter(name=>/^\.workbench-.*\.bak$/.test(name)),[]);
 const published=await Promise.all(pending.files.map(async file=>{const target=pending.published[file.id],stat=await fs.stat(target);assert.equal(await fileHash(target),file.sha256);assert.equal(await fileHash(path.join(pending.stage,file.id+'.part')),file.sha256);return {path:target,size:stat.size,mtimeMs:stat.mtimeMs,sha256:file.sha256}}));
 fault.mock.restore();
 // This is the same automatic recovery sequence as the host timer, with no reselect/retransfer.
 await nas.recover();await assets.recover();assert.equal(await assets.retryPending(),1);
 const after=current(),done=store.get('upload',upload.id),record=store.get('asset',upload.id);
 assert.equal(done.status,'done');assert.equal(done.error,null);assert.equal(after.state,4);assert.equal(after.sealed,false);assert.equal(after.version,before.version+1);assert.equal(after.deliveries.length,1);assert.equal(after.deliveries[0].id,upload.id);assert.equal(after.deliveries[0].category,'main');assert.equal(store.all('asset').length,1);assert.equal(record.taskId,id);assert.equal(record.files.length,bytes.length);assert.deepEqual(done.received,received);assert.deepEqual(done.published,pending.published);
 for(const key of ['id','owner','assignmentId','assignedAt','receivedAt','readAt','startedAt','reviewAt','completedAt','completedMonth','elapsedMs','ratings','confirmationMethod','confirmedBy','items'])assert.deepEqual(after[key],before[key],key);assert.equal(R.total(after),4.5);
 const saved=await fs.readFile(source),wb=unpack(saved);assert.equal(wb.status.cells.L4.value,'主图：'+after.deliveries[0].path);assert.equal(digest(saved),after.workbookHash);assert.deepEqual(parseRequirement(saved,filename).ratings,before.ratings);
 for(const file of published){const stat=await fs.stat(file.path);assert.equal(await fileHash(file.path),file.sha256);assert.equal(stat.size,file.size);assert.equal(stat.mtimeMs,file.mtimeMs,'Retry must reuse published bytes without rewriting them')}
 assert.equal(await exists(pending.stage),false);const jobs=store.all('job');assert.equal(jobs.length,2);assert.equal(jobs.filter(job=>job.status==='done').length,1);assert.equal(jobs.filter(job=>job.status==='rolled-back').length,1);assert.ok((await Promise.all(jobs.map(job=>exists(job.backup)))).every(value=>!value));
 const committedEvents=store.events(id).filter(event=>event.kind==='asset-archived');assert.equal(committedEvents.length,1);assert.equal(committedEvents[0].body.assetId,upload.id);
 assert.equal(await assets.retryPending(),0);await assets.commit(upload.id,actor);assert.equal(current().version,after.version);assert.equal(current().deliveries.length,1);assert.equal(store.all('asset').length,1);assert.equal(store.all('job').length,2);assert.equal(store.events(id).filter(event=>event.kind==='asset-archived').length,1);
});
