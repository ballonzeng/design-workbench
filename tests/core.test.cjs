'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs'),os=require('node:os');
const R=require('../core/rules.cjs');const {transition}=R;const {validateManifest}=require('../core/assets.cjs');
function task(){return {id:'t',state:1,owner:'hong',version:1,items:[{id:'row-6',type:'complex',qty:1,product:'西红花',category:'main'}],elapsedMs:0}}
test('capacity and contribution standards remain points with former sets counted per image',()=>{
 assert.equal(21.75*8*.8,139.20000000000002);
 assert.deepEqual(['main-set','sku-set','sku-full','main-full'].map(id=>[R.rateFor(id).points,R.rateFor(id).unit]),[[.3,'张'],[.25,'张'],[.5,'张'],[.8,'张']]);
 assert.equal(R.itemPoints({type:'main-set',qty:5}),1.5);assert.equal(R.itemPoints({type:'sku-set',qty:4}),1);assert.equal(R.itemPoints({type:'sku-full',qty:4}),2);assert.equal(R.itemPoints({type:'main-full',qty:5}),4);
 assert.throws(()=>R.itemPoints({type:'main-full',qty:2,extra:3}),/超出张数/);assert.throws(()=>R.itemPoints({type:'photo-six',qty:5}));assert.equal(R.itemPoints({type:'complex',qty:1}),1.5);
});
test('legacy sheet names infer one asset category without overriding an exact category sheet',()=>{assert.equal(R.inferredCategory('basic',['方版主图','详情页']),'detail');assert.equal(R.inferredCategory('basic',['主图（5张）']),'main');assert.equal(R.inferredCategory('basic',['SKU','详情页']),null);assert.equal(require('../core/nas.cjs').folderName('产品 30g/支*9支'),'产品 30g／支×9支')});
test('NAS lease distinguishes a dead same-host process from an active owner',()=>{
 const {leaseOwnerOnline,LOCAL_LEASE_STALE_MS,REMOTE_LEASE_STALE_MS}=require('../core/nas.cjs'),now=Date.now(),host=os.hostname();
 assert.equal(leaseOwnerOnline({host,pid:999999999,at:now},host,now),false);
 assert.equal(leaseOwnerOnline({host,at:now-LOCAL_LEASE_STALE_MS+1},host,now),true);
 assert.equal(leaseOwnerOnline({host,at:now-LOCAL_LEASE_STALE_MS},host,now),false);
 assert.equal(leaseOwnerOnline({host:'ANOTHER-PC',at:now-REMOTE_LEASE_STALE_MS+1},host,now),true);
 assert.equal(leaseOwnerOnline({host:'ANOTHER-PC',at:now-REMOTE_LEASE_STALE_MS},host,now),false);
});
test('requirement filename keeps the short task title separate from the Excel product name',()=>{
 const {parseRequirementFilename,cellText,barcodeFromCell}=require('../core/workbook.cjs'),requestedAt=Date.UTC(2026,7,31,6);
 const result=parseRequirementFilename('26083114-九芝堂-静脉曲张袜男3-东洋-未分配.xlsx',{requestedAt,operator:'东洋',workbookDesigner:''});
 assert.equal(result.title,'静脉曲张袜男3');assert.equal(result.assignment,'未分配');assert.equal(cellText('6978189750020&#10;&#10;'),'6978189750020');assert.equal(barcodeFromCell('产品：6978189750020\n'),'6978189750020');
 const tolerated=parseRequirementFilename('26083114- 九芝堂 - 静脉曲张袜男3 - 东洋 - 未分配.xlsx',{requestedAt,operator:'东洋',workbookDesigner:''});assert.equal(tolerated.brand,'九芝堂');assert.equal(tolerated.title,'静脉曲张袜男3');
 assert.throws(()=>parseRequirementFilename('20260831-九芝堂-静脉曲张袜男3-东洋-未分配.xlsx',{requestedAt,operator:'东洋',workbookDesigner:''}),e=>e.reasons.some(x=>x.includes('年月日时')));
 const tenChars=parseRequirementFilename('26083114-九芝堂-静脉曲张袜男三号新款-东洋-未分配.xlsx',{requestedAt,operator:'东洋',workbookDesigner:''});assert.equal([...tenChars.title].length,10);
 assert.throws(()=>parseRequirementFilename('26083114-九芝堂-超过十个字的任务名称呀-东洋-未分配.xlsx',{requestedAt,operator:'东洋',workbookDesigner:''}),e=>e.reasons.some(x=>x.includes('最多 10 个字')));
 assert.throws(()=>barcodeFromCell('6978189750020 6978189750021'),/多个产品69码/);
});
test('owner and state guards, elapsed time and rework persist',()=>{
 const actor={role:'designer',personId:'hong'};let t=task();assert.throws(()=>transition(t,{role:'designer',personId:'lv'},'start',{version:1}));
 t=transition(t,actor,'start',{version:1},1000).task;t=transition(t,actor,'pause',{version:2,reason:'等待素材'},11000).task;
 assert.equal(t.elapsedMs,10000);t=transition(t,actor,'resume',{version:3},21000).task;t=transition(t,actor,'review',{version:4},31000).task;assert.equal(t.elapsedMs,20000);
 t=transition(t,actor,'rework',{version:5},41000).task;assert.equal(R.elapsed(t,46000),25000);
 assert.throws(()=>transition(t,actor,'approve',{version:6,chatConfirmed:true}));
});
test('filename and asset manifests reject traversal, duplicates, wrong pairing and counts',()=>{
 for(const n of ['../x','a/b','x:foo','CON','x.',' 名'])assert.throws(()=>R.safeName(n));
 const t={...task(),state:4,completedAt:Date.UTC(2026,8,3,4)},item=t.items[0],base='0903-洪华-主图';
 const source={kind:'source',name:base+'.psd',size:100,sha256:'a'.repeat(64)};
 const output={kind:'output',name:'主图01.png',folder:base,size:100,sha256:'b'.repeat(64)};
 assert.equal(validateManifest(t,item,[source,output]).files.length,2);
 assert.throws(()=>validateManifest(t,item,[source,{...output,folder:'最终版'}]));
 assert.throws(()=>validateManifest(t,item,[source,output,{...output,name:'主图02.png'}]));
 assert.throws(()=>validateManifest(t,item,[{...source,name:'0903-小洪-主图.psd'},output]));
});
test('database survives process restart and transaction rollback',()=>{
 const {Store}=require('../core/store.cjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'design-store-'));let s=new Store(dir);s.put('task','one',{value:1});
 assert.throws(()=>s.atomic(()=>{s.put('task','one',{value:2});throw Error('rollback')}));assert.equal(s.get('task','one').value,1);s.close();s=new Store(dir);assert.equal(s.get('task','one').value,1);s.close();
});
test('existing task points migrate once from set multiplication to individual image counting',()=>{
 const {Service}=require('../core/service.cjs');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'design-rate-migration-')),service=new Service(path.join(dir,'db'),{host:'127.0.0.1',port:0});
 const old={id:'old-rate',state:2,version:7,updatedAt:1,items:[{id:'a',type:'creative',qty:2,points:4},{id:'b',type:'main-set',qty:5,points:7.5,extra:0}]};service.store.put('task',old.id,old);
 assert.equal(service.migrateContributionStandard(),1);const migrated=service.store.get('task',old.id);assert.equal(migrated.items[1].points,1.5);assert.equal(migrated.items.reduce((sum,item)=>sum+item.points,0),5.5);assert.equal(migrated.version,8);
 assert.equal(service.migrateContributionStandard(),0);assert.equal(service.store.events(old.id).filter(event=>event.kind==='contribution-standard-updated').length,1);service.store.close();
});
test('multiple requirement rows of the same asset type archive as one complete group',()=>{
 const {archiveSpec}=require('../core/assets.cjs');const t={...task(),completedAt:Date.UTC(2026,8,3,4)};
 t.items.push({...t.items[0],id:'row-7',type:'simple',qty:2});
 assert.equal(archiveSpec(t,t.items[0]).expectedCount,3);
});
test('archive recovery restores the index after workbook commit without repeating file uploads',async()=>{
 const {Assets}=require('../core/assets.cjs'),{Store}=require('../core/store.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'design-recovery-')),store=new Store(path.join(dir,'db'));
 const item={id:'i',category:'main',sealed:true,assetId:'upload-1',sealedAt:1000,code:'6970855224163',brand:'九芝堂',assetPath:path.join(dir,'assets','九芝堂','西红花-6970855224163','02.主图')};
 const t={id:'t',state:4,owner:'hong',items:[item],sealed:true},u={id:'upload-1',taskId:'t',itemId:'i',actor:'hong',status:'publishing',product:{name:'西红花-6970855224163'},files:[],published:{}};
 store.put('task','t',t);store.put('upload',u.id,u);
 const nas={config:{taskRoot:path.join(dir,'requests'),assetRoot:path.join(dir,'assets')}},assets=new Assets(store,nas);
 await assets.recover();assert.equal(store.get('upload',u.id).status,'done');assert.equal(store.get('asset',u.id).code,item.code);
 await assets.commit(u.id,{role:'designer',personId:'hong'});assert.equal(store.all('asset').length,1);store.close();
});
test('deleted archived files reopen the task while partial loss stays blocked with a clear issue',async()=>{
 const {Assets}=require('../core/assets.cjs'),{Store}=require('../core/store.cjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'design-asset-reconcile-')),assetRoot=path.join(dir,'assets');fs.mkdirSync(assetRoot);
 const store=new Store(path.join(dir,'db')),nas={config:{assetRoot},ready:async()=>{}},assets=new Assets(store,nas);
 const make=(id,files)=>{
  const item={id:'item-'+id,category:'main',sealed:true,assetId:'asset-'+id,assetPath:assetRoot};
  store.put('task','task-'+id,{id:'task-'+id,state:4,owner:'hong',version:4,items:[item],sealed:true,sealedAt:100});
  store.put('asset','asset-'+id,{id:'asset-'+id,taskId:'task-'+id,itemId:item.id,itemIds:[item.id],files:files.map(file=>({path:file}))});
  store.put('upload','asset-'+id,{id:'asset-'+id,taskId:'task-'+id,itemId:item.id,actor:'hong',status:'done',manifestHash:id});
 };
 const gone=[path.join(assetRoot,'gone.psd'),path.join(assetRoot,'gone.png')];make('gone',gone);
 const partial=[path.join(assetRoot,'kept.psd'),path.join(assetRoot,'lost.png')];fs.writeFileSync(partial[0],'kept');make('partial',partial);
 const result=await assets.reconcileMissingAssets();
 assert.equal(result.reopened,1);assert.equal(result.partial,1);
 const reopened=store.get('task','task-gone');assert.equal(reopened.sealed,false);assert.equal(reopened.items[0].sealed,false);assert.equal(reopened.items[0].assetId,undefined);
 assert.ok(store.get('asset','asset-gone').missingAt);assert.equal(store.get('upload','asset-gone').status,'cancelled');
 const blocked=store.get('task','task-partial');assert.equal(blocked.sealed,true);assert.match(blocked.assetSyncIssue.message,/缺少 1 \/ 2/);
 fs.writeFileSync(partial[1],'restored');await assets.reconcileMissingAssets();assert.equal(store.get('task','task-partial').assetSyncIssue,undefined);
 store.close();
});
