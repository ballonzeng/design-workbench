'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {prepareHistoricalTasks}=require('../core/historical-tasks.cjs'),{planHistoricalArchive,archiveHistoricalPlan}=require('../core/historical-archive.cjs');
const task=()=>prepareHistoricalTasks([{owner:'lv',product:'包装产品（两套）',qty:2,completedDate:'2026-10-10'}],{now:Date.parse('2026-11-03T12:00:00+08:00')}).records[0];
async function fixture(t){
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'historical-archive-')),sourceRoot=path.join(root,'原始交付'),assetRoot=path.join(root,'资产库');
 await fsp.mkdir(sourceRoot);await fsp.mkdir(assetRoot);t.after(async()=>{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep+'historical-archive-'));await fsp.rm(resolved,{recursive:true,force:true})});
 return {root,sourceRoot,assetRoot,archiveDate:'2026-11-03'};
}
async function write(root,relative,bytes){const p=path.join(root,...relative.split('/'));await fsp.mkdir(path.dirname(p),{recursive:true});await fsp.writeFile(p,bytes);return p}
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('pending archive plans split by extension, preserve font folders and original names, and remain deterministic',async t=>{
 const f=await fixture(t),original=task();
 await write(f.sourceRoot,'包装设计.ai',Buffer.from('%PDF-source'));
 await write(f.sourceRoot,'预览/包装效果.PNG',Buffer.from([137,80,78,71,13,10,26,10]));
 await write(f.sourceRoot,'字体/字体名称.ttf',Buffer.from('font-data'));
 await write(f.sourceRoot,'说明.txt',Buffer.from('original-notes'));
 await fsp.mkdir(path.join(f.sourceRoot,'字体','空目录'),{recursive:true});
 const plan=await planHistoricalArchive(original,f),again=await planHistoricalArchive(original,f);
 assert.equal(plan.id,again.id);assert.equal(plan.identification,'pending-code');assert.equal(plan.code,null);assert.equal(plan.brand,null);assert.equal(plan.product,original.product);assert.equal(plan.author,'lv');assert.equal(plan.fileCount,4);
 assert.equal(plan.path,path.join(f.assetRoot,'_待69码定位','包装设计',original.product,'1103-吕慧芸-包装设计'));
 assert.equal(plan.deliveryFolder,'1103-吕慧芸-包装设计');
 const preview=plan.files.find(v=>v.name==='包装效果.PNG'),font=plan.files.find(v=>v.name==='字体名称.ttf');assert.equal(preview.kind,'output');assert.equal(font.kind,'source');assert.equal(font.sha256,hash(Buffer.from('font-data')));
 assert.equal(preview.path,path.join(plan.path,'02.导出图片','1103-吕慧芸-包装设计','预览','包装效果.PNG'));assert.equal(font.path,path.join(plan.path,'01.源文件','1103-吕慧芸-包装设计','字体','字体名称.ttf'));
 assert.ok(plan.directories.some(d=>d.kind==='source'&&d.relative==='1103-吕慧芸-包装设计/字体/空目录'));
 assert.equal((await fsp.readdir(f.assetRoot)).length,0);assert.equal(original.archiveStatus,'not-recorded');
});

test('copy-only publication verifies all bytes, writes immutable manifests, preserves originals and retries idempotently',async t=>{
 const f=await fixture(t);await write(f.sourceRoot,'源文件.psd',Buffer.from('editable-psd'));await write(f.sourceRoot,'图片.jpg',Buffer.from([255,216,255,0]));
 const plan=await planHistoricalArchive(task(),f),before=new Map(await Promise.all(plan.files.map(async v=>[v.relativePath,await fsp.readFile(v.sourcePath)]))),earliest=Date.now(),record=await archiveHistoricalPlan(plan);
 assert.equal(record.status,'archived');assert.equal(record.source,'historical-supplement-archive');assert.equal(record.fileCount,2);assert.equal(record.identification,'pending-code');assert.ok(record.at>=earliest);assert.equal(record.productPath,plan.productPath);assert.match(record.pendingReason,/69码/);
 for(const file of record.files){assert.deepEqual(await fsp.readFile(file.path),before.get(file.relativePath));assert.deepEqual(await fsp.readFile(path.join(f.sourceRoot,...file.relativePath.split('/'))),before.get(file.relativePath));assert.equal(file.sha256,hash(await fsp.readFile(file.path)))}
 const manifest=await fsp.readFile(record.manifestPath,'utf8'),intent=await fsp.readFile(path.join(plan.path,'_archive-plan.json'),'utf8');assert.equal(JSON.parse(intent).status,'planned');assert.equal(JSON.parse(manifest).status,'archived');
 const retry=await archiveHistoricalPlan(plan);assert.deepEqual(retry,record);assert.equal(await fsp.readFile(record.manifestPath,'utf8'),manifest);assert.equal(await fsp.readFile(path.join(plan.path,'_archive-plan.json'),'utf8'),intent);
 assert.equal(await fsp.readFile(record.files.find(v=>v.kind==='source').path,'utf8'),'editable-psd');
});

test('different content at an existing destination is preserved, incomplete runs have no final manifest and resume safely',async t=>{
 const f=await fixture(t);await write(f.sourceRoot,'a.ai','source-a');await write(f.sourceRoot,'b.ai','source-b');
 const plan=await planHistoricalArchive(task(),f),conflict=plan.files[1].path;await fsp.mkdir(path.dirname(conflict),{recursive:true});await fsp.writeFile(conflict,'foreign-content');
 await assert.rejects(archiveHistoricalPlan(plan),/未覆盖/);assert.equal(await fsp.readFile(conflict,'utf8'),'foreign-content');assert.equal(await fsp.readFile(plan.files[0].path,'utf8'),'source-a');
 await assert.rejects(fsp.stat(path.join(plan.path,'_archive-manifest.json')),e=>e.code==='ENOENT');
 await fsp.unlink(conflict);const record=await archiveHistoricalPlan(plan);assert.equal(record.status,'archived');assert.equal(await fsp.readFile(conflict,'utf8'),'source-b');
});

test('source file changes, added files and different source batches cannot bypass the frozen plan',async t=>{
 const f=await fixture(t);const file=await write(f.sourceRoot,'包装.ai','original');let plan=await planHistoricalArchive(task(),f);
 await fsp.writeFile(file,'modified');await assert.rejects(archiveHistoricalPlan(plan),/发生变化/);await assert.rejects(fsp.stat(path.join(plan.path,'_archive-manifest.json')),e=>e.code==='ENOENT');
 plan=await planHistoricalArchive(task(),f);await write(f.sourceRoot,'新增.txt','added');await assert.rejects(archiveHistoricalPlan(plan),/发生变化/);
 plan=await planHistoricalArchive(task(),f);await archiveHistoricalPlan(plan);
 const other=path.join(f.root,'另一份交付');await fsp.mkdir(other);await write(other,'其他.ai','new');const different=await planHistoricalArchive(task(),{...f,sourceRoot:other});await assert.rejects(archiveHistoricalPlan(different),/清单.*不一致/);assert.equal(await fsp.readFile(plan.files.find(v=>v.name==='包装.ai').path,'utf8'),'modified');
});

test('source links and destination links are rejected without following outside roots',async t=>{
 const f=await fixture(t),outside=path.join(f.root,'外部');await fsp.mkdir(outside);await write(outside,'不得归档.ai','outside');
 const link=path.join(f.sourceRoot,'链接目录');
 try{await fsp.symlink(outside,link,process.platform==='win32'?'junction':'dir')}catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('platform cannot create temporary links');return}throw e}
 await assert.rejects(planHistoricalArchive(task(),f),/链接/);await fsp.unlink(link);await write(f.sourceRoot,'正常.ai','inside');
 const plan=await planHistoricalArchive(task(),f),pending=path.join(f.assetRoot,'_待69码定位');await fsp.symlink(outside,pending,process.platform==='win32'?'junction':'dir');await assert.rejects(archiveHistoricalPlan(plan),/链接/);assert.deepEqual(await fsp.readdir(outside),['不得归档.ai']);
});

test('formal archive requires an existing uniquely specified matching barcode product directory and truthful brand',async t=>{
 const f=await fixture(t);await write(f.sourceRoot,'包装.ai','source');const productRoot=path.join(f.assetRoot,'实际品牌','实际产品-6970855224163');await fsp.mkdir(productRoot,{recursive:true});
 const plan=await planHistoricalArchive(task(),{...f,productRoot,brand:'实际品牌',code:'6970855224163'});assert.equal(plan.identification,'barcode-verified');assert.equal(plan.path,path.join(productRoot,'07.包装设计','1103-吕慧芸-包装设计'));assert.equal(plan.brand,'实际品牌');assert.equal(plan.code,'6970855224163');assert.equal(plan.pendingReason,null);
 const record=await archiveHistoricalPlan(plan);assert.equal(record.productPath,productRoot);assert.equal(record.identification,'barcode-verified');
 await assert.rejects(planHistoricalArchive(task(),{...f,productRoot,code:null}),/真实/);
 await assert.rejects(planHistoricalArchive(task(),{...f,productRoot,brand:'错误品牌',code:'6970855224163'}),/不一致/);
 await assert.rejects(planHistoricalArchive(task(),{...f,code:'6970855224163'}),/真实产品目录/);
 await assert.rejects(planHistoricalArchive(task(),{...f,productRoot,code:'6970855224164'}),/正式归档/);
});

test('tampered paths and plans fail closed while source-only deliveries are copied honestly as sources',async t=>{
 const f=await fixture(t);await write(f.sourceRoot,'只有源文件.ai','source');const plan=await planHistoricalArchive(task(),f);assert.equal(plan.files[0].kind,'source');
 const escaped=structuredClone(plan);escaped.files[0].path=path.join(f.root,'outside.ai');await assert.rejects(archiveHistoricalPlan(escaped),/固定布局/);await assert.rejects(fsp.stat(escaped.files[0].path),e=>e.code==='ENOENT');
 const changed=structuredClone(plan);changed.files[0].sha256='0'.repeat(64);await assert.rejects(archiveHistoricalPlan(changed),/计划无效/);
 const record=await archiveHistoricalPlan(plan);assert.equal(record.files.filter(v=>v.kind==='output').length,0);assert.equal(record.files.filter(v=>v.kind==='source').length,1);
});

test('an old UUID destination cannot be recreated by resubmitting a historical archive plan',async t=>{
 const f=await fixture(t);await write(f.sourceRoot,'包装.ai','editable');const original=task(),plan=await planHistoricalArchive(original,f),legacy=structuredClone(plan);
 legacy.path=path.join(plan.productPath,'任务-'+original.id);
 await assert.rejects(archiveHistoricalPlan(legacy),/目标路径不一致/);
 await assert.rejects(fsp.stat(legacy.path),e=>e.code==='ENOENT');
 assert.equal((await fsp.readdir(f.assetRoot)).length,0);
});
