'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {planSelection}=require('../desktop/delivery-selection.cjs'),{automaticNames}=require('../core/automatic-names.cjs'),{archiveSpec,validateTaskManifest}=require('../core/assets.cjs');
const task={id:'t',state:4,owner:'lv',version:1,completedAt:Date.UTC(2026,8,23,4),brand:'九芝堂',product:'产品',code:'6970855224163',items:[{id:'i',type:'complex',qty:1,product:'产品',brand:'九芝堂',code:'6970855224163'}]};
const info=archiveSpec(task),getSpec=async folder=>archiveSpec(task,null,folder);
async function dir(t,name,files){const temp=await fs.mkdtemp(path.join(os.tmpdir(),'naming-correction-')),root=path.join(temp,name);await fs.mkdir(root);t.after(()=>fs.rm(temp,{recursive:true,force:true}));for(const f of files){await fs.mkdir(path.dirname(path.join(root,f)),{recursive:true});await fs.writeFile(path.join(root,f),'test')}return root}
const manifest=selected=>validateTaskManifest(task,selected.files.map(f=>({...f,sha256:'a'.repeat(64)})),{version:1,namingVersion:4,folder:selected.folder,directories:selected.originalDirectories,naming:selected.naming});
test('nonstandard folder and duplicate source names are repaired identically on client and server',async t=>{
 const root=await dir(t,'9月24日_某人_创意图_final',['设计稿.psd','改稿.psd','成品.jpg','另一张.jpg']);const before=await fs.readdir(root);
 const result=await planSelection(root,info,getSpec);assert.equal(result.preview.namingIssues.length,0);assert.equal(result.batch.length,1);assert.equal(result.batch[0].folder,'0923-吕慧芸-创意图');
 const selection=result.batch[0],server=manifest(selection);assert.deepEqual(server.files.map(f=>f.relative),selection.files.map(f=>f.relative));assert.equal(new Set(server.files.map(f=>f.relative)).size,4);assert.ok(server.files.some(f=>f.name==='创意图01.jpg'));assert.ok(server.files.some(f=>f.name==='创意图02.jpg'));assert.deepEqual(await fs.readdir(root),before);
 const changed=await planSelection(root,info,getSpec,{repair:true,folders:{'':{category:'creative',date:'0924'}}});assert.equal(changed.batch[0].folder,'0924-吕慧芸-创意图');
});
test('unknown category stays correctable and no valid sibling hides unresolved folders',async t=>{
 const root=await dir(t,'总交付',['不规范名字/原稿.psd','不规范名字/成品.jpg','sku/原稿.psd','sku/红瓶.jpg']);
 const first=await planSelection(root,info,getSpec);assert.equal(first.preview.namingIssues[0].code,'category');assert.equal(first.batch.length,1);
 const next=await planSelection(root,info,getSpec,{repair:true,folders:{'不规范名字':{category:'detail',date:'0924'},sku:{category:'sku',date:'0924'}}});assert.equal(next.preview.namingIssues.length,0);assert.equal(next.batch.length,2);
 assert.match(next.preview.files.find(f=>f.relativePath==='红瓶.jpg').suggestedName,/01-红瓶-SKU.jpg/);
 const invalid=await planSelection(root,info,getSpec,{repair:true,folders:{'不规范名字':{category:'detail',date:'9932'}}});assert.ok(invalid.preview.namingIssues.length);
});
test('six-face corrections remain editable for missing and duplicate faces',async t=>{
 const root=await dir(t,'六面图',['源稿.psd','a.jpg','b.jpg']);let result=await planSelection(root,info,getSpec);assert.equal(result.preview.files.length,3);assert.equal(result.preview.namingIssues.length,2);
 const set=names=>({repair:true,folders:{'':{category:'six',date:'0924',outputNames:names}}});
 result=await planSelection(root,info,getSpec,set({'a.jpg':'正面.jpg','b.jpg':'正面.jpg'}));assert.equal(result.preview.namingIssues.length,2);assert.equal(result.preview.files.length,3);
 result=await planSelection(root,info,getSpec,set({'a.jpg':'正面.jpg','b.jpg':'背面.jpg'}));assert.equal(result.preview.namingIssues.length,0);assert.deepEqual(manifest(result.batch[0]).files.map(f=>f.relative),result.batch[0].files.map(f=>f.relative));
});
test('details can be renamed in the preview but paths and extension changes are rejected',async t=>{
 const root=await dir(t,'详情',['原稿.psd','a.jpg','组1/同名.jpg','组2/同名.jpg']);
 const payload=name=>({repair:true,folders:{'':{category:'detail',date:'0924',outputNames:{'a.jpg':name}}}});
 const result=await planSelection(root,info,getSpec,payload('产品详情.jpg'));assert.equal(result.preview.namingIssues.length,0);assert.ok(result.preview.files.some(f=>f.suggestedName==='产品详情.jpg'));assert.equal(new Set(result.preview.files.map(f=>f.relative)).size,4);assert.deepEqual(manifest(result.batch[0]).files.map(f=>f.relative),result.batch[0].files.map(f=>f.relative));
 for(const name of ['../escape.jpg','bad\\name.jpg','other.exe']){const rejected=await planSelection(root,info,getSpec,payload(name));assert.ok(rejected.preview.namingIssues.length)}
});
test('main groups keep dimension rules while repairing missing and duplicate sequences',()=>{
 const spec={category:'main',base:'0924-吕慧芸-主图'},raw={projectFolders:[],directories:[],files:[{kind:'source',relativePath:'稿.psd'},{kind:'output',relativePath:'red.jpg',width:750},{kind:'output',relativePath:'blue.jpg',width:750},{kind:'output',relativePath:'big.jpg',width:800}]};
 assert.throws(()=>automaticNames(spec,raw),/序号/);const result=automaticNames(spec,raw,{repair:true});assert.deepEqual(result.files.filter(f=>f.kind==='output').map(f=>f.name).sort(),['750主图01.jpg','750主图02.jpg','800主图01.jpg']);
 assert.throws(()=>automaticNames(spec,{...raw,files:[...raw.files,{kind:'output',relativePath:'wrong.jpg',width:640}]},{repair:true}),/750 或 800/);
});
test('whole project dependencies stay under their own renamed project folder',async t=>{
 const root=await dir(t,'工程final',['项目A/scene.c4d','项目A/tex/a.jpg','项目B/scene.c4d','项目B/tex/a.jpg']);const result=await planSelection(root,info,getSpec);assert.equal(result.preview.namingIssues.length,0);const names=result.preview.files.map(f=>f.relative);assert.equal(new Set(names).size,4);assert.equal(names.filter(n=>n.endsWith('/tex/a.jpg')).length,2);assert.deepEqual(manifest(result.batch[0]).files.map(f=>f.relative),result.batch[0].files.map(f=>f.relative));
});
test('corrected names upload to NAS, retry idempotently and preserve local files',async t=>{
 const {Store,digest}=require('../core/store.cjs'),{Nas,fileHash}=require('../core/nas.cjs'),{Assets}=require('../core/assets.cjs'),{createReadStream}=require('node:fs');
 const cleanups=[];const root=await dir({after:fn=>cleanups.push(fn)},'创意图最终',['第一稿.psd','第二稿.psd','无序号A.png','无序号B.png']);const base=path.dirname(root),taskRoot=path.join(base,'requests'),assetRoot=path.join(base,'assets');await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);
 for(const name of ['第一稿.psd','第二稿.psd'])await fs.writeFile(path.join(root,name),Buffer.concat([Buffer.from([56,66,80,83,0,1]),Buffer.alloc(24)]));for(const name of ['无序号A.png','无序号B.png'])await fs.copyFile(path.join(__dirname,'../assets/icon.png'),path.join(root,name));
 const store=new Store(path.join(base,'db')),nas=new Nas(store);await nas.connect({taskRoot,assetRoot});t.after(async()=>{await nas.release();store.close();for(const cleanup of cleanups)await cleanup()});const assets=new Assets(store,nas),actor={role:'designer',personId:'lv'};store.put('task',task.id,task);nas.readTask=async()=>Buffer.alloc(0);nas.sync=async(old,next)=>{store.put('task',next.id,next);return next};
 const selected=(await planSelection(root,info,getSpec)).batch[0],files=await Promise.all(selected.files.map(async({file,mtimeMs,...f})=>({...f,sha256:await fileHash(file)}))),payload={selfChecked:true,delivery:{version:1,namingVersion:4,folder:selected.folder,directories:selected.originalDirectories,naming:selected.naming},files};
 const upload=await assets.prepare(task,null,actor,payload);for(let i=0;i<files.length;i++)await assets.receive(upload.id,String(i),actor,createReadStream(selected.files[i].file),files[i].size);const done=await assets.commit(upload.id,actor);assert.equal(done.deliveries.length,1);assert.equal((await assets.prepare(done,null,actor,payload)).id,upload.id);
 const asset=store.get('asset',upload.id);for(let i=0;i<asset.files.length;i++){assert.equal(await fileHash(asset.files[i].path),files[i].sha256);assert.equal(await fileHash(selected.files[i].file),files[i].sha256)}const sealed=await assets.finish(task.id,actor,done.version);assert.equal(sealed.sealed,true);assert.equal((await assets.finish(task.id,actor,done.version)).sealed,true);
});
