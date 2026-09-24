'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {classifyDelivery}=require('../core/delivery.cjs'),{scanDelivery}=require('../desktop/delivery.cjs');
const {validateManifest,archiveSpec}=require('../core/assets.cjs');
const {fileHash}=require('../core/nas.cjs');
const task=()=>({id:crypto.randomUUID(),state:4,owner:'lv',version:1,completedAt:Date.UTC(2026,8,3,4),items:[{id:'i',type:'complex',qty:1,category:'main',product:'西红花',brand:'九芝堂',code:'6970855224163',points:1.5}]});
const entry=(relativePath,size=100)=>({relativePath,size,sha256:'a'.repeat(64)});
const spec=archiveSpec(task(),task().items[0]),folder=spec.base;
test('automatic naming publishes sibling source and artboard folder without renaming local files',async()=>{
 const {Service}=require('../core/service.cjs'),{createReadStream}=require('node:fs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'naming-publish-')),root=path.join(dir,folder),assetRoot=path.join(dir,'assets'),taskRoot=path.join(dir,'requests');
 for(const p of [root,assetRoot,taskRoot])await fs.mkdir(p);
 const service=await new Service(path.join(dir,'db'),{host:'127.0.0.1',port:0}).start(),manager={role:'manager',personId:'zeng'},actor={role:'designer',personId:'lv'},t=task();
 try{
  await service.call(manager,'configure',{assetRoot,taskRoot});service.store.put('task',t.id,t);
  service.nas.sync=async(_old,next)=>{service.store.put('task',next.id,next);return next};
  await fs.writeFile(path.join(root,'我的源稿.psd'),Buffer.concat([Buffer.from([56,66,80,83,0,1]),Buffer.alloc(24)]));await fs.copyFile(path.join(__dirname,'../assets/icon.png'),path.join(root,'主图01.png'));
  const exact=await service.call(actor,'archive-spec',{taskId:t.id,folder}),selected=await scanDelivery(root,{...exact,autoName:true}),files=await Promise.all(selected.files.map(async({file,...f})=>({...f,sha256:await fileHash(file)})));
  const payload={taskId:t.id,selfChecked:true,delivery:{version:1,namingVersion:2,folder,directories:selected.originalDirectories},files},batch=await service.call(actor,'archive-prepare',payload);
  for(let i=0;i<files.length;i++)await service.assets.receive(batch.id,String(i),actor,createReadStream(selected.files[i].file),files[i].size);
  const committed=await service.call(actor,'archive-commit',{uploadId:batch.id}),base=committed.deliveries[0].path;
  assert.ok((await fs.stat(path.join(base,folder+'.psd'))).isFile());assert.ok((await fs.stat(path.join(base,folder,'主图01.png'))).isFile());
  assert.ok((await fs.stat(path.join(root,'我的源稿.psd'))).isFile());
  const records=await service.call(actor,'assets');assert.equal(records[0].taskId,t.id);assert.equal(records[0].requirement.canOpen,true);
  const next={...service.store.get('task',t.id),title:'改名后的需求',filename:'新需求.xlsx'};service.store.put('task',t.id,next);
  assert.equal((await service.call(actor,'assets'))[0].requirement.filename,'新需求.xlsx');
  const reopened={...next,archiveRound:1,deliveries:[],sealed:false};service.store.put('task',reopened.id,reopened);
  const retry=await service.call(actor,'archive-prepare',payload);assert.notEqual(retry.id,batch.id);
  for(let i=0;i<files.length;i++)await service.assets.receive(retry.id,String(i),actor,createReadStream(selected.files[i].file),files[i].size);
  const revised=await service.call(actor,'archive-commit',{uploadId:retry.id});assert.ok(Object.values(service.store.get('upload',retry.id).published).every(file=>file.includes('返工-')));
  assert.ok((await fs.stat(path.join(base,folder+'.psd'))).isFile());assert.equal(revised.deliveries.length,1);
  await assert.rejects(service.call(actor,'archive-commit',{uploadId:batch.id}),/回退前/);
 }finally{await service.stop()}
});
test('one mixed folder classifies PSD plus a single PNG without renaming inner files',()=>{
 const t=task(),files=[entry('已定稿.psd'),entry('最终图片.PNG')],delivery={version:1,folder,directories:[]};
 const result=validateManifest(t,t.items[0],files,delivery);
 assert.deepEqual(result.files.map(f=>[f.kind,f.relative]),[['source',folder+'/已定稿.psd'],['output',folder+'/最终图片.PNG']]);
 assert.throws(()=>validateManifest(t,t.items[0],files,{...delivery,folder:'0903-洪华-主图'}),/应为「0903-吕慧芸-主图」/);
 assert.throws(()=>classifyDelivery(spec,folder,[entry('文件.psd'),entry('图片.webp')]),/识别到 0/);
 assert.equal(classifyDelivery(spec,folder,[entry('文件.psd'),entry('图片.JPEG')]).files[1].kind,'output');
});
test('C4D dependencies and empty folders stay with their project, ordinary nested exports still classify',()=>{
 const result=classifyDelivery(spec,folder,[entry('工程包/场景.c4d'),entry('工程包/tex/贴图.jpg'),entry('工程包/说明.txt',0),entry('导出/定稿.png'),entry('说明.pdf')],['工程包','工程包/tex','工程包/cache','导出']);
 assert.deepEqual(result.files.map(f=>f.kind),['source','source','source','output','source']);
 assert.deepEqual(result.projectFolders,['工程包']);
 assert.ok(result.directories.some(d=>d.relative===folder+'/工程包/cache'&&d.kind==='source'));
 const rootProject=classifyDelivery(spec,folder,[entry('场景.c4d'),entry('tex/贴图.png'),entry('单图.jpg')],['tex']);
 assert.deepEqual(rootProject.files.map(f=>f.kind),['source','source','output']);
});
test('relative path collisions, traversal, misdeclared kinds and quantities cannot redirect assets',()=>{
 for(const bad of ['../逃逸.png','工程/../../逃逸.png','/逃逸.png','C:/逃逸.png','工程\\逃逸.png','工程//逃逸.png','CON.png']){
  assert.throws(()=>classifyDelivery(spec,folder,[entry('a.psd'),entry(bad)],['工程']));
 }
 assert.throws(()=>classifyDelivery(spec,folder,[entry('同名.psd'),entry('同名.PSD'),entry('a.png')]),/重名/);
 assert.throws(()=>classifyDelivery(spec,folder,[entry('工程'),entry('a.png')],['工程']),/重名/);
 assert.throws(()=>classifyDelivery(spec,folder,[entry('未声明/a.psd'),entry('a.png')]),/父目录/);
 assert.throws(()=>classifyDelivery(spec,folder,[entry('a.psd'),entry('a.png'),entry('b.jpg')]),/识别到 2/);
 const t=task(),result=validateManifest(t,t.items[0],[{...entry('a.psd'),kind:'output'},{...entry('a.png'),kind:'source'}],{version:1,folder,directories:[]});
 assert.deepEqual(result.files.map(f=>f.kind),['source','output']);
});
test('directory scanner accepts actual local folders and rejects a linked project directory',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'delivery-scan-')),root=path.join(dir,folder);
 await fs.mkdir(root);await fs.writeFile(path.join(root,'源.afdesign'),'source');await fs.copyFile(path.join(__dirname,'../assets/icon.png'),path.join(root,'图片.png'));
 const scanned=await scanDelivery(root,spec);assert.equal(scanned.files.length,2);
 await assert.rejects(scanDelivery(path.join(root,'图片.png'),spec),/整个交付文件夹/);
 const external=path.join(dir,'external');await fs.mkdir(external);await fs.symlink(external,path.join(root,'关联项目'),'junction');
 await assert.rejects(scanDelivery(root,spec),/链接/);
});
test('new folder upload preserves video and source-only engineering workflows',()=>{
 const video=classifyDelivery({...spec,category:'video'},folder,[entry('剪辑.prproj'),entry('成片.mp4')]);
 assert.deepEqual(video.files.map(f=>f.kind),['source','output']);
 const project=classifyDelivery({...spec,category:'project'},folder,[entry('建模.c4d'),entry('贴图.png')]);
 assert.ok(project.files.every(f=>f.kind==='source'));
});
test('paired HTTPS transfer commits a complete project tree into split asset folders and resumes safely',async()=>{
 const {Service}=require('../core/service.cjs'),{Client,decodeCode}=require('../core/client.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'delivery-transfer-')),root=path.join(dir,'desktop',folder),assetRoot=path.join(dir,'assets'),taskRoot=path.join(dir,'requests');
 for(const d of [root,assetRoot,taskRoot,path.join(root,'产品工程','tex'),path.join(root,'产品工程','cache')])await fs.mkdir(d,{recursive:true});
 await fs.writeFile(path.join(root,'产品工程','场景.c4d'),'C4D project fixture');
 await fs.writeFile(path.join(root,'产品工程','说明.txt'),'');
 // Reuse an existing PNG unchanged; no rendered or generated image fixture.
 for(const file of [path.join(root,'单图.png'),path.join(root,'产品工程','tex','贴图.png')])await fs.copyFile(path.join(__dirname,'../assets/icon.png'),file);
 const service=await new Service(path.join(dir,'db'),{host:'127.0.0.1',port:0}).start();let client;
 try{
  const manager={role:'manager',personId:'zeng'},t=task();
  await service.call(manager,'configure',{assetRoot,taskRoot});service.store.put('task',t.id,t);
  let syncCount=0;
  service.nas.sync=async(old,next,patch)=>{assert.equal(old.id,t.id);assert.match(patch.L4,/02\.主图/);syncCount++;service.store.put('task',next.id,next);return next};
  const code=await service.call(manager,'pair-code',{personId:'lv',host:'127.0.0.1'});
  const pairing=new Client(decodeCode(code.code));client=new Client(await pairing.pair());
  const selected=await scanDelivery(root,await client.rpc('archive-spec',{taskId:t.id,itemId:'i'}));
  const files=await Promise.all(selected.files.map(async({file,...f})=>({...f,sha256:await fileHash(file)})));
  const payload={taskId:t.id,itemId:'i',selfChecked:true,delivery:{version:1,folder,directories:selected.originalDirectories},files};
  const batch=await client.rpc('archive-prepare',payload);
  assert.equal((await client.rpc('archive-prepare',payload)).id,batch.id);
  await assert.rejects(client.rpc('archive-commit',{uploadId:batch.id}),/尚未上传完整/);
  for(let i=0;i<files.length;i++)await client.upload(batch.id,batch.files[i],selected.files[i].file);
  const receipts=await client.rpc('archive-prepare',payload);assert.equal(Object.keys(receipts.received).length,files.length);
  const committed=await client.rpc('archive-commit',{uploadId:batch.id});assert.equal(committed.sealed,true);
  const category=committed.items[0].assetPath,source=path.join(category,'01.源文件',folder),output=path.join(category,'02.导出图片',folder);
  assert.deepEqual(await fs.readdir(output),['单图.png']);
  assert.ok((await fs.stat(path.join(source,'产品工程','cache'))).isDirectory());
  for(const f of selected.files)assert.equal(await fileHash(path.join(f.kind==='source'?source:output,...f.relativePath.split('/'))),await fileHash(f.file));
  assert.equal(service.store.get('asset',batch.id).delivery.directories.length,3);
  await client.rpc('archive-commit',{uploadId:batch.id});assert.equal(syncCount,1);
  const other={...t,id:crypto.randomUUID()};service.store.put('task',other.id,other);
  assert.ok((await client.rpc('archive-prepare',{...payload,taskId:other.id})).id);
  const changed={...payload,taskId:crypto.randomUUID(),files:payload.files.map((f,i)=>i===0?{...f,sha256:'a'.repeat(64)}:f)};service.store.put('task',changed.taskId,{...t,id:changed.taskId});await assert.rejects(client.rpc('archive-prepare',changed),/同名/);
 }finally{client?.close();await service.stop()}
});
test('one completed task accepts separate folder-named asset types before final sealing',async()=>{
 const {Service}=require('../core/service.cjs'),{Client,decodeCode}=require('../core/client.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'delivery-types-')),assetRoot=path.join(dir,'assets'),taskRoot=path.join(dir,'requests');
 await fs.mkdir(assetRoot);await fs.mkdir(taskRoot);const service=await new Service(path.join(dir,'db'),{host:'127.0.0.1',port:0}).start();let client;
 try{
  const manager={role:'manager',personId:'zeng'},t=task();t.items[0].category=null;await service.call(manager,'configure',{assetRoot,taskRoot});service.store.put('task',t.id,t);
  service.nas.readTask=async()=>Buffer.alloc(0);service.nas.sync=async(_old,next,patch)=>{assert.match(patch.L4,/：/);service.store.put('task',next.id,next);return next};
  const code=await service.call(manager,'pair-code',{personId:'lv',host:'127.0.0.1'}),pairing=new Client(decodeCode(code.code));client=new Client(await pairing.pair());
  for(const category of ['主图','SKU']){
   const folder='0903-吕慧芸-'+category,root=path.join(dir,folder);await fs.mkdir(root);await fs.writeFile(path.join(root,'源文件.txt'),'editable');await fs.copyFile(path.join(__dirname,'../assets/icon.png'),path.join(root,'最终.png'));
   const exact=await client.rpc('archive-spec',{taskId:t.id,folder}),selected=await scanDelivery(root,exact),files=await Promise.all(selected.files.map(async({file,...f})=>({...f,sha256:await fileHash(file)})));
   const abandoned=await client.rpc('archive-prepare',{taskId:t.id,selfChecked:true,delivery:{version:1,folder,directories:selected.originalDirectories},files:files.map(f=>({...f,relativePath:'旧版-'+f.relativePath}))});
   const batch=await client.rpc('archive-prepare',{taskId:t.id,selfChecked:true,delivery:{version:1,folder,directories:selected.originalDirectories},files});
   assert.equal(service.store.get('upload',abandoned.id).status,'cancelled');
   for(let i=0;i<files.length;i++)await client.upload(batch.id,batch.files[i],selected.files[i].file);
   const archived=await client.rpc('archive-commit',{uploadId:batch.id});assert.equal(archived.sealed,false);assert.equal(archived.deliveries.length,category==='主图'?1:2);
  }
  let current=service.store.get('task',t.id);assert.deepEqual(current.deliveries.map(d=>d.category),['main','sku']);
  const file=service.store.all('asset')[0].files[0],original=await fs.readFile(file.path);
  await fs.unlink(file.path);await assert.rejects(client.rpc('archive-finish',{taskId:t.id,version:current.version}),/缺少文件/);
  assert.equal(service.store.get('task',t.id).sealed,false);
  await fs.writeFile(file.path,Buffer.alloc(original.length,1));await assert.rejects(client.rpc('archive-finish',{taskId:t.id,version:current.version}),/文件已改变/);
  await fs.writeFile(file.path,original);
  current=await client.rpc('archive-finish',{taskId:t.id,version:current.version});assert.equal(current.sealed,true);
  assert.equal(service.store.all('asset').length,2);await assert.rejects(client.rpc('archive-spec',{taskId:t.id}),/尚不能封存/);
 }finally{client?.close();await service.stop()}
});

test('automatic naming v3 transfers originals into flat category directories and keeps task links',async()=>{
 const {Service}=require('../core/service.cjs'),{Client,decodeCode}=require('../core/client.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'delivery-types-')),assetRoot=path.join(dir,'assets'),taskRoot=path.join(dir,'requests');
 await fs.mkdir(assetRoot);await fs.mkdir(taskRoot);const service=await new Service(path.join(dir,'db'),{host:'127.0.0.1',port:0}).start();let client;
 try{
  const manager={role:'manager',personId:'zeng'},t=task();t.items[0].category=null;await service.call(manager,'configure',{assetRoot,taskRoot});service.store.put('task',t.id,t);
  service.nas.readTask=async()=>Buffer.alloc(0);service.nas.sync=async(_old,next,patch)=>{assert.match(patch.L4,/：/);service.store.put('task',next.id,next);return next};
  const code=await service.call(manager,'pair-code',{personId:'lv',host:'127.0.0.1'}),pairing=new Client(decodeCode(code.code));client=new Client(await pairing.pair());
  for(const category of ['创意图','SKU']){
   const folder='0903-吕慧芸-'+category,root=path.join(dir,folder);await fs.mkdir(root);await fs.writeFile(path.join(root,'源文件.txt'),'editable');await fs.copyFile(path.join(__dirname,'../assets/icon.png'),path.join(root,'最终.png'));
   const exact=await client.rpc('archive-spec',{taskId:t.id,folder}),selected=await scanDelivery(root,exact,{automatic:true}),files=await Promise.all(selected.files.map(async({file,...f})=>({...f,sha256:await fileHash(file)})));
   const abandoned=await client.rpc('archive-prepare',{taskId:t.id,selfChecked:true,delivery:{version:1,namingVersion:3,folder,directories:selected.originalDirectories},files:files.map(f=>({...f,relativePath:'旧版-'+f.relativePath}))});
   const batch=await client.rpc('archive-prepare',{taskId:t.id,selfChecked:true,delivery:{version:1,namingVersion:3,folder,directories:selected.originalDirectories},files});
   assert.equal(service.store.get('upload',abandoned.id).status,'cancelled');
   for(let i=0;i<files.length;i++)await client.upload(batch.id,batch.files[i],selected.files[i].file);
   const archived=await client.rpc('archive-commit',{uploadId:batch.id});assert.equal(archived.sealed,false);assert.equal(archived.deliveries.length,category==='创意图'?1:2);
  }
  let current=service.store.get('task',t.id);assert.deepEqual(current.deliveries.map(d=>d.category),['creative','sku']);
  const file=service.store.all('asset')[0].files[0],original=await fs.readFile(file.path);
  await fs.unlink(file.path);await assert.rejects(client.rpc('archive-finish',{taskId:t.id,version:current.version}),/缺少文件/);
  assert.equal(service.store.get('task',t.id).sealed,false);
  await fs.writeFile(file.path,Buffer.alloc(original.length,1));await assert.rejects(client.rpc('archive-finish',{taskId:t.id,version:current.version}),/文件已改变/);
  await fs.writeFile(file.path,original);
  current=await client.rpc('archive-finish',{taskId:t.id,version:current.version});assert.equal(current.sealed,true);
  assert.equal(service.store.all('asset').length,2);for(const record of service.store.all('asset')){assert.equal(record.taskId,t.id);assert.equal(record.code,t.items[0].code);assert.ok(record.files.some(f=>f.name===(record.category==='sku'?'01-最终-SKU.png':'创意图01.png')));assert.ok(record.files.every(f=>!f.path.includes('导出图片')))}await assert.rejects(client.rpc('archive-spec',{taskId:t.id}),/尚不能封存/);
 }finally{client?.close();await service.stop()}
});

test('fully received legacy delivery waits through Excel lock and automatically recovers exactly once',async()=>{
 const {Service}=require('../core/service.cjs'),{Client,decodeCode}=require('../core/client.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'delivery-types-')),assetRoot=path.join(dir,'assets'),taskRoot=path.join(dir,'requests');
 await fs.mkdir(assetRoot);await fs.mkdir(taskRoot);const service=await new Service(path.join(dir,'db'),{host:'127.0.0.1',port:0}).start();let client;
 try{
  const manager={role:'manager',personId:'zeng'},t=task();t.items[0].category=null;await service.call(manager,'configure',{assetRoot,taskRoot});service.store.put('task',t.id,t);
  service.nas.readTask=async()=>Buffer.alloc(0);service.nas.sync=async(_old,next,patch)=>{assert.match(patch.L4,/：/);service.store.put('task',next.id,next);return next};
  const code=await service.call(manager,'pair-code',{personId:'lv',host:'127.0.0.1'}),pairing=new Client(decodeCode(code.code));client=new Client(await pairing.pair());
  for(const category of ['创意图','SKU']){
   const folder='0903-吕慧芸-'+category,root=path.join(dir,folder);await fs.mkdir(root);await fs.writeFile(path.join(root,'源文件.txt'),'editable');await fs.copyFile(path.join(__dirname,'../assets/icon.png'),path.join(root,'最终.png'));
   const exact=await client.rpc('archive-spec',{taskId:t.id,folder}),selected=await scanDelivery(root,exact),files=await Promise.all(selected.files.map(async({file,...f})=>({...f,sha256:await fileHash(file)})));
   const abandoned=await client.rpc('archive-prepare',{taskId:t.id,selfChecked:true,delivery:{version:1,folder,directories:selected.originalDirectories},files:files.map(f=>({...f,relativePath:'旧版-'+f.relativePath}))});
   const batch=await client.rpc('archive-prepare',{taskId:t.id,selfChecked:true,delivery:{version:1,folder,directories:selected.originalDirectories},files});
   assert.equal(service.store.get('upload',abandoned.id).status,'cancelled');
   for(let i=0;i<files.length;i++)await client.upload(batch.id,batch.files[i],selected.files[i].file);
   const normalSync=service.nas.sync;service.nas.sync=async()=>{throw Error('Excel 正在编辑，请关闭')};const pending=await client.rpc('archive-commit',{uploadId:batch.id});assert.equal(pending.pending,true);assert.equal(service.store.get('upload',batch.id).status,'publishing');service.nas.sync=normalSync;assert.equal(await service.store.exclusive(()=>service.assets.retryPending(t.id)),1);const archived=await client.rpc('archive-commit',{uploadId:batch.id});assert.equal(service.store.get('upload',batch.id).status,'done');assert.equal(archived.sealed,false);assert.equal(archived.deliveries.length,category==='创意图'?1:2);
  }
  let current=service.store.get('task',t.id);assert.deepEqual(current.deliveries.map(d=>d.category),['creative','sku']);
  const file=service.store.all('asset')[0].files[0],original=await fs.readFile(file.path);
  await fs.unlink(file.path);await assert.rejects(client.rpc('archive-finish',{taskId:t.id,version:current.version}),/缺少文件/);
  assert.equal(service.store.get('task',t.id).sealed,false);
  await fs.writeFile(file.path,Buffer.alloc(original.length,1));await assert.rejects(client.rpc('archive-finish',{taskId:t.id,version:current.version}),/文件已改变/);
  await fs.writeFile(file.path,original);
  current=await client.rpc('archive-finish',{taskId:t.id,version:current.version});assert.equal(current.sealed,true);
  assert.equal(service.store.all('asset').length,2);for(const record of service.store.all('asset')){assert.equal(record.taskId,t.id);assert.equal(record.code,t.items[0].code);assert.ok(record.files.length)}await assert.rejects(client.rpc('archive-spec',{taskId:t.id}),/尚不能封存/);
 }finally{client?.close();await service.stop()}
});

test('automatic naming v4 preserves names and task links inside separate source and output sections',async()=>{
 const {Service}=require('../core/service.cjs'),{Client,decodeCode}=require('../core/client.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'delivery-types-')),assetRoot=path.join(dir,'assets'),taskRoot=path.join(dir,'requests');
 await fs.mkdir(assetRoot);await fs.mkdir(taskRoot);const service=await new Service(path.join(dir,'db'),{host:'127.0.0.1',port:0}).start();let client;
 try{
  const manager={role:'manager',personId:'zeng'},t=task();t.items[0].category=null;await service.call(manager,'configure',{assetRoot,taskRoot});service.store.put('task',t.id,t);
  service.nas.readTask=async()=>Buffer.alloc(0);service.nas.sync=async(_old,next,patch)=>{assert.match(patch.L4,/：/);service.store.put('task',next.id,next);return next};
  const code=await service.call(manager,'pair-code',{personId:'lv',host:'127.0.0.1'}),pairing=new Client(decodeCode(code.code));client=new Client(await pairing.pair());
  for(const category of ['创意图','SKU']){
   const folder='0903-吕慧芸-'+category,root=path.join(dir,folder);await fs.mkdir(root);await fs.writeFile(path.join(root,'源文件.txt'),'editable');await fs.copyFile(path.join(__dirname,'../assets/icon.png'),path.join(root,'最终.png'));
   const exact=await client.rpc('archive-spec',{taskId:t.id,folder}),selected=await scanDelivery(root,exact,{automatic:true}),files=await Promise.all(selected.files.map(async({file,...f})=>({...f,sha256:await fileHash(file)})));
   const abandoned=await client.rpc('archive-prepare',{taskId:t.id,selfChecked:true,delivery:{version:1,namingVersion:4,folder,directories:selected.originalDirectories},files:files.map(f=>({...f,relativePath:'旧版-'+f.relativePath}))});
   const batch=await client.rpc('archive-prepare',{taskId:t.id,selfChecked:true,delivery:{version:1,namingVersion:4,folder,directories:selected.originalDirectories},files});
   assert.equal(service.store.get('upload',abandoned.id).status,'cancelled');
   for(let i=0;i<files.length;i++)await client.upload(batch.id,batch.files[i],selected.files[i].file);
   const archived=await client.rpc('archive-commit',{uploadId:batch.id});assert.equal(archived.sealed,false);assert.equal(archived.deliveries.length,category==='创意图'?1:2);
  }
  let current=service.store.get('task',t.id);assert.deepEqual(current.deliveries.map(d=>d.category),['creative','sku']);
  const file=service.store.all('asset')[0].files[0],original=await fs.readFile(file.path);
  await fs.unlink(file.path);await assert.rejects(client.rpc('archive-finish',{taskId:t.id,version:current.version}),/缺少文件/);
  assert.equal(service.store.get('task',t.id).sealed,false);
  await fs.writeFile(file.path,Buffer.alloc(original.length,1));await assert.rejects(client.rpc('archive-finish',{taskId:t.id,version:current.version}),/文件已改变/);
  await fs.writeFile(file.path,original);
  current=await client.rpc('archive-finish',{taskId:t.id,version:current.version});assert.equal(current.sealed,true);
  assert.equal(service.store.all('asset').length,2);for(const record of service.store.all('asset')){assert.equal(record.taskId,t.id);assert.equal(record.code,t.items[0].code);assert.ok(record.files.some(f=>f.name===(record.category==='sku'?'01-最终-SKU.png':'创意图01.png')));assert.ok(record.files.every(f=>f.path.includes(f.kind==='source'?'01.源文件':'02.导出图片')))}await assert.rejects(client.rpc('archive-spec',{taskId:t.id}),/尚不能封存/);
 }finally{client?.close();await service.stop()}
});


test('lowercase SKU folder scans, normalizes and transfers through the full archive workflow',async()=>{
 const {Service}=require('../core/service.cjs'),{Client,decodeCode}=require('../core/client.cjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'delivery-types-')),assetRoot=path.join(dir,'assets'),taskRoot=path.join(dir,'requests');
 await fs.mkdir(assetRoot);await fs.mkdir(taskRoot);const service=await new Service(path.join(dir,'db'),{host:'127.0.0.1',port:0}).start();let client;
 try{
  const manager={role:'manager',personId:'zeng'},t=task();t.items[0].category=null;await service.call(manager,'configure',{assetRoot,taskRoot});service.store.put('task',t.id,t);
  service.nas.readTask=async()=>Buffer.alloc(0);service.nas.sync=async(_old,next,patch)=>{assert.match(patch.L4,/：/);service.store.put('task',next.id,next);return next};
  const code=await service.call(manager,'pair-code',{personId:'lv',host:'127.0.0.1'}),pairing=new Client(decodeCode(code.code));client=new Client(await pairing.pair());
  for(const category of ['创意图','SKU']){
   const folder='0904-吕慧芸-'+(category==='SKU'?'sku':category),root=path.join(dir,folder);await fs.mkdir(root);await fs.writeFile(path.join(root,'源文件.txt'),'editable');await fs.copyFile(path.join(__dirname,'../assets/icon.png'),path.join(root,'最终.png'));
   const exact=await client.rpc('archive-spec',{taskId:t.id,folder}),selected=await scanDelivery(root,exact,{automatic:true}),files=await Promise.all(selected.files.map(async({file,...f})=>({...f,sha256:await fileHash(file)})));
   const abandoned=await client.rpc('archive-prepare',{taskId:t.id,selfChecked:true,delivery:{version:1,namingVersion:4,folder,directories:selected.originalDirectories},files:files.map(f=>({...f,relativePath:'旧版-'+f.relativePath}))});
   const batch=await client.rpc('archive-prepare',{taskId:t.id,selfChecked:true,delivery:{version:1,namingVersion:4,folder,directories:selected.originalDirectories},files});
   assert.equal(service.store.get('upload',abandoned.id).status,'cancelled');
   for(let i=0;i<files.length;i++)await client.upload(batch.id,batch.files[i],selected.files[i].file);
   const archived=await client.rpc('archive-commit',{uploadId:batch.id});assert.equal(archived.sealed,false);assert.equal(archived.deliveries.length,category==='创意图'?1:2);
  }
  let current=service.store.get('task',t.id);assert.deepEqual(current.deliveries.map(d=>d.category),['creative','sku']);
  const file=service.store.all('asset')[0].files[0],original=await fs.readFile(file.path);
  await fs.unlink(file.path);await assert.rejects(client.rpc('archive-finish',{taskId:t.id,version:current.version}),/缺少文件/);
  assert.equal(service.store.get('task',t.id).sealed,false);
  await fs.writeFile(file.path,Buffer.alloc(original.length,1));await assert.rejects(client.rpc('archive-finish',{taskId:t.id,version:current.version}),/文件已改变/);
  await fs.writeFile(file.path,original);
  current=await client.rpc('archive-finish',{taskId:t.id,version:current.version});assert.equal(current.sealed,true);
  assert.equal(service.store.all('asset').length,2);for(const record of service.store.all('asset')){assert.equal(record.taskId,t.id);assert.equal(record.code,t.items[0].code);assert.ok(record.files.some(f=>f.name===(record.category==='sku'?'01-最终-SKU.png':'创意图01.png')));assert.ok(record.files.every(f=>f.path.includes(f.kind==='source'?'01.源文件':'02.导出图片')))}await assert.rejects(client.rpc('archive-spec',{taskId:t.id}),/尚不能封存/);
 }finally{client?.close();await service.stop()}
});


test('GIF exports join the same detail batch while project GIF textures stay sources',()=>{
 const {automaticNames}=require('../core/automatic-names.cjs');const s={...spec,category:'detail',base:'0910-朱文梅-详情页',expectedCount:null};const raw=classifyDelivery(s,s.base,[entry('images/动态.GIF'),entry('images/详情01.jpg'),entry('设计稿.psd'),entry('工程/模型.c4d'),entry('工程/纹理.gif')],['images','工程']);const named=automaticNames(s,raw);const gif=named.files.find(f=>f.relativePath==='images/动态.GIF');assert.equal(gif.kind,'output');assert.equal(gif.relative,s.base+'/动态.GIF');assert.equal(named.files.find(f=>f.relativePath==='工程/纹理.gif').kind,'source');
});

test('delivery date may differ from approval while owner, type and valid calendar day remain checked',()=>{
 const t=task();t.completedAt=Date.UTC(2026,8,10,4);const a=archiveSpec(t,null,'0911-吕慧芸-sku');assert.equal(a.base,'0911-吕慧芸-SKU');assert.equal(a.basePrefix,'0911-吕慧芸-');assert.equal(a.category,'sku');assert.throws(()=>archiveSpec(t,null,'0931-吕慧芸-SKU'),/命名/);assert.throws(()=>archiveSpec(t,null,'0911-常慧杰-SKU'),/命名/);assert.throws(()=>archiveSpec(t,null,'0911-吕慧芸-未知'),/命名/);assert.equal(archiveSpec(t,null,'0101-吕慧芸-主图').category,'main');
});

test('video-only delivery does not require a separate editable project',()=>{const s={...spec,base:'0911-吕慧芸-创意视频',category:'video',expectedCount:null};const result=classifyDelivery(s,s.base,[entry('成片.mp4')]);assert.equal(result.files[0].kind,'output');assert.equal(result.files.length,1)});
