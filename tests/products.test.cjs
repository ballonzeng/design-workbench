'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {Store}=require('../core/store.cjs');const {Products,splitProductName,dice}=require('../core/products.cjs');

test('product names split common specifications without weakening the barcode key',()=>{
 assert.deepEqual(splitProductName('西红花 30袋'),{original:'西红花 30袋',base:'西红花',spec:'30袋'});
 assert.deepEqual(splitProductName('西红花（升级包装）'),{original:'西红花(升级包装)',base:'西红花',spec:'升级包装'});
 assert.ok(dice('左旋肉碱黑咖啡','左旋肉碱黑咖啡粉')>=.86);
});

test('same-name new barcode joins a virtual family but keeps an independent NAS destination',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'product-index-')),assetRoot=path.join(dir,'assets'),brandDir=path.join(assetRoot,'九芝堂');await fs.mkdir(path.join(brandDir,'西红花 30袋-6970855224163'),{recursive:true});
 const store=new Store(path.join(dir,'db')),nas={config:{assetRoot}},products=new Products(store,nas);
 await products.sync();
 const exact=await products.match({brand:'九芝堂',product:'西红花 30袋',code:'6970855224163'});assert.equal(exact.status,'exact');assert.match(exact.destination,/6970855224163$/);
 const next=await products.match({brand:'九芝堂',product:'西红花 60袋',code:'6970855224999'});assert.equal(next.status,'same-series');assert.equal(next.decisionRequired,true);assert.match(next.destination,/西红花 60袋-6970855224999$/);
 const resolution=await products.confirm({brand:'九芝堂',product:'西红花 60袋',code:'6970855224999'},{mode:'group',groupId:next.recommendedGroupId});
 products.recordArchive({brand:'九芝堂',product:'西红花 60袋',code:'6970855224999'},{path:next.destination},resolution);
 const group=products.all()[0];assert.equal(group.variants.length,2);assert.deepEqual(group.variants.map(item=>item.code).sort(),['6970855224163','6970855224999']);assert.notEqual(group.variants[0].path,group.variants[1].path);store.close();
});

test('fuzzy candidate requires a designer decision and manager can maintain aliases and regroup',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'product-fuzzy-')),assetRoot=path.join(dir,'assets');await fs.mkdir(assetRoot);const store=new Store(path.join(dir,'db')),products=new Products(store,{config:{assetRoot}});
 let group=products.create('九芝堂','左旋肉碱黑咖啡');group=products.addVariant(group,{code:'6970855224001',name:'左旋肉碱黑咖啡',spec:'',path:path.join(assetRoot,'九芝堂','左旋肉碱黑咖啡-6970855224001')});products.update('zeng',{groupId:group.id,canonicalName:group.canonicalName,aliases:'燃脂黑咖啡'});
 const fuzzy=await products.match({brand:'九芝堂',product:'左旋肉碱黑咖啡粉',code:'6970855224002'});assert.equal(fuzzy.status,'fuzzy');await assert.rejects(products.confirm({brand:'九芝堂',product:'左旋肉碱黑咖啡粉',code:'6970855224002'}),/确认产品系列/);
 const linked=await products.confirm({brand:'九芝堂',product:'左旋肉碱黑咖啡粉',code:'6970855224002'},{mode:'group',groupId:group.id});products.recordArchive({brand:'九芝堂',product:'左旋肉碱黑咖啡粉',code:'6970855224002'},{path:path.join(assetRoot,'九芝堂','左旋肉碱黑咖啡粉-6970855224002')},linked);
 let groups=products.all();assert.equal(groups[0].variants.length,2);groups=products.moveVariant('zeng',{code:'6970855224002',targetGroupId:'new'});assert.equal(groups.length,2);assert.equal(groups.reduce((sum,item)=>sum+item.variants.length,0),2);assert.ok(groups.some(item=>item.canonicalName==='左旋肉碱黑咖啡粉'));store.close();
});

test('explicit independent choice keeps the full product name as a separate family',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'product-independent-')),assetRoot=path.join(dir,'assets');await fs.mkdir(assetRoot);const store=new Store(path.join(dir,'db')),products=new Products(store,{config:{assetRoot}});
 let original=products.create('九芝堂','西红花');original=products.addVariant(original,{code:'6970855224101',name:'西红花 30袋',spec:'30袋',path:path.join(assetRoot,'九芝堂','西红花 30袋-6970855224101')});
 const item={brand:'九芝堂',product:'西红花 60袋',code:'6970855224102'},match=await products.match(item);assert.equal(match.status,'same-series');
 const resolution=await products.confirm(item,{mode:'new'});products.recordArchive(item,{path:path.join(assetRoot,'九芝堂','西红花 60袋-6970855224102')},resolution);
 const groups=products.all();assert.equal(groups.length,2);assert.ok(groups.some(group=>group.canonicalName==='西红花 60袋'));store.close();
});

test('specification asterisk is normalized for directories while original product and code stay intact',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'product-spec-')),assetRoot=path.join(dir,'assets');await fs.mkdir(assetRoot);const store=new Store(path.join(dir,'db')),products=new Products(store,{config:{assetRoot}});
 try{const item={brand:'九芝堂',product:'茯湿轻养B420即食益生菌 14g（2g*7）',code:'6921832506376'},match=await products.match(item);assert.ok(match.destination.includes('2g×7'));assert.equal(item.product,'茯湿轻养B420即食益生菌 14g（2g*7）');assert.ok(match.destination.endsWith('-6921832506376'));const group=products.create(item.brand,item.product,Date.now(),true);assert.ok(group.canonicalName.includes('2g×7'));}finally{store.close()}
});

test('unique existing barcode directory bypasses request product and brand naming checks',async()=>{
 const {Nas}=require('../core/nas.cjs');const dir=await fs.mkdtemp(path.join(os.tmpdir(),'code-first-')),assetRoot=path.join(dir,'assets'),existing=path.join(assetRoot,'九芝堂','原产品-6921832506376');await fs.mkdir(existing,{recursive:true});const store=new Store(path.join(dir,'db')),nas={config:{assetRoot},ready:async()=>{}},products=new Products(store,nas);
 try{const item={brand:'无效/品牌',product:'.',code:'6921832506376'};const match=await products.match(item);assert.equal(match.status,'exact');assert.equal(match.destination,existing);assert.equal((await Nas.prototype.productDirectory.call(nas,item)).path,existing);await assert.rejects(products.match({...item,code:'6921832506377'}),/品牌/);const duplicate=path.join(assetRoot,'其他品牌','另一个-6921832506376');await fs.mkdir(duplicate,{recursive:true});await assert.rejects(Nas.prototype.productDirectory.call(nas,item),/多个产品目录/);}finally{store.close()}
});

test('directory index persists across restarts and manual refresh discovers new folders',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'product-cache-')),assetRoot=path.join(dir,'assets');await fs.mkdir(assetRoot);const store=new Store(path.join(dir,'db')),products=new Products(store,{config:{assetRoot}});
 try{let scans=0;const discover=products.discoveries.bind(products);products.discoveries=()=>{scans++;return discover()};await products.sync();await products.sync();assert.equal(scans,1);
 await fs.mkdir(path.join(assetRoot,'九芝堂','西红花-6970855224163'),{recursive:true});assert.equal((await products.sync()).length,0);assert.equal((await products.sync({force:true})).length,1);assert.equal(scans,2);
 products.lastScanAt=Date.now()-61000;await products.sync();assert.equal(scans,2);
 const restarted=new Products(store,{config:{assetRoot}});restarted.discoveries=()=>{throw Error('cached reads must not scan NAS')};assert.equal((await restarted.sync()).length,1);
 await assert.rejects(restarted.sync({force:true}),/must not scan/);assert.equal(restarted.all().length,1);
 }finally{store.close();await fs.rm(dir,{recursive:true,force:true})}
});
