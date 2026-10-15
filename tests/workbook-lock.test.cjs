'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {createLockChecker,lockPath,MIN_AGE_MS}=require('../core/workbook-lock.cjs');

async function fixture(t,{owner=true,original=true}={}){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'workbook-lock-wrapper-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'3.设计中');await fs.mkdir(dir);
 const file=path.join(dir,'26101211-CON-减肥双仓主图-王武臣-洪华.xlsx'),lock=lockPath(file),bytes=Buffer.from('original workbook'),ownerBytes=Buffer.alloc(165,65),now=1900000000000;
 const age=new Date(now-MIN_AGE_MS-10000);
 if(original){await fs.writeFile(file,bytes);await fs.utimes(file,age,age)}
 if(owner){await fs.writeFile(lock,ownerBytes);await fs.utimes(lock,age,age)}
 return {root,file,lock,bytes,ownerBytes,now};
}

test('no owner file is unlocked without invoking recovery or creating recovery directories',async t=>{
 const f=await fixture(t,{owner:false});let calls=0;
 const check=createLockChecker({platform:'win32',runHelper:async()=>{calls++;throw Error('must not run')},now:()=>f.now});
 assert.equal(await check(f.file,f.root),false);assert.equal(calls,0);
 await assert.rejects(fs.stat(path.join(f.root,'_workbench-system')),{code:'ENOENT'});
});

test('recent owner or recently saved original remains locked without invoking recovery',async t=>{
 const f=await fixture(t);let calls=0;
 const check=createLockChecker({platform:'win32',runHelper:async()=>{calls++;throw Error('must not run')},now:()=>f.now}),recent=new Date(f.now-1000),old=new Date(f.now-MIN_AGE_MS-10000);
 await fs.utimes(f.lock,recent,recent);assert.equal(await check(f.file,f.root),true);
 await fs.utimes(f.lock,old,old);await fs.utimes(f.file,recent,recent);assert.equal(await check(f.file,f.root),true);
 assert.equal(calls,0);assert.deepEqual(await fs.readFile(f.lock),f.ownerBytes);assert.deepEqual(await fs.readFile(f.file),f.bytes);
});

test('non-Windows platforms retain the editing guard and never invoke the native helper',async t=>{
 const f=await fixture(t);let calls=0;
 const check=createLockChecker({platform:'linux',runHelper:async()=>{calls++},now:()=>f.now});
 assert.equal(await check(f.file,f.root),true);assert.equal(calls,0);assert.deepEqual(await fs.readFile(f.lock),f.ownerBytes);
});

test('a missing original cannot be unlocked by recovering its orphaned owner',async t=>{
 const f=await fixture(t,{original:false});let calls=0;
 const check=createLockChecker({platform:'win32',runHelper:async()=>{calls++},now:()=>f.now});
 assert.equal(await check(f.file,f.root),true);assert.equal(calls,0);assert.deepEqual(await fs.readFile(f.lock),f.ownerBytes);
});

test('an old owner remains locked when the helper finds the workbook busy and preserves both files',async t=>{
 const f=await fixture(t),before=await fs.stat(f.file);let calls=0;
 const check=createLockChecker({platform:'win32',now:()=>f.now,runHelper:async(file,root)=>{assert.equal(file,f.file);assert.equal(root,f.root);calls++;return {locked:true,recovered:false,reason:'busy'}}});
 assert.equal(await check(f.file,f.root),true);assert.equal(calls,1);
 assert.deepEqual(await fs.readFile(f.file),f.bytes);assert.deepEqual(await fs.readFile(f.lock),f.ownerBytes);assert.equal((await fs.stat(f.file)).mtimeMs,before.mtimeMs);
});

test('a busy workbook remains guarded for this check even when its owner disappears during the native probe',async t=>{
 const f=await fixture(t);let calls=0;
 const check=createLockChecker({platform:'win32',now:()=>f.now,runHelper:async()=>{calls++;await fs.unlink(f.lock);return {locked:true,recovered:false,reason:'busy'}}});
 assert.equal(await check(f.file,f.root),true);assert.equal(calls,1);await assert.rejects(fs.stat(f.lock),{code:'ENOENT'});assert.deepEqual(await fs.readFile(f.file),f.bytes);
});

test('stale-owner recovery clears the guard only after the owner name is absent and preserves the original',async t=>{
 const f=await fixture(t),saved=path.join(f.root,'recovered-owner.bak'),before=await fs.stat(f.file);let calls=0;
 const check=createLockChecker({platform:'win32',now:()=>f.now,runHelper:async()=>{calls++;await fs.rename(f.lock,saved);return {locked:false,recovered:true,reason:'stale-owner-recovered'}}});
 assert.equal(await check(f.file,f.root),false);assert.equal(await check(f.file,f.root),false);assert.equal(calls,1);
 assert.deepEqual(await fs.readFile(saved),f.ownerBytes);assert.deepEqual(await fs.readFile(f.file),f.bytes);assert.equal((await fs.stat(f.file)).mtimeMs,before.mtimeMs);
});

test('a new Excel owner created during recovery keeps the guard even when the helper reports success',async t=>{
 const f=await fixture(t),saved=path.join(f.root,'recovered-owner.bak'),newOwner=Buffer.from('new Excel session');
 const check=createLockChecker({platform:'win32',now:()=>f.now,runHelper:async()=>{await fs.rename(f.lock,saved);await fs.writeFile(f.lock,newOwner);return {locked:false,recovered:true,reason:'stale-owner-recovered'}}});
 assert.equal(await check(f.file,f.root),true);assert.deepEqual(await fs.readFile(f.lock),newOwner);assert.deepEqual(await fs.readFile(saved),f.ownerBytes);assert.deepEqual(await fs.readFile(f.file),f.bytes);
});

test('concurrent checks share the same native probe instead of moving the owner more than once',async t=>{
 const f=await fixture(t);let calls=0,entered,release;
 const ready=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const check=createLockChecker({platform:'win32',now:()=>f.now,runHelper:async()=>{calls++;entered();await gate;return {locked:true,recovered:false,reason:'busy'}}});
 const first=check(f.file,f.root);await ready;const remaining=Array.from({length:8},()=>check(f.file,f.root));release();
 assert.deepEqual(await Promise.all([first,...remaining]),Array(9).fill(true));assert.equal(calls,1);assert.deepEqual(await fs.readFile(f.lock),f.ownerBytes);
});

test('a failed native probe preserves the owner and caches the failure until the retry interval passes',async t=>{
 const f=await fixture(t);let calls=0,clock=f.now;
 const check=createLockChecker({platform:'win32',now:()=>clock,runHelper:async()=>{calls++;throw Error('Access denied')}});
 await assert.rejects(check(f.file,f.root),/已保留原表和占用记录.*Access denied/);
 await assert.rejects(check(f.file,f.root),/已保留原表和占用记录.*Access denied/);assert.equal(calls,1);
 clock+=15001;await assert.rejects(check(f.file,f.root),/Access denied/);assert.equal(calls,2);
 assert.deepEqual(await fs.readFile(f.file),f.bytes);assert.deepEqual(await fs.readFile(f.lock),f.ownerBytes);
});

test('unknown helper failures remain blocked instead of accepting a doubtful stale-owner decision',async t=>{
 const f=await fixture(t);let calls=0;
 const check=createLockChecker({platform:'win32',now:()=>f.now,runHelper:async()=>{calls++;return {locked:true,recovered:false,reason:'permission-denied'}}});
 await assert.rejects(check(f.file,f.root),/已保留占用记录.*permission-denied/);assert.equal(calls,1);assert.deepEqual(await fs.readFile(f.lock),f.ownerBytes);
});

test('final recover:false checks never invoke recovery even for an old owner',async t=>{
 const f=await fixture(t);let calls=0;
 const check=createLockChecker({platform:'win32',now:()=>f.now,runHelper:async()=>{calls++;throw Error('must not run')}});
 assert.equal(await check(f.file,f.root,{recover:false}),true);assert.equal(calls,0);assert.deepEqual(await fs.readFile(f.lock),f.ownerBytes);
 await fs.unlink(f.lock);assert.equal(await check(f.file,f.root,{recover:false}),false);assert.equal(calls,0);
});

test('an original outside the connected root is rejected before invoking the native helper',async t=>{
 const f=await fixture(t),other=await fixture(t);let calls=0;
 const check=createLockChecker({platform:'win32',now:()=>f.now,runHelper:async()=>{calls++;throw Error('must not run')}});
 await assert.rejects(check(other.file,f.root),/路径超出已连接目录/);assert.equal(calls,0);assert.deepEqual(await fs.readFile(other.lock),other.ownerBytes);assert.deepEqual(await fs.readFile(other.file),other.bytes);
});

test('missing root and oversized owner retain the guard without native recovery',async t=>{
 const f=await fixture(t);let calls=0;
 const check=createLockChecker({platform:'win32',now:()=>f.now,runHelper:async()=>{calls++;throw Error('must not run')}});
 assert.equal(await check(f.file,null),true);await fs.writeFile(f.lock,Buffer.alloc(4097));const old=new Date(f.now-MIN_AGE_MS-10000);await fs.utimes(f.lock,old,old);
 assert.equal(await check(f.file,f.root),true);assert.equal(calls,0);
});

function requirement(){
 const {zipSync,strToU8}=require('fflate'),ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
 const cells={A1:'需求表',A3:'阶段情况',B3:'需求日期',G3:'分配设计',L3:'文件位置',D5:'69码',B6:'九芝堂',C6:'西红花',D6:'6970855224163',F6:'单图任务（复杂元素替换）',G6:1,B4:46268,C4:11,D4:'王燕',E4:46268,F4:11,G4:'洪华',A4:'',H4:'',I4:'',J4:'',K4:'',L4:'',M4:'',N4:''};
 const rows=new Map();for(const [address,value] of Object.entries(cells)){const row=address.match(/\d+/)[0];if(!rows.has(row))rows.set(row,[]);rows.get(row).push(typeof value==='number'?'<c r="'+address+'"><v>'+value+'</v></c>':'<c r="'+address+'" t="inlineStr"><is><t>'+value+'</t></is></c>')}
 const entries={
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
  '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml':'<workbook xmlns="'+ns+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="【状态】" sheetId="1" r:id="rId1"/><sheet name="主图" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>',
  'xl/styles.xml':'<styleSheet xmlns="'+ns+'"><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"><protection locked="0"/></xf></cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml':'<worksheet xmlns="'+ns+'"><sheetData>'+[...rows].sort((a,b)=>Number(a[0])-Number(b[0])).map(([r,c])=>'<row r="'+r+'">'+c.join('')+'</row>').join('')+'</sheetData></worksheet>',
  'xl/worksheets/sheet2.xml':'<worksheet xmlns="'+ns+'"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>保留需求内容</t></is></c></row></sheetData></worksheet>'
 };
 return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name,xml])=>[name,strToU8(xml)]))));
}

test('requirements sync recovers an old 165-byte owner and applies saved workflow edits with original content intact',{skip:process.platform!=='win32'},async t=>{
 const {Service}=require('../core/service.cjs'),{patchWorkbook}=require('../core/workbook.cjs'),{STAGES}=require('../core/rules.cjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'workbook-lock-sync-')),taskRoot=path.join(root,'requests'),assetRoot=path.join(root,'assets');
 let service;t.after(async()=>{await service?.stop();await fs.rm(root,{recursive:true,force:true})});
 await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);service=await new Service(path.join(root,'db'),{host:'127.0.0.1',port:0}).start();
 const manager={role:'manager',personId:'zeng'};await service.call(manager,'configure',{taskRoot,assetRoot});await service.requirementsSync.stop();service.requirementsSync.stopped=false;
 const filename='26090311-九芝堂-西红花-王燕-洪华.xlsx',file=path.join(taskRoot,STAGES[1],filename),bytes=requirement();await fs.writeFile(file,bytes);
 const task=await service.importFile(bytes,filename,{},1,true),saved=patchWorkbook(await fs.readFile(file),{H4:46268,I4:12});await fs.writeFile(file,saved);
 const lock=lockPath(file),ownerBytes=Buffer.alloc(165,65),old=new Date(Date.now()-MIN_AGE_MS-10000);await fs.writeFile(lock,ownerBytes);await fs.utimes(file,old,old);await fs.utimes(lock,old,old);
 task.workbookSyncIssue={message:'Excel 正在编辑原表',stage:STAGES[1],filename,at:Date.now()};service.store.put('task',task.id,task);
 const result=await service.requirementsSync.check(true),current=service.store.get('task',task.id),moved=path.join(taskRoot,STAGES[2],filename);
 assert.equal(result.checked,true);assert.equal(current.state,2,JSON.stringify({issue:current.workbookSyncIssue,result}));assert.equal(current.workbookSyncIssue,null);assert.ok(current.startedAt);assert.deepEqual(await fs.readFile(moved),saved);
 await assert.rejects(fs.stat(lock),{code:'ENOENT'});await assert.rejects(fs.stat(file),{code:'ENOENT'});
 const recoveredRoot=path.join(taskRoot,'_workbench-system','recovery','excel-locks'),recovered=await fs.readdir(recoveredRoot,{recursive:true});assert.ok(recovered.some(name=>name.endsWith('manifest.json')));
 const manifests=await Promise.all(recovered.filter(name=>name.endsWith('manifest.json')).map(async name=>JSON.parse(await fs.readFile(path.join(recoveredRoot,name),'utf8'))));
 assert.ok(manifests.some(m=>m.source===lock&&m.workbook===file&&m.status==='recovered'&&m.size===165));
});
