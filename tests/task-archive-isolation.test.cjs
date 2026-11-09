'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {Store,digest}=require('../core/store.cjs'),{Nas,fileHash}=require('../core/nas.cjs'),{Assets}=require('../core/assets.cjs');
const R=require('../core/rules.cjs');
const actor={role:'designer',personId:'lv'},folder='1028-吕慧芸-主图';

async function setup(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'task-archive-isolation-')),db=path.join(root,'db'),taskRoot=path.join(root,'requests'),assetRoot=path.join(root,'assets');
 await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);let store,nas,assets;
 const connect=async()=>{
  store=new Store(db);nas=new Nas(store);await nas.connect({taskRoot,assetRoot});assets=new Assets(store,nas);
  nas.readTask=async()=>Buffer.alloc(0);
  nas.sync=async(_old,next,_patch,event)=>{store.atomic(()=>{store.put('task',next.id,next);if(event)store.event(event.kind,event.actor,next.id,event.body)});return next};
 };
 await connect();
 t.after(async()=>{await nas.release();store.close();const actual=path.resolve(root);assert.equal(path.dirname(actual),path.resolve(os.tmpdir()));assert.ok(path.basename(actual).startsWith('task-archive-isolation-'));await fs.rm(actual,{recursive:true,force:true})});
 const images=await Promise.all(['icon-manager.png','icon-designer.png','icon-operator.png'].map(name=>fs.readFile(path.join(__dirname,'../assets',name))));
 assert.equal(new Set(images.map(digest)).size,images.length,'Use existing distinct images without modifying their bytes');
 const h={root,db,taskRoot,assetRoot,get store(){return store},get nas(){return nas},get assets(){return assets}};
 h.restart=async()=>{await nas.release();store.close();await connect()};
 h.task=(options={})=>{
  const id=crypto.randomUUID(),brand='合成测试品牌',product='同款合成商品',code='6999999999997';
  const task={id,title:'合成任务',state:4,owner:actor.personId,version:1,completedAt:Date.UTC(2026,9,28,4),completedMonth:'2026-10',brand,workbookBrand:brand,product,code,sealed:false,
   items:[{id:'row-6',row:6,type:'main-full',typeName:'完整主图精做',qty:1,points:.8,category:'main',brand,workbookBrand:brand,product,code,sealed:false}],...options};
  store.put('task',id,task);return task;
 };
 h.current=task=>store.get('task',task.id);
 h.bundle=(mode='flat',variant=0,deliveryFolder=folder)=>{
  // A minimal source fixture exercises signature validation; exported images are copied unchanged from repository assets.
  const source=Buffer.concat([Buffer.from([56,66,80,83,0,1]),Buffer.alloc(24),Buffer.from('synthetic editable source '+variant)]),bytes=[source,images[variant%images.length]];
  const payload={selfChecked:true,delivery:{version:1,namingVersion:mode==='flat'?2:1,folder:deliveryFolder,directories:[]},files:bytes.map((bytes,index)=>({relativePath:index?'主图01.png':'源稿.psd',size:bytes.length,sha256:digest(bytes)}))};
  return {mode,bytes,payload};
 };
 h.prepare=(task,bundle)=>assets.prepare(h.current(task),null,actor,bundle.payload);
 h.receive=async(upload,bundle)=>{for(const file of upload.files)await assets.receive(upload.id,file.id,actor,Readable.from([bundle.bytes[Number(file.id)]]),file.size)};
 h.finish=task=>assets.finish(task.id,actor,h.current(task).version);
 h.publish=async(task,bundle,{seal=true}={})=>{const upload=await h.prepare(task,bundle);await h.receive(upload,bundle);await assets.commit(upload.id,actor);if(seal)await h.finish(task);return store.get('upload',upload.id)};
 h.baseCategory=async(task,mode)=>{const item={...h.current(task).items[0],category:'main'},product=await nas.productDirectory(item,true);return nas.categoryDirectory(product,item,true,mode==='flat'?'flat':true)};
 h.legacy=async(task,bundle)=>{
  const prepared=await h.prepare(task,bundle),old={...prepared,category:await h.baseCategory(task,bundle.mode)};delete old.storageLayout;
  store.put('upload',old.id,old);return old;
 };
 h.isolatedV2=async(task,bundle)=>{
  const prepared=await h.prepare(task,bundle),base=await h.baseCategory(task,bundle.mode),old={...prepared,storageLayout:2,category:assets.taskCategory(base,task)};
  store.put('upload',old.id,old);return old;
 };
 h.fileSnapshot=async files=>Promise.all(files.map(async file=>{const stat=await fs.stat(file.path);return {path:file.path,sha256:await fileHash(file.path),mtimeMs:stat.mtimeMs,size:stat.size}}));
 h.assertFilesUnchanged=async before=>{for(const file of before){const stat=await fs.stat(file.path);assert.equal(await fileHash(file.path),file.sha256,file.path);assert.equal(stat.mtimeMs,file.mtimeMs,file.path);assert.equal(stat.size,file.size,file.path)}};
 return h;
}

test('new deliveries keep readable date folders and refuse different same-named bytes without changing existing flat or split archives',async t=>{
 for(const mode of ['flat','split'])await t.test(mode,async t=>{
  const h=await setup(t),old=h.task();old.items=[{...old.items[0],qty:35,points:28},{...old.items[0],id:'row-7',row:7,type:'detail-adjust',typeName:'详情页套图调整',qty:1,points:.25,category:'detail'}];h.store.put('task',old.id,old);
  const oldBundle=h.bundle(mode,0),oldUpload=await h.legacy(old,oldBundle);await h.receive(oldUpload,oldBundle);await h.assets.commit(oldUpload.id,actor);await h.finish(old);
  const original=h.current(old),oldRecord=h.store.get('asset',oldUpload.id),files=await h.fileSnapshot(oldRecord.files);assert.equal(original.sealed,true);assert.equal(R.total(original),28.25);
  const fresh=h.task();await assert.rejects(h.prepare(fresh,h.bundle(mode,1)),/同名.*内容不同/);assert.equal(h.current(fresh).deliveries,undefined);
  const freshBundle=h.bundle(mode,1,'1029-吕慧芸-主图'),upload=await h.publish(fresh,freshBundle),record=h.store.get('asset',upload.id);
  assert.equal(upload.storageLayout,3);assert.equal(h.current(fresh).sealed,true);assert.equal(R.total(h.current(fresh)),.8);assert.equal(upload.category.path,oldUpload.category.path);
  assert.ok(record.files.every(f=>!f.path.includes('任务-'+fresh.id)));assert.ok(record.files.some(f=>f.path.includes('1029-吕慧芸-主图')));
  assert.deepEqual(h.current(old),original);assert.deepEqual(h.store.get('asset',oldUpload.id),oldRecord);await h.assertFilesUnchanged(files);
 });
});

test('two new tasks use readable date folders without UUID directories and can publish different delivery days concurrently',async t=>{
 const h=await setup(t),first=h.task(),second=h.task(),a=h.bundle('split',0),b=h.bundle('split',1,'1029-吕慧芸-主图'),uploads=await Promise.all([h.prepare(first,a),h.prepare(second,b)]);
 assert.ok(uploads.every(u=>u.storageLayout===3));assert.equal(uploads[0].category.path,uploads[1].category.path);assert.ok(uploads.every(u=>!u.category.path.includes('任务-')));
 await Promise.all(uploads.map((upload,index)=>h.receive(upload,[a,b][index])));await Promise.all(uploads.map(upload=>h.assets.commit(upload.id,actor)));await Promise.all([h.finish(first),h.finish(second)]);
 const records=uploads.map(upload=>h.store.get('asset',upload.id));assert.equal(new Set(records.flatMap(record=>record.files.map(file=>file.path))).size,4);
 for(const [index,record] of records.entries())for(const file of record.files)assert.equal(await fileHash(file.path),[a,b][index].payload.files[Number(file.id)].sha256);
 const base=uploads[0].category.path;assert.deepEqual((await fs.readdir(base)).sort(),['01.源文件','02.导出图片']);
 assert.equal(h.current(first).sealed,true);assert.equal(h.current(second).sealed,true);
});

test('concurrent preparations reject conflicting names before transfer without inventing task directories',async t=>{
 const h=await setup(t),first=h.task(),second=h.task(),result=await Promise.allSettled([h.prepare(first,h.bundle('split',0)),h.prepare(second,h.bundle('split',1))]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.match(result.find(r=>r.status==='rejected').reason.message,/其他任务.*同名.*内容不同/);
 assert.equal(h.store.all('upload').filter(u=>u.status==='uploading').length,1);assert.equal(h.store.all('asset').length,0);
});

test('an older item-level client keeps a prepared human-facing flat layout when split folders later appear',async t=>{
 const h=await setup(t),first=h.task(),second=h.task({completedAt:Date.UTC(2026,9,29,4)}),bundles=[h.bundle('flat',0),h.bundle('flat',1,'1029-吕慧芸-主图')],uploads=[];
 for(const [index,task] of [first,second].entries()){
  const bundle=bundles[index],deliveryFolder=bundle.payload.delivery.folder,payload={selfChecked:true,files:bundle.bytes.map((bytes,index)=>({name:index?'主图01.png':deliveryFolder+'.psd',kind:index?'output':'source',...(index?{folder:deliveryFolder}:{}),size:bytes.length,sha256:digest(bytes)}))};
  const upload=await h.assets.prepare(h.current(task),'row-6',actor,payload);assert.equal(upload.storageLayout,3);assert.equal(upload.category.source,upload.category.path);assert.equal(upload.category.output,upload.category.path);uploads.push(upload);
 }
 await h.baseCategory(first,'split');await Promise.all(uploads.map((upload,index)=>h.receive(upload,bundles[index])));await Promise.all(uploads.map(upload=>h.assets.commit(upload.id,actor)));
 assert.equal(h.current(first).sealed,true);assert.equal(h.current(second).sealed,true);
 for(const upload of uploads){const done=h.store.get('upload',upload.id),record=h.store.get('asset',upload.id);assert.deepEqual(done.category,upload.category);assert.equal(record.path,upload.category.path);assert.ok(record.files.every(file=>!file.path.includes('01.源文件')&&!file.path.includes('02.导出图片')&&!file.path.includes('任务-')))}
});

test('reselecting files only cancels its own prior batch and leaves another date folder upload usable',async t=>{
 const h=await setup(t),first=h.task(),second=h.task(),a=h.bundle('flat',0),b=h.bundle('flat',1,'1029-吕慧芸-主图'),replacement=h.bundle('flat',2);
 const old=await h.prepare(first,a),other=await h.prepare(second,b);await Promise.all([h.receive(old,a),h.receive(other,b)]);
 const newer=await h.prepare(first,replacement);assert.equal(h.store.get('upload',old.id).status,'cancelled');assert.equal(h.store.get('upload',other.id).status,'uploading');assert.notEqual(newer.id,old.id);assert.equal(newer.category.path,old.category.path);
 await h.receive(newer,replacement);await Promise.all([h.assets.commit(newer.id,actor),h.assets.commit(other.id,actor)]);await Promise.all([h.finish(first),h.finish(second)]);
 assert.equal(h.store.get('asset',old.id),null);assert.equal(h.current(first).deliveries[0].id,newer.id);assert.equal(h.current(second).deliveries[0].id,other.id);
});

test('a publication interrupted before workbook backfill resumes after restart at frozen paths without duplicate records',async t=>{
 const h=await setup(t),task=h.task(),bundle=h.bundle('split',0),upload=await h.prepare(task,bundle);await h.receive(upload,bundle);
 const sync=h.nas.sync;h.nas.sync=async()=>{throw Error('合成测试：Excel 占用，等待回填')};await assert.rejects(h.assets.commit(upload.id,actor),/等待回填/);h.nas.sync=sync;
 const pending=h.store.get('upload',upload.id),targets={...pending.published},snapshots=await h.fileSnapshot(pending.files.map(f=>({...f,path:pending.published[f.id]})));
 assert.equal(pending.status,'publishing');assert.equal(Object.keys(targets).length,2);
 const stagingRoot=path.resolve(h.assetRoot,'_workbench-staging');assert.equal(path.dirname(path.resolve(upload.stage)),stagingRoot);await fs.rm(upload.stage,{recursive:true,force:true});
 await h.restart();assert.equal(await h.assets.retryPending(task.id),1);const done=h.store.get('upload',upload.id);assert.equal(done.status,'done');assert.deepEqual(done.category,pending.category);assert.deepEqual(done.published,targets);
 const retry=await h.prepare(task,bundle);assert.equal(retry.id,upload.id);await h.assets.commit(retry.id,actor);await h.finish(task);
 assert.equal(h.store.all('asset').filter(record=>record.taskId===task.id).length,1);assert.equal(h.current(task).deliveries.length,1);await h.assertFilesUnchanged(snapshots);
});

test('legacy uploading, publishing and done batches without layout metadata retain their original flat or split paths on retry',async t=>{
 for(const mode of ['flat','split'])for(const status of ['uploading','publishing','done'])await t.test(mode+' '+status,async t=>{
  const h=await setup(t),task=h.task(),bundle=h.bundle(mode,0),legacy=await h.legacy(task,bundle);await h.receive(legacy,bundle);
  if(status==='publishing'){
   const sync=h.nas.sync;h.nas.sync=async()=>{throw Error('合成回填中断')};await assert.rejects(h.assets.commit(legacy.id,actor),/回填中断/);h.nas.sync=sync;
  }else if(status==='done'){await h.assets.commit(legacy.id,actor);await h.finish(task)}
  const before=h.store.get('upload',legacy.id),snapshots=before.published?await h.fileSnapshot(before.files.map(f=>({...f,path:before.published[f.id]}))):[];assert.equal(before.storageLayout,undefined);assert.equal(before.status,status);
  await h.restart();const resumed=await h.prepare(task,bundle);assert.equal(resumed.id,legacy.id);assert.equal(resumed.storageLayout,undefined);assert.deepEqual(resumed.category,legacy.category);
  await h.assets.commit(resumed.id,actor);if(!h.current(task).sealed)await h.finish(task);
  const record=h.store.get('asset',legacy.id);assert.equal(record.path,legacy.category.path);assert.ok(record.files.every(file=>!file.path.includes('任务-'+task.id)));assert.equal(h.current(task).sealed,true);assert.equal(h.store.all('asset').length,1);await h.assertFilesUnchanged(snapshots);
 });
});

test('existing v0.6.36 UUID-folder uploads retain their frozen paths through receive, restart, retry and sealing',async t=>{
 for(const mode of ['flat','split'])for(const status of ['uploading','publishing','done'])await t.test(mode+' '+status,async t=>{
  const h=await setup(t),task=h.task(),bundle=h.bundle(mode,0),old=await h.isolatedV2(task,bundle);await h.receive(old,bundle);
  if(status==='publishing'){const sync=h.nas.sync;h.nas.sync=async()=>{throw Error('合成旧版本回填中断')};await assert.rejects(h.assets.commit(old.id,actor),/回填中断/);h.nas.sync=sync}
  else if(status==='done'){await h.assets.commit(old.id,actor);await h.finish(task)}
  const before=h.store.get('upload',old.id),snapshot=before.published?await h.fileSnapshot(before.files.map(f=>({...f,path:before.published[f.id]}))):[];
  await h.restart();const resumed=await h.prepare(task,bundle);assert.equal(resumed.id,old.id);assert.equal(resumed.storageLayout,2);assert.deepEqual(resumed.category,old.category);await h.assets.commit(resumed.id,actor);if(!h.current(task).sealed)await h.finish(task);
  const record=h.store.get('asset',old.id);assert.ok(record.path.includes('任务-'+task.id));assert.equal(record.path,old.category.path);assert.equal(h.store.all('asset').length,1);await h.assertFilesUnchanged(snapshot);
 });
});

test('simultaneous commits of pre-existing conflicting shared-path batches cannot interleave or partially replace the winning package',async t=>{
 const h=await setup(t),first=h.task(),second=h.task(),a=h.bundle('split',0),b=h.bundle('split',1),one=await h.prepare(first,a);
 // Simulate an already-prepared legacy batch restored before reservation checks existed.
 const all=h.store.all.bind(h.store);let two;h.store.all=kind=>kind==='upload'?[]:all(kind);try{two=await h.prepare(second,b)}finally{h.store.all=all}
 await h.receive(one,a);await h.receive(two,b);const result=await Promise.allSettled([h.assets.commit(one.id,actor),h.assets.commit(two.id,actor)]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.match(result.find(r=>r.status==='rejected').reason.message,/同名.*内容不同/);assert.equal(h.store.all('asset').length,1);
 const record=h.store.all('asset')[0],bytes=record.taskId===first.id?a:b,loser=record.taskId===first.id?second:first;
 for(const file of record.files)assert.equal(await fileHash(file.path),bytes.payload.files[Number(file.id)].sha256);assert.equal(h.current(loser).deliveries?.length||0,0);
});

test('a new rework round uses a readable revision directory and preserves prior approved files',async t=>{
 const h=await setup(t),task=h.task(),firstBundle=h.bundle('split',0),first=await h.publish(task,firstBundle),record=h.store.get('asset',first.id),before=await h.fileSnapshot(record.files);
 const old=h.current(task),next={...old,archiveRound:1,sealed:false,version:old.version+1,deliveries:[],deliveryHistory:[{deliveries:old.deliveries,items:structuredClone(old.items)}]};delete next.sealedAt;delete next.sealedFromVersion;h.store.put('task',task.id,next);
 const replacement=await h.publish(task,h.bundle('split',1));assert.notEqual(replacement.category.path,first.category.path);assert.ok(replacement.category.path.startsWith(first.category.path+path.sep));assert.equal(path.basename(replacement.category.path),'返工-1');
 assert.equal(h.current(task).archiveRound,1);assert.equal(h.current(task).sealed,true);assert.equal(h.store.all('asset').length,2);assert.deepEqual(h.store.get('asset',first.id),record);await h.assertFilesUnchanged(before);
});

test('unknown layout versions and forged destination paths fail before any official files are written',async t=>{
 for(const corruption of ['unknown layout','other task destination'])await t.test(corruption,async t=>{
  const h=await setup(t),task=h.task(),other=h.task(),bundle=h.bundle('flat',0),upload=await h.prepare(task,bundle);await h.receive(upload,bundle);
  const forged=structuredClone(h.store.get('upload',upload.id));
  if(corruption==='unknown layout')forged.storageLayout=999;
  else{forged.category={...forged.category,path:path.join(forged.category.path,'任务-'+other.id),source:path.join(forged.category.source,'任务-'+other.id),output:path.join(forged.category.output,'任务-'+other.id)}}
  h.store.put('upload',forged.id,forged);
  await assert.rejects(h.assets.commit(forged.id,actor));await assert.rejects(h.prepare(task,bundle));assert.equal(h.store.all('asset').length,0);assert.equal(h.current(task).deliveries?.length||0,0);
  for(const file of upload.files)await assert.rejects(fs.access(path.join(file.kind==='source'?upload.category.source:upload.category.output,file.relative)),{code:'ENOENT'});
 });
});

test('deleting one date-named archive only reopens that task and leaves its sibling record and files intact',async t=>{
 const h=await setup(t),first=h.task(),second=h.task(),a=await h.publish(first,h.bundle('flat',0)),b=await h.publish(second,h.bundle('flat',1,'1029-吕慧芸-主图')),removed=h.store.get('asset',a.id),kept=h.store.get('asset',b.id),before=h.current(second),files=await h.fileSnapshot(kept.files);
 for(const file of removed.files)await fs.unlink(file.path);const result=await h.assets.reconcileMissingAssets();assert.equal(result.reopened,1);
 assert.equal(h.current(first).sealed,false);assert.equal(h.current(first).deliveries.length,0);assert.ok(h.store.get('asset',a.id).missingAt);assert.equal(h.store.get('upload',a.id).status,'cancelled');
 assert.deepEqual(h.current(second),before);assert.deepEqual(h.store.get('asset',b.id),kept);assert.equal(h.store.get('upload',b.id).status,'done');await h.assertFilesUnchanged(files);
});
