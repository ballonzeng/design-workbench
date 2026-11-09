'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite'),{zipSync,strToU8}=require('fflate');
const {Store}=require('../core/store.cjs'),{unpack,mergedValue}=require('../core/workbook.cjs'),{snapshot}=require('../scripts/backfill-packaging-2026-11.cjs');
const {TASK,UPLOAD,runRepair}=require('../scripts/repair-archive-path-2026-11.cjs');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const read=filename=>JSON.parse(fs.readFileSync(filename,'utf8'));
function workbook(value){const escape=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;');return Buffer.from(zipSync(Object.fromEntries(Object.entries({
 'xl/workbook.xml':'<workbook><sheets><sheet name="【状态】" r:id="rId1"/></sheets></workbook>',
 'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
 'xl/styles.xml':'<styleSheet><cellXfs><xf><protection locked="0"/></xf></cellXfs></styleSheet>',
 'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row r="4"><c r="L4" t="inlineStr"><is><t>'+escape(value)+'</t></is></c><c r="M4"><v>46325</v></c></row></sheetData></worksheet>'
}).map(([key,value])=>[key,strToU8(value)]))))}
async function setup(t,{oldAddress=false}={}){
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'archive-path-repair-fixture-')),assetRoot=path.join(root,'assets'),taskRoot=path.join(root,'requests'),dbPath=path.join(root,'db','workbench.sqlite'),outputDir=path.join(root,'receipts');
 const productRoot=path.join(assetRoot,'九芝堂','测试产品-6979143610602'),categoryRoot=path.join(productRoot,'04.创意图'),oldRoot=path.join(categoryRoot,'任务-'+TASK),source=path.join(oldRoot,'01.源文件','1030-洪华-创意图.psd'),image=path.join(oldRoot,'02.导出图片','1030-洪华-创意图','创意图01.jpg'),workbookPath=path.join(taskRoot,'5.已完结','测试需求.xlsx');
 await fsp.mkdir(path.dirname(source),{recursive:true});await fsp.mkdir(path.dirname(image),{recursive:true});await fsp.mkdir(path.dirname(workbookPath),{recursive:true});await fsp.mkdir(path.join(taskRoot,'_workbench-system'),{recursive:true});
 const psd=Buffer.from('8BPS - fixture editable source'),jpg=Buffer.from([255,216,255,1,2,3,4]);await fsp.writeFile(source,psd);await fsp.writeFile(image,jpg);
 const files=[{id:'0',kind:'output',relative:path.join('1030-洪华-创意图','创意图01.jpg'),size:jpg.length,sha256:sha(jpg)},{id:'1',kind:'source',relative:'1030-洪华-创意图.psd',size:psd.length,sha256:sha(psd)}],published={'0':image,'1':source};
 const excel=workbook(oldAddress?'创意图：'+oldRoot:productRoot);await fsp.writeFile(workbookPath,excel);
 const task={id:TASK,filename:'测试需求.xlsx',state:4,sealed:true,owner:'hong',version:7,code:'6979143610602',items:[{points:.8}],elapsedMs:26571602,startedAt:1,completedAt:2,workbookHash:sha(excel),deliveries:[{id:UPLOAD,category:'creative',categoryName:'创意图',folder:'1030-洪华-创意图',path:oldRoot,productPath:productRoot,at:3}]};
 const upload={id:UPLOAD,taskId:TASK,actor:'hong',status:'done',storageLayout:2,files,product:{path:productRoot},category:{path:oldRoot,source:path.join(oldRoot,'01.源文件'),output:path.join(oldRoot,'02.导出图片')},published};
 const asset={id:UPLOAD,taskId:TASK,author:'hong',category:'creative',path:oldRoot,files:files.map(file=>({...file,path:published[file.id]}))};
 const store=new Store(path.dirname(dbPath));store.put('setting','nas',{taskRoot,assetRoot});store.put('task',TASK,task);store.put('asset',UPLOAD,asset);store.put('upload',UPLOAD,upload);store.put('job','old-audit',{status:'done',path:oldRoot});store.put('request','old-cache',{path:oldRoot});store.event('asset-archived','hong',TASK,{path:oldRoot});store.close();
 const state=()=>{const db=new DatabaseSync(dbPath,{readOnly:true});try{return snapshot(db)}finally{db.close()}};
 const options={dbPath,outputDir},env={fixtureRoot:root,files};
 t.after(async()=>{const target=path.resolve(root);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert(path.basename(target).startsWith('archive-path-repair-fixture-'));await fsp.rm(target,{recursive:true,force:true})});
 return {root,assetRoot,taskRoot,dbPath,categoryRoot,oldRoot,productRoot,source,image,workbookPath,excel,task,asset,upload,files,options,env,state};
}

test('specific archive repair defaults to read-only preview and leaves database, original workbook and source files unchanged',async t=>{
 const f=await setup(t),before=f.state(),result=await runRepair(f.options,f.env);assert.equal(result.mode,'dry-run');assert.equal(result.transfers.length,2);assert.equal(result.workbook.changesL4,false);assert.equal(f.state().hash,before.hash);assert.equal(sha(await fsp.readFile(f.workbookPath)),sha(f.excel));assert(fs.existsSync(f.oldRoot));assert(!fs.existsSync(path.join(f.categoryRoot,'01.源文件')));assert.equal(read(result.receiptPath).productionWritten,false);
});

test('apply copies and verifies both files, changes only three live path records, then preserves the UUID directory in recovery',async t=>{
 const f=await setup(t),before=f.state(),result=await runRepair({...f.options,apply:true},f.env),receipt=read(result.receiptPath),after=f.state();assert.equal(result.status,'applied');assert(fs.existsSync(result.backupPath));assert(!fs.existsSync(f.oldRoot));assert(fs.existsSync(result.recoveryDirectory));assert.equal(sha(await fsp.readFile(f.workbookPath)),sha(f.excel));assert.equal(receipt.workbookBackup,undefined);
 const get=(kind,id)=>JSON.parse(after.records.find(row=>row.kind===kind&&row.id===id).body),task=get('task',TASK),asset=get('asset',UPLOAD),upload=get('upload',UPLOAD);
 const expected=structuredClone(f.task);expected.deliveries[0].path=f.categoryRoot;assert.deepEqual(task,expected);assert.equal(asset.path,f.categoryRoot);assert.equal(upload.storageLayout,3);assert.equal(upload.category.path,f.categoryRoot);
 for(const file of f.files){assert.equal(sha(await fsp.readFile(upload.published[file.id])),file.sha256);assert.equal(sha(await fsp.readFile(path.join(result.recoveryDirectory,file.kind==='source'?'01.源文件':'02.导出图片',file.relative))),file.sha256);assert.equal(asset.files.find(row=>row.id===file.id).path,upload.published[file.id])}
 assert.deepEqual(after.events,before.events);assert.deepEqual(after.versions,before.versions);for(const kind of ['job','request'])assert.deepEqual(after.records.filter(row=>row.kind===kind),before.records.filter(row=>row.kind===kind));assert(!fs.existsSync(path.join(f.taskRoot,'_workbench-system','service.json')));
});

test('only an actual old UUID address in L4 is patched, with original Excel and SQLite backups and no workflow/version changes',async t=>{
 const f=await setup(t,{oldAddress:true}),result=await runRepair({...f.options,apply:true},f.env),receipt=read(result.receiptPath),bytes=await fsp.readFile(f.workbookPath),wb=unpack(bytes);
 assert.equal(String(mergedValue(wb.status,'L4')),'创意图：'+f.categoryRoot);assert.equal(mergedValue(wb.status,'M4'),'46325');assert.equal(sha(await fsp.readFile(receipt.workbookBackup)),sha(f.excel));assert.equal(sha(await fsp.readFile(receipt.adjacentWorkbookBackup)),sha(f.excel));
 const task=JSON.parse(f.state().records.find(row=>row.kind==='task'&&row.id===TASK).body);assert.equal(task.workbookHash,sha(bytes));assert.equal(task.version,7);assert.equal(task.elapsedMs,f.task.elapsedMs);assert.equal(task.state,4);assert.equal(task.sealed,true);
});

test('target collisions, extra source files, changed original workbook and active uploads reject without losing source data',async t=>{
 for(const cause of ['collision','extra-file','workbook-change','active-upload']){
  const f=await setup(t);if(cause==='collision'){await fsp.mkdir(path.join(f.categoryRoot,'01.源文件'),{recursive:true});await fsp.writeFile(path.join(f.categoryRoot,'01.源文件','1030-洪华-创意图.psd'),'existing')}
  if(cause==='extra-file')await fsp.writeFile(path.join(f.oldRoot,'unknown.txt'),'untracked');if(cause==='workbook-change')await fsp.appendFile(f.workbookPath,'changed');if(cause==='active-upload'){const db=new DatabaseSync(f.dbPath);db.prepare('INSERT INTO records VALUES(?,?,?)').run('upload','active',JSON.stringify({id:'active',taskId:TASK,status:'uploading'}));db.close()}
  const before=f.state();await assert.rejects(runRepair({...f.options,apply:true},f.env));assert.equal(f.state().hash,before.hash);assert(fs.existsSync(f.source));assert(fs.existsSync(f.image));
 }
});

test('only same-host known dead-PID stale leases are preserved and replaced; remote, live and malformed locks remain untouched',async t=>{
 const f=await setup(t),lease=path.join(f.taskRoot,'_workbench-system','service.json'),stale={id:crypto.randomUUID(),host:os.hostname(),pid:999999999,at:Date.now()-1000000};await fsp.writeFile(lease,JSON.stringify(stale));
 const result=await runRepair({...f.options,apply:true},f.env),receipt=read(result.receiptPath);assert.deepEqual(read(receipt.staleLeaseBackup),stale);assert.deepEqual(read(receipt.staleLeasePreserved),stale);assert(!fs.existsSync(lease));
 for(const invalid of [{...stale,host:'OTHER-COMPUTER'},{...stale,pid:process.pid},{host:os.hostname(),pid:999999999}]){const next=await setup(t),file=path.join(next.taskRoot,'_workbench-system','service.json'),text=JSON.stringify(invalid);await fsp.writeFile(file,text);const before=next.state();await assert.rejects(runRepair({...next.options,apply:true},next.env),/lock/);assert.equal(await fsp.readFile(file,'utf8'),text);assert.equal(next.state().hash,before.hash)}
});

test('legacy item-level paths in the target or another task are explicitly blocked rather than left pointing into recovery',async t=>{
 for(const target of [true,false]){
  const f=await setup(t),db=new DatabaseSync(f.dbPath),task=structuredClone(f.task);task.items[0].assetPath=f.oldRoot;
  if(target)db.prepare('UPDATE records SET body=? WHERE kind=? AND id=?').run(JSON.stringify(task),'task',TASK);else{task.id='other-task';task.deliveries=[];db.prepare('INSERT INTO records VALUES(?,?,?)').run('task',task.id,JSON.stringify(task))}db.close();
  const before=f.state();await assert.rejects(runRepair({...f.options,apply:true},f.env),/item-level|Another live record/);assert.equal(f.state().hash,before.hash);assert(fs.existsSync(f.source));assert(fs.existsSync(f.image));
 }
});

test('copy failure retains both original files and database references; transaction failure restores an already-patched original workbook',async t=>{
 const f=await setup(t),before=f.state(),copy=fsp.copyFile;fsp.copyFile=async(source,...rest)=>{if(source===f.source)throw Error('fixture copy failure');return copy.call(fsp,source,...rest)};
 try{await assert.rejects(runRepair({...f.options,apply:true},f.env),/fixture copy/)}finally{fsp.copyFile=copy}
 assert.equal(f.state().hash,before.hash);assert(fs.existsSync(f.source));assert(fs.existsSync(f.image));
 const patched=await setup(t,{oldAddress:true}),oldState=patched.state(),prepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql,...rest){if(sql==='UPDATE records SET body=? WHERE kind=? AND id=? AND body=?')return {run(){throw Error('fixture transaction failure')}};return prepare.call(this,sql,...rest)};
 try{await assert.rejects(runRepair({...patched.options,apply:true},patched.env),/fixture transaction/)}finally{DatabaseSync.prototype.prepare=prepare}
 assert.equal(patched.state().hash,oldState.hash);assert.equal(sha(await fsp.readFile(patched.workbookPath)),sha(patched.excel));assert(fs.existsSync(patched.source));assert(fs.existsSync(patched.image));
});
