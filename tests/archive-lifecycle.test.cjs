'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Readable}=require('node:stream');
const {Store,digest}=require('../core/store.cjs'),{Nas,fileHash}=require('../core/nas.cjs'),{Assets,archiveSpec}=require('../core/assets.cjs');
const actor={role:'designer',personId:'lv'};

async function setup(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'archive-lifecycle-'));
 const store=new Store(path.join(root,'db')),nas=new Nas(store),assets=new Assets(store,nas);
 const taskRoot=path.join(root,'requests'),assetRoot=path.join(root,'assets');
 await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);await nas.connect({taskRoot,assetRoot});
 t.after(async()=>{await nas.release();store.close();await fs.rm(root,{recursive:true,force:true})});
 const task={id:crypto.randomUUID(),state:4,owner:'lv',version:1,completedAt:Date.UTC(2026,8,3,4),brand:'九芝堂',product:'西红花',code:'6970855224163',items:[{id:'i',row:6,type:'complex',qty:1,category:null,brand:'九芝堂',product:'西红花',code:'6970855224163'}]};
 store.put('task',task.id,task);
 nas.sync=async(_old,next,_patch,event)=>{store.atomic(()=>{store.put('task',next.id,next);store.event(event.kind,event.actor,next.id,event.body)});return next};
 nas.readTask=async()=>Buffer.alloc(0);
 const bytes=[Buffer.from('editable source'),await fs.readFile(path.join(__dirname,'../assets/icon.png'))];
 const payload=(name='源文件.txt')=>({selfChecked:true,delivery:{version:1,namingVersion:4,folder:'0903-吕慧芸-创意图',directories:[]},files:bytes.map((b,i)=>({relativePath:i?'最终.png':name,size:b.length,sha256:digest(b)}))});
 const current=()=>store.get('task',task.id);
 const prepare=(p=payload())=>assets.prepare(current(),null,actor,p);
 const receive=async u=>{for(const f of u.files)await assets.receive(u.id,f.id,actor,Readable.from([bytes[Number(f.id)]]),f.size)};
 const publish=async()=>{const u=await prepare();await receive(u);await assets.commit(u.id,actor);return store.get('upload',u.id)};
 return {root,store,nas,assets,task,bytes,payload,current,prepare,receive,publish};
}

test('a replaced fully received upload cannot publish or resurrect a cancelled category',async t=>{
 const h=await setup(t),old=await h.prepare();await h.receive(old);
 await h.prepare(h.payload('新版源文件.txt'));
 assert.equal(h.store.get('upload',old.id).status,'cancelled');
 await assert.rejects(h.assets.commit(old.id,actor),/取消|替代|失效/);
 assert.equal(h.current().deliveries?.length||0,0);assert.equal(h.store.all('asset').length,0);
});

test('unfinished uploads from a previous round cannot prevent the current round from sealing',async t=>{
 const h=await setup(t),old=await h.prepare();
 h.store.put('task',h.task.id,{...h.current(),archiveRound:1});
 await h.publish();
 const done=await h.assets.finish(h.task.id,actor,h.current().version);
 assert.equal(done.sealed,true);await assert.rejects(h.assets.commit(old.id,actor),/回退前/);
});

test('the upload stays bound to its approved task content, even without a version change',async t=>{
 const h=await setup(t),u=await h.prepare();await h.receive(u);
 h.store.put('task',h.task.id,{...h.current(),completedAt:h.task.completedAt+3600000});
 await assert.rejects(h.assets.commit(u.id,actor),/变化|变更|重新选择/);
 assert.equal(h.store.all('asset').length,0);
});

test('an older noncancelled batch cannot add a second delivery of the same category',async t=>{
 const h=await setup(t),old=await h.prepare(h.payload('旧源文件.txt'));await h.receive(old);
 const newer=await h.prepare();await h.receive(newer);await h.assets.commit(newer.id,actor);
 h.store.put('upload',old.id,{...h.store.get('upload',old.id),status:'uploading'});
 await assert.rejects(h.assets.commit(old.id,actor),/已经归档|已有归档/);
 assert.deepEqual(h.current().deliveries.map(d=>d.id),[newer.id]);
});

test('the file transfer lock is acquired before the first awaited NAS check',async t=>{
 const h=await setup(t),u=await h.prepare(),file=u.files[0];
 const ready=h.nas.ready.bind(h.nas);let release;const gate=new Promise(resolve=>release=resolve);
 h.nas.ready=async()=>{await gate;await ready()};
 const first=h.assets.receive(u.id,file.id,actor,Readable.from([h.bytes[0]]),file.size);
 const second=h.assets.receive(u.id,file.id,actor,Readable.from([h.bytes[0]]),file.size);
 const both=Promise.allSettled([first,second]);release();
 const results=await both;assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(h.assets.inflight.size,0);
 assert.equal(await fileHash(path.join(u.stage,file.id+'.part')),file.sha256);
});

test('a transfer rechecks cancellation after an awaited NAS check and releases its lock',async t=>{
 const h=await setup(t),u=await h.prepare(),file=u.files[0];let release,entered;
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),ready=h.nas.ready.bind(h.nas);
 h.nas.ready=async()=>{entered();await gate;await ready()};
 const pending=h.assets.receive(u.id,file.id,actor,Readable.from([h.bytes[0]]),file.size);
 const rejected=assert.rejects(pending,/取消|失效|状态/);await started;
 h.store.put('upload',u.id,{...h.store.get('upload',u.id),status:'cancelled'});release();await rejected;
 assert.equal(h.assets.inflight.size,0);assert.equal(h.store.get('upload',u.id).received[file.id],undefined);
});

test('a lost commit response can retry preparation and completion without duplicate records',async t=>{
 const h=await setup(t),u=await h.publish(),version=h.current().version;
 const retry=await h.prepare();assert.equal(retry.id,u.id);assert.equal(retry.status,'done');
 await h.assets.commit(retry.id,actor);assert.equal(h.current().version,version);
 const sealed=await h.assets.finish(h.task.id,actor,version);
 const repeated=await h.assets.finish(h.task.id,actor,version);
 assert.equal(repeated.version,sealed.version);assert.equal(repeated.sealedAt,sealed.sealedAt);
 assert.equal(h.store.all('asset').length,1);assert.equal(h.store.events(h.task.id).filter(e=>e.kind==='sealed').length,1);
});

test('resuming a batch rechecks received markers so missing staging files can be uploaded again',async t=>{
 const h=await setup(t),u=await h.prepare();await h.receive(u);
 await fs.unlink(path.join(u.stage,'0.part'));
 const retry=await h.prepare();assert.equal(retry.id,u.id);assert.equal(retry.received['0'],undefined);assert.ok(retry.received['1']);
 await h.assets.receive(u.id,'0',actor,Readable.from([h.bytes[0]]),h.bytes[0].length);
 await h.assets.commit(u.id,actor);assert.equal(h.current().deliveries.length,1);
});

test('a blocked workbook cannot be bypassed by the final seal command',async t=>{
 const h=await setup(t);await h.publish();h.store.put('task',h.task.id,{...h.current(),blocked:'文件同步待恢复'});
 await assert.rejects(h.assets.finish(h.task.id,actor,h.current().version),/同步|恢复/);assert.equal(h.current().sealed,false);
});

test('recovery can use verified published files when their staging copies are gone',async t=>{
 const h=await setup(t),u=await h.prepare();await h.receive(u);
 const sync=h.nas.sync;h.nas.sync=async()=>{throw Error('Excel 占用')};
 await assert.rejects(h.assets.commit(u.id,actor),/Excel/);
 const pending=h.store.get('upload',u.id);assert.equal(Object.keys(pending.published).length,u.files.length);
 await fs.rm(u.stage,{recursive:true,force:true});h.nas.sync=sync;
 assert.equal(await h.assets.retryPending(h.task.id),1);assert.equal(h.current().deliveries.length,1);
 assert.equal(h.store.get('upload',u.id).status,'done');
});

test('a commit excludes late file transfers until publication and cleanup have finished',async t=>{
 const h=await setup(t),u=await h.prepare();await h.receive(u);
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),ready=h.nas.ready.bind(h.nas);
 h.nas.ready=async()=>{entered();await gate;await ready()};
 const committing=h.assets.commit(u.id,actor);await started;
 try{await assert.rejects(h.assets.receive(u.id,'0',actor,Readable.from([h.bytes[0]]),h.bytes[0].length),/校验|归档|处理/)}finally{release()}
 await committing;assert.equal(h.assets.busy.size,0);assert.equal(h.current().deliveries.length,1);
});

test('resuming a batch excludes new transfers while received files are being rechecked',async t=>{
 const h=await setup(t),u=await h.prepare();await h.receive(u);
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),verify=h.assets.verified.bind(h.assets);
 h.assets.verified=async(...args)=>{entered();await gate;return verify(...args)};
 const resuming=h.prepare();await started;
 try{await assert.rejects(h.assets.receive(u.id,'0',actor,Readable.from([h.bytes[0]]),h.bytes[0].length),/校验|归档|处理/)}finally{release()}
 assert.equal(Object.keys((await resuming).received).length,2);assert.equal(h.assets.busy.size,0);
});

test('a rejected staging path releases the transfer lock and allows a corrected retry',async t=>{
 const h=await setup(t),u=await h.prepare(),outside=path.join(h.root,'outside');await fs.mkdir(outside);await fs.rm(u.stage,{recursive:true});
 await fs.symlink(outside,u.stage,process.platform==='win32'?'junction':'dir');
 await assert.rejects(h.assets.receive(u.id,'0',actor,Readable.from([h.bytes[0]]),h.bytes[0].length),/链接/);
 assert.equal(h.assets.inflight.size,0);assert.deepEqual(await fs.readdir(outside),[]);
 await fs.unlink(u.stage);await fs.mkdir(u.stage);await h.receive(u);
 assert.equal(Object.keys(h.store.get('upload',u.id).received).length,2);
});

test('cancelling during a transfer discards partial data and never restores a received marker',async t=>{
 const h=await setup(t),u=await h.prepare();let release,entered;
 const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const stream=Readable.from((async function*(){yield h.bytes[0].subarray(0,4);entered();await gate;yield h.bytes[0].subarray(4)})());
 const rejected=assert.rejects(h.assets.receive(u.id,'0',actor,stream,h.bytes[0].length),/取消|失效/);await started;
 h.store.put('upload',u.id,{...h.store.get('upload',u.id),status:'cancelled'});release();await rejected;
 assert.equal(h.assets.inflight.size,0);assert.equal(h.store.get('upload',u.id).received['0'],undefined);
 await assert.rejects(fs.access(path.join(u.stage,'0.part')),{code:'ENOENT'});
});

test('corrupt staging data is cleared for retransmission before any official files are created',async t=>{
 const h=await setup(t),u=await h.prepare();await h.receive(u);
 await fs.writeFile(path.join(u.stage,'1.part'),Buffer.alloc(h.bytes[1].length,1));
 await assert.rejects(h.assets.commit(u.id,actor),/暂存文件/);assert.equal(h.assets.busy.size,0);
 const first=path.join(u.category.source,u.files[0].relative);await assert.rejects(fs.access(first),{code:'ENOENT'});
 const retry=await h.prepare();assert.equal(retry.received['1'],undefined);assert.ok(retry.received['0']);
 await h.assets.receive(u.id,'1',actor,Readable.from([h.bytes[1]]),h.bytes[1].length);await h.assets.commit(u.id,actor);
 assert.equal(h.current().deliveries.length,1);
});

test('a publishing batch can replenish a missing file without replacing its surviving official files',async t=>{
 const h=await setup(t),u=await h.prepare();await h.receive(u);const sync=h.nas.sync;h.nas.sync=async()=>{throw Error('Excel 占用')};
 await assert.rejects(h.assets.commit(u.id,actor),/Excel/);const pending=h.store.get('upload',u.id),kept=await fs.stat(pending.published['1']);
 await fs.rm(u.stage,{recursive:true,force:true});await fs.unlink(pending.published['0']);
 const resumed=await h.prepare();assert.equal(resumed.status,'publishing');assert.equal(resumed.received['0'],undefined);assert.ok(resumed.received['1']);
 await h.assets.receive(u.id,'0',actor,Readable.from([h.bytes[0]]),h.bytes[0].length);h.nas.sync=sync;await h.assets.commit(u.id,actor);
 assert.equal((await fs.stat(pending.published['1'])).mtimeMs,kept.mtimeMs);assert.equal(h.current().deliveries.length,1);
});

test('idempotent sealing only accepts the original completion version or the current version',async t=>{
 const h=await setup(t),u=await h.publish(),version=h.current().version;await h.assets.finish(h.task.id,actor,version);
 assert.equal((await h.prepare()).id,u.id);await assert.rejects(h.assets.finish(h.task.id,actor,version-1),/更新/);
 h.store.put('task',h.task.id,{...h.current(),version:h.current().version+1,title:'补充标题'});
 await assert.rejects(h.assets.finish(h.task.id,actor,version),/更新/);
 assert.equal((await h.assets.finish(h.task.id,actor,h.current().version)).sealed,true);
});

test('legacy and task-level clients share the same category uniqueness rule',async t=>{
 const h=await setup(t);h.store.put('task',h.task.id,{...h.current(),items:h.current().items.map(i=>({...i,category:'creative'}))});
 const base='0903-吕慧芸-创意图',legacy={selfChecked:true,files:[{name:base+'.psd',kind:'source',size:h.bytes[0].length,sha256:digest(h.bytes[0])},{name:'创意图01.png',kind:'output',folder:base,size:h.bytes[1].length,sha256:digest(h.bytes[1])}]};
 const oldUpload=await h.assets.prepare(h.current(),'i',actor,legacy);
 await h.publish();await assert.rejects(h.assets.prepare(h.current(),'i',actor,legacy),/已经归档|已有归档/);
 assert.equal(h.store.get('upload',oldUpload.id).status,'cancelled');
 h.store.put('upload',oldUpload.id,{...h.store.get('upload',oldUpload.id),status:'uploading'});
 await assert.rejects(h.assets.commit(oldUpload.id,actor),/已经归档|已有归档/);
 const second=await setup(t),old={...second.current()};old.items[0]={...old.items[0],category:'creative'};second.store.put('task',old.id,old);
 const modernUpload=await second.prepare();old.items[0]={...old.items[0],sealed:true,assetId:'legacy'};second.store.put('task',old.id,old);
 await assert.rejects(second.prepare(),/已经归档|已有归档/);
 await assert.rejects(second.assets.commit(modernUpload.id,actor),/已经归档|已有归档/);
 assert.ok(!archiveSpec(second.current(),null).categories.some(c=>c.id==='creative'));
 assert.throws(()=>archiveSpec(second.current(),null,base),/已经归档/);
});

test('a category awaiting publication cannot be replaced by switching client versions',async t=>{
 const h=await setup(t);h.store.put('task',h.task.id,{...h.current(),items:h.current().items.map(i=>({...i,category:'creative'}))});
 const base='0903-吕慧芸-创意图',legacy={selfChecked:true,files:[{name:base+'.psd',kind:'source',size:h.bytes[0].length,sha256:digest(h.bytes[0])},{name:'创意图01.png',kind:'output',folder:base,size:h.bytes[1].length,sha256:digest(h.bytes[1])}]};
 const u=await h.prepare();await h.receive(u);h.nas.sync=async()=>{throw Error('Excel 占用')};
 await assert.rejects(h.assets.commit(u.id,actor),/Excel/);
 await assert.rejects(h.assets.prepare(h.current(),'i',actor,legacy),/正在恢复/);assert.equal(h.store.all('upload').length,1);
 const second=await setup(t);second.store.put('task',second.task.id,{...second.current(),items:second.current().items.map(i=>({...i,category:'creative'}))});
 const legacyUpload=await second.assets.prepare(second.current(),'i',actor,legacy);second.store.put('upload',legacyUpload.id,{...legacyUpload,status:'publishing'});
 await assert.rejects(second.prepare(),/正在恢复/);assert.equal(second.store.all('upload').length,1);
});
