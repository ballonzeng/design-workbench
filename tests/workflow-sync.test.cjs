'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {zipSync,strToU8}=require('fflate'),{Service}=require('../core/service.cjs'),{Client,decodeCode}=require('../core/client.cjs');
const {patchWorkbook,unpack}=require('../core/workbook.cjs'),{STAGES}=require('../core/rules.cjs');
const {digest}=require('../core/store.cjs');
const manager={role:'manager',personId:'zeng'},filename='26090311-九芝堂-西红花-王燕-洪华.xlsx';
function workbook(){
 const cells={A1:'需求表',A3:'阶段情况',B3:'需求日期',G3:'分配设计',L3:'文件位置',D5:'69码',B6:'九芝堂',C6:'西红花',D6:'6970855224163',F6:'单图任务（复杂元素替换）',G6:1,B4:46268,C4:11,D4:'王燕',E4:46268,F4:11,G4:'洪华',A4:'',H4:'',I4:'',J4:'',K4:'',L4:'',M4:'',N4:''};
 const rows=new Map();for(const [address,value] of Object.entries(cells)){const row=address.match(/\d+/)[0];if(!rows.has(row))rows.set(row,[]);rows.get(row).push(typeof value==='number'?'<c r="'+address+'"><v>'+value+'</v></c>':'<c r="'+address+'" t="inlineStr"><is><t>'+value+'</t></is></c>')}
 const xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
 const entries={
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml':'<workbook xmlns="'+xmlns+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="【状态】" sheetId="1" r:id="rId1"/><sheet name="主图" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  'xl/styles.xml':'<styleSheet xmlns="'+xmlns+'"><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"><protection locked="0"/></xf></cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml':'<worksheet xmlns="'+xmlns+'"><sheetData>'+[...rows].sort((a,b)=>Number(a[0])-Number(b[0])).map(([r,c])=>'<row r="'+r+'">'+c.join('')+'</row>').join('')+'</sheetData><mergeCells count="1"><mergeCell ref="A3:A4"/></mergeCells></worksheet>',
  'xl/worksheets/sheet2.xml':'<worksheet xmlns="'+xmlns+'"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>保留需求内容</t></is></c></row></sheetData></worksheet>'
 };
 return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k,v])=>[k,strToU8(v)]))));
}
async function setup(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'workbook-sync-')),taskRoot=path.join(root,'requests'),assetRoot=path.join(root,'assets');
 await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);const service=await new Service(path.join(root,'db'),{host:'127.0.0.1',port:0}).start();t.after(()=>service.stop());
 await service.call(manager,'configure',{taskRoot,assetRoot});const initialWorkbook=workbook();await fs.writeFile(path.join(taskRoot,STAGES[1],filename),initialWorkbook);
 let task=await service.importFile(initialWorkbook,filename,{},1,true);
 const pairing=await service.call(manager,'pair-code',{personId:'hong',host:'127.0.0.1'}),client=new Client(decodeCode(pairing.code));await client.pair();t.after(()=>client.close());
 const current=()=>service.store.get('task',task.id),file=()=>service.nas.taskPath(current());
 const edit=async patch=>{const target=file(),bytes=patchWorkbook(await fs.readFile(target),patch);await fs.writeFile(target,bytes);return bytes};
 return {root,taskRoot,service,client,task,current,file,edit};
}
test('manual workbook edits move the original through design, review and completion and notify the designer',async t=>{
 const {service,client,task,current,file,edit,taskRoot}=await setup(t);
 let changes=0;service.on('change',()=>changes++);
 const original=unpack(await fs.readFile(file()));
 for(const [patch,state] of [[{H4:46268,I4:12},2],[{J4:46268,K4:13},3],[{M4:46268,N4:14},4]]){
  const source=file(),saved=await edit(patch);await client.rpc('sync-requirements');
  const snapshot=await client.rpc('snapshot');assert.equal(snapshot.tasks[0].state,state);
  assert.equal(file(),path.join(taskRoot,STAGES[state],filename));await assert.rejects(fs.access(source));
  assert.deepEqual(await fs.readFile(file()),saved);assert.equal(current().workbookHash,digest(saved));assert.equal(current().workbookSyncIssue,null);
 }
 assert.ok(changes>=3);assert.equal(current().runningSince,null);assert.ok(current().completedAt);
 const final=unpack(await fs.readFile(file()));assert.deepEqual(final.entries['xl/worksheets/sheet2.xml'],original.entries['xl/worksheets/sheet2.xml']);
 const location=await client.rpc('requirement-location',{taskId:task.id});assert.equal(location.path,file());
 await assert.rejects(service.call({role:'designer',personId:'lv'},'requirement-location',{taskId:task.id}),/自己/);
});
test('moving a started workbook back to pending design clears the running state without overwriting manual edits',async t=>{
 const {service,client,task,current,file,edit,taskRoot}=await setup(t);
 await client.rpc('action',{taskId:task.id,action:'start',version:task.version});
 await client.rpc('action',{taskId:task.id,action:'pause',version:current().version,reason:'暂时离开'});
 const saved=await edit({H4:'',I4:'',J4:'',K4:'',M4:'',N4:''}),dest=path.join(taskRoot,STAGES[1],filename);
 await fs.rename(file(),dest);
 const legacy=current();delete legacy.workflowFields;service.store.put('task',task.id,legacy);
 await client.rpc('sync-requirements');assert.equal(current().state,1);assert.equal(current().runningSince,null);assert.equal(current().startedAt,null);assert.deepEqual(await fs.readFile(dest),saved);
 await client.rpc('action',{taskId:task.id,action:'start',version:current().version});assert.equal(current().state,2);
});
test('Excel locks and incomplete dates show actionable issues, then recover after close and correction',async t=>{
 const {client,current,file,edit}=await setup(t);
 await edit({H4:46268,I4:12});const lock=path.join(path.dirname(file()),'~$'+filename);await fs.writeFile(lock,'Excel lock');
 await client.rpc('sync-requirements');assert.equal(current().state,1);assert.match(current().workbookSyncIssue.message,/保存并关闭/);
 await fs.unlink(lock);await client.rpc('sync-requirements');assert.equal(current().state,2);assert.equal(current().workbookSyncIssue,null);
 await edit({J4:46268,K4:''});await client.rpc('sync-requirements');assert.equal(current().state,2);assert.match(current().workbookSyncIssue.message,/J4 \/ K4/);
 await edit({J4:46268,K4:13});await client.rpc('sync-requirements');assert.equal(current().state,3);assert.equal(current().workbookSyncIssue,null);
});
test('a manually renamed requirement relinks to its original task and can keep moving',async t=>{
 const {client,service,current,file,edit}=await setup(t),oldId=current().id,newName='26090311-九芝堂-西红花主图-吴国华-洪华.xlsx',target=path.join(path.dirname(file()),newName),wb=unpack(await fs.readFile(file()));
 wb.entries[wb.status.file]=strToU8(wb.status.content.replace('<t>王燕</t>','<t>吴国华</t>'));await fs.writeFile(target,zipSync(wb.entries));await fs.unlink(file());
 const sync=await client.rpc('sync-requirements'),tasks=service.store.all('task');assert.equal(sync.relinked,1);assert.equal(tasks.length,1);assert.equal(tasks[0].id,oldId);assert.equal(tasks[0].filename,newName);assert.equal(tasks[0].operator,'吴国华');assert.equal(tasks[0].workbookSyncIssue,null);
 await edit({H4:46268,I4:12});await client.rpc('sync-requirements');assert.equal(current().state,2);
});
test('an older missing task absorbs a duplicate created from its renamed workbook',async t=>{
 const {service,current,file}=await setup(t),old=current(),newName='26090311-九芝堂-西红花主图-吴国华-洪华.xlsx',target=path.join(path.dirname(file()),newName),wb=unpack(await fs.readFile(file()));
 wb.entries[wb.status.file]=strToU8(wb.status.content.replace('<t>王燕</t>','<t>吴国华</t>'));const bytes=Buffer.from(zipSync(wb.entries));await fs.writeFile(target,bytes);await fs.unlink(file());
 const stale={...old,workbookSyncIssue:{message:'五个状态文件夹内未找到原需求表，请检查是否被移动或改名',stage:STAGES[1],filename:old.filename,at:Date.now()},version:old.version+1};service.store.put('task',old.id,stale);
 await assert.rejects(service.importFile(bytes,newName,{},1,true),/任务编号已存在/);
 // Model a duplicate left by an older release, bypassing the new import guard.
 const duplicate={...old,id:require('node:crypto').randomUUID(),filename:newName,operator:'吴国华',workbookHash:digest(bytes)};service.store.put('task',duplicate.id,duplicate);assert.equal(service.store.all('task').length,2);
 assert.equal(await service.repairRenamedDuplicates(),1);const tasks=service.store.all('task');assert.equal(tasks.length,1);assert.equal(tasks[0].id,old.id);assert.equal(tasks[0].filename,newName);assert.equal(tasks[0].operator,'吴国华');
});
test('editing contribution items updates points and does not block later workflow changes',async t=>{
 const {client,current,file,edit}=await setup(t),wb=unpack(await fs.readFile(file()));
 wb.entries[wb.status.file]=strToU8(wb.status.content.replace('单图任务（复杂元素替换）','简单信息修改'));
 await fs.writeFile(file(),zipSync(wb.entries));await client.rpc('sync-requirements');
 assert.equal(current().items[0].type,'simple');assert.equal(current().items[0].points,.15);assert.equal(current().workbookSyncIssue,null);
 await edit({H4:46268,I4:12});await client.rpc('sync-requirements');assert.equal(current().state,2);assert.equal(current().workbookSyncIssue,null);
});
test('duplicate originals and changed product identity are blocked with their status folder',async t=>{
 const {client,current,file,taskRoot}=await setup(t),other=path.join(taskRoot,STAGES[2],filename);
 await fs.copyFile(file(),other);await client.rpc('sync-requirements');assert.match(current().workbookSyncIssue.message,/多个状态文件夹/);assert.equal(current().workbookSyncIssue.stage,STAGES[1]);
 await fs.unlink(other);await client.rpc('sync-requirements');assert.equal(current().workbookSyncIssue,null);
 const wb=unpack(await fs.readFile(file()));wb.entries[wb.status.file]=strToU8(wb.status.content.replace('西红花','另一商品').replace('6970855224163','6970855224164'));await fs.writeFile(file(),zipSync(wb.entries));
 const oldHash=current().workbookHash;await client.rpc('sync-requirements');assert.equal(current().workbookHash,oldHash);assert.match(current().workbookSyncIssue.message,/69码/);
});
test('periodic checks refresh a saved original without a refresh button',async t=>{
 const {service,client,current,edit}=await setup(t);clearInterval(service.requirementsSync.timer);service.requirementsSync.start(30);
 const notification=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Designer update timeout')),3000);client.events(async()=>{if((await client.rpc('snapshot')).tasks[0].state===2){clearTimeout(timeout);resolve()}},()=>{})});
 await edit({H4:46268,I4:12});await notification;assert.equal(current().state,2);
});
test('periodic checks automatically import a new workbook from the five NAS folders',async t=>{
 const {service,client,taskRoot}=await setup(t);clearInterval(service.requirementsSync.timer);service.requirementsSync.start(30);
 const wb=unpack(workbook());wb.entries[wb.status.file]=strToU8(wb.status.content.replace('西红花','灵芝孢子粉').replace('6970855224163','6970855224999'));const second='26090311-九芝堂-灵芝孢子粉-王燕-洪华.xlsx';
 const imported=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Automatic import timeout')),3000);client.events(async()=>{if(service.store.all('task').length===2){clearTimeout(timeout);resolve()}},()=>{})});
 await fs.writeFile(path.join(taskRoot,STAGES[1],second),zipSync(wb.entries));await imported;assert.equal(service.store.all('task').some(task=>task.filename===second),true);
});
test('a valid requirement imports even when its contribution item has no asset category',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'category-later-')),taskRoot=path.join(root,'requests'),assetRoot=path.join(root,'assets');await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);const service=await new Service(path.join(root,'db'),{host:'127.0.0.1',port:0}).start();
 t.after(()=>service.stop());await service.call(manager,'configure',{taskRoot,assetRoot});
 const wb=unpack(workbook());wb.entries['xl/worksheets/sheet2.xml']=strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>');const bytes=Buffer.from(zipSync(wb.entries));
 await fs.writeFile(path.join(taskRoot,STAGES[1],filename),bytes);const task=await service.importFile(bytes,filename,{},1,true);
 assert.equal(task.items[0].typeName,'单图任务（复杂元素替换）');assert.equal(task.items[0].category,null);assert.equal(task.items[0].points,1.5);
});
test('an existing workbook in completed folder can use observed file time when confirmation cells are blank',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'completed-folder-')),taskRoot=path.join(root,'requests'),assetRoot=path.join(root,'assets');await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);const service=await new Service(path.join(root,'db'),{host:'127.0.0.1',port:0}).start();
 t.after(()=>service.stop());await service.call(manager,'configure',{taskRoot,assetRoot});const observedAt=Date.UTC(2026,8,3,9),bytes=workbook();await fs.writeFile(path.join(taskRoot,STAGES[4],filename),bytes);
 const task=await service.importFile(bytes,filename,{observedAt},4,true);assert.equal(task.completedAt,observedAt);assert.equal(task.completionFromFolder,true);await service.requirementsSync.check(true);assert.equal(service.store.get('task',task.id).workbookSyncIssue==null,true);
});
test('startup replaces obsolete asset-category import issues with a fresh scan',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'stale-import-')),taskRoot=path.join(root,'requests'),assetRoot=path.join(root,'assets');await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);
 let service=await new Service(path.join(root,'db'),{host:'127.0.0.1',port:0}).start();await service.call(manager,'configure',{taskRoot,assetRoot});service.store.put('setting','importIssues',[{filename,stage:STAGES[1],error:'请为未识别的事项选择资产类别',details:[]}]);await service.stop();
 await fs.writeFile(path.join(taskRoot,STAGES[1],filename),workbook());service=await new Service(path.join(root,'db'),{host:'127.0.0.1',port:0}).start();t.after(()=>service.stop());
 assert.equal(service.store.all('task').length,1);assert.deepEqual(service.store.get('setting','importIssues'),[]);assert.equal(service.store.all('task')[0].items[0].category,null);
});

test('rework clears prior review cells and later Excel start-time edit stays in design',async t=>{
 const {client,current,file,edit}=await setup(t);
 await client.rpc('action',{taskId:current().id,action:'start',version:current().version});
 await client.rpc('action',{taskId:current().id,action:'review',version:current().version});
 await client.rpc('action',{taskId:current().id,action:'rework',version:current().version});
 const wb=unpack(await fs.readFile(file()));assert.equal(wb.status.cells.J4.value,'');assert.equal(wb.status.cells.K4.value,'');assert.equal(current().reviewAt,null);
 await edit({H4:46268,I4:12});await client.rpc('sync-requirements');assert.equal(current().state,2);assert.equal(current().workbookSyncIssue,null);
});
test('reassignment starts a fresh round but retains accumulated work and original task ID',async t=>{
 const {service,client,current,file}=await setup(t),id=current().id;
 await client.rpc('action',{taskId:id,action:'start',version:current().version});
 await client.rpc('action',{taskId:id,action:'review',version:current().version});
 const recorded=current().elapsedMs;
 await service.call(manager,'action',{taskId:id,action:'assign',owner:'lv',version:current().version});
 const wb=unpack(await fs.readFile(file()));for(const key of ['H4','I4','J4','K4','M4','N4'])assert.equal(wb.status.cells[key].value,'');
 assert.equal(current().startedAt,null);assert.equal(current().elapsedMs,recorded);assert.equal(require('../core/workbook.cjs').workbookTaskId(wb),id);
 await service.call({role:'designer',personId:'lv'},'action',{taskId:id,action:'start',version:current().version});assert.equal(current().state,2);assert.ok(current().startedAt);
});
test('copied task IDs are not imported as new work and unrelated same-hour products do not steal identity',async t=>{
 const {service,current,file,taskRoot}=await setup(t),id=current().id,original=await fs.readFile(file());
 const duplicateName='26090311-九芝堂-另一份主图-王燕-洪华.xlsx';await fs.writeFile(path.join(taskRoot,STAGES[1],duplicateName),original);
 const result=await service.requirementsSync.check(true);assert.equal(result.imported,0);assert.equal(service.store.all('task').length,1);assert.match(service.store.get('setting','importIssues')[0].error,/同一个任务编号/);
 await fs.unlink(path.join(taskRoot,STAGES[1],duplicateName));
 const legacy=current();legacy.workbookTaskId=null;service.store.put('task',id,legacy);await fs.unlink(file());
 const wb=unpack(workbook());wb.entries[wb.status.file]=strToU8(wb.status.content.replace('单图任务（复杂元素替换）','简单信息修改'));
 await fs.writeFile(path.join(taskRoot,STAGES[1],duplicateName),zipSync(wb.entries));await service.requirementsSync.check(true);
 assert.equal(service.store.all('task').length,1);assert.equal(current().filename,filename);assert.match(service.store.get('setting','importIssues')[0].error,/缺少固定编号/);
});
test('missing NAS at startup reports unchecked, then reconnects and scans after availability returns',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nas-reconnect-')),taskRoot=path.join(root,'requests'),assetRoot=path.join(root,'assets'),dir=path.join(root,'db');
 const {Store}=require('../core/store.cjs'),store=new Store(dir);store.put('setting','nas',{taskRoot,assetRoot});store.close();
 const service=await new Service(dir,{host:'127.0.0.1',port:0}).start();t.after(()=>service.stop());
 const failed=await service.requirementsSync.check(true);assert.equal(failed.checked,false);assert.ok(failed.error);assert.equal(failed.lastCheckedAt,null);
 await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);service.retryAt=0;
 const recovered=await service.requirementsSync.check();assert.equal(recovered.checked,true);assert.ok(recovered.lastCheckedAt);assert.equal(service.startError,null);assert.ok(service.nas.lease);
});

test('manager repairs only a proven duplicate and keeps backup and history; designer denied',async t=>{
 const {service,current,file}=await setup(t);await service.requirementsSync.stop();const keep=current();const {identifyWorkbook}=require('../core/workbook.cjs');await fs.writeFile(file(),identifyWorkbook(await fs.readFile(file()),keep.id));
 const duplicate={...structuredClone(keep),id:require('node:crypto').randomUUID()};service.store.put('task',duplicate.id,duplicate);service.store.event('imported-existing','system',duplicate.id,{});
 await assert.rejects(service.call({role:'designer',personId:'hong'},'duplicate-inspect',{taskId:duplicate.id}));
 const plan=await service.call(manager,'duplicate-inspect',{taskId:duplicate.id});assert.equal(plan.keep.id,keep.id);const payload={taskId:duplicate.id,keepId:keep.id,version:duplicate.version,keepVersion:keep.version,hash:plan.hash};
 await assert.rejects(service.call(manager,'duplicate-repair',{...payload,version:-1}));assert.ok(service.store.get('task',duplicate.id));
 const before=await fs.readFile(file());const result=await service.call(manager,'duplicate-repair',payload);assert.equal(service.store.get('task',duplicate.id),null);assert.ok(service.store.get('task',keep.id));assert.ok(service.store.get('duplicateArchive',duplicate.id).events.length);assert.ok((await fs.stat(result.backupPath)).size>0);assert.deepEqual(await fs.readFile(file()),before);
});

test('sealed task folder link resolves barcode product root, not a category, and checks ownership',async t=>{
 const {service,current}=await setup(t);await service.requirementsSync.stop();const task=current(),assetRoot=service.nas.config.assetRoot,productRoot=path.join(assetRoot,task.brand,task.product+'-'+task.code);await fs.mkdir(path.join(productRoot,'03.SKU'),{recursive:true});
 await assert.rejects(service.call(manager,'task-asset-location',{taskId:task.id}),/尚未/);task.state=4;task.sealed=true;service.store.put('task',task.id,task);
 task.sealed=false;task.deliveries=[];service.store.put('task',task.id,task);await assert.rejects(service.call(manager,'task-asset-location',{taskId:task.id}),/尚未上传/);task.deliveries=[{id:'uploaded-sku',category:'sku'}];service.store.put('task',task.id,task);
 const result=await service.call(manager,'task-asset-location',{taskId:task.id});assert.equal(result.path,productRoot);assert.equal(service.store.get('task',task.id).sealed,false);assert.equal((await service.call({role:'designer',personId:task.owner},'task-asset-location',{taskId:task.id})).path,productRoot);await assert.rejects(service.call({role:'designer',personId:'not-owner'},'task-asset-location',{taskId:task.id}));
});

test('missing unfinished originals leave active snapshots and reappear when restored; history remains',async t=>{
 const {service,current,file}=await setup(t);await service.requirementsSync.stop();service.requirementsSync.stopped=false;const task=current(),original=await fs.readFile(file());await fs.unlink(file());await service.requirementsSync.run(true);
 assert.equal(service.snapshot(manager).tasks.some(t=>t.id===task.id),false);assert.equal(service.snapshot({role:'designer',personId:task.owner}).tasks.some(t=>t.id===task.id),false);assert.ok(service.store.get('task',task.id));assert.ok(service.store.events(task.id).length);
 await fs.writeFile(file(),original);await service.requirementsSync.run(true);assert.equal(service.snapshot(manager).tasks.some(t=>t.id===task.id),true);
});

test('only manager reopens sealed tasks, preserving assets, workbook, completion and version history',async t=>{
 const {service,current,file}=await setup(t);await service.requirementsSync.stop();const originalFile=file(),task=current();task.state=4;task.sealed=true;task.sealedAt=Date.now();task.completedAt=task.sealedAt-1000;task.deliveries=[{id:'sku-kept',category:'sku'}];service.store.put('task',task.id,task);service.store.put('asset','sku-kept',{id:'sku-kept',taskId:task.id,files:[]});const before=await fs.readFile(originalFile);const payload={taskId:task.id,version:task.version};
 await assert.rejects(service.call({role:'designer',personId:task.owner},'archive-reopen',payload));
 await assert.rejects(service.call(manager,'archive-reopen',{...payload,version:task.version-1}),/已更新/);
 const result=await service.call(manager,'archive-reopen',payload);assert.equal(result.sealed,false);assert.equal(result.sealedAt,undefined);assert.equal(result.state,4);assert.equal(result.completedAt,task.completedAt);assert.equal(result.elapsedMs,task.elapsedMs);assert.equal(result.version,task.version+1);assert.deepEqual(result.deliveries,task.deliveries);assert.ok(service.store.get('asset','sku-kept'));assert.deepEqual(await fs.readFile(originalFile),before);assert.ok(service.store.events(task.id).some(e=>e.kind==='archive-reopened'));assert.equal(service.snapshot({role:'designer',personId:task.owner}).tasks.find(v=>v.id===task.id).sealed,false);
 await assert.rejects(service.call(manager,'archive-reopen',{...payload,version:result.version}),/仅已完成/);
});

test('member removal is manager-only, requires handover and revokes access without deleting history',async t=>{
 const {service,current}=await setup(t);await service.requirementsSync.stop();const task=current(),personId=task.owner;await assert.rejects(service.call({role:'designer',personId},'member-remove',{personId}));await assert.rejects(service.call(manager,'member-remove',{personId}),/未完成/);task.state=4;task.sealed=true;service.store.put('task',task.id,task);service.store.put('token','test-token',{personId,revoked:false});service.store.put('pair','test-pair',{personId,used:false});await service.call(manager,'member-remove',{personId});assert.ok(service.store.get('task',task.id));assert.equal(service.store.get('token','test-token').revoked,true);assert.equal(service.store.get('pair','test-pair').used,true);assert.equal(service.snapshot(manager).people.find(p=>p.id===personId).removed,true);await assert.rejects(service.call({role:'designer',personId},'snapshot'),/移出/);await assert.rejects(service.call(manager,'pair-code',{personId,host:'127.0.0.1'}),/移出/);
});

test('remote manager pairs with server-granted role, edits tasks, checks stale versions and revokes',async t=>{
 const {service,current}=await setup(t);await service.requirementsSync.stop();const {Client,decodeCode}=require('../core/client.cjs');const code=await service.call(manager,'manager-pair-code',{host:'127.0.0.1'}),client=new Client(decodeCode(code.code));t.after(()=>client.close());const connection=await client.pair();assert.equal(connection.role,'manager');assert.equal((await client.rpc('snapshot')).role,'manager');await assert.rejects(client.rpc('configure',{}),/主机/);await assert.rejects(client.rpc('manager-pair-code',{host:'127.0.0.1'}),/主机/);const task=current();const next=await client.rpc('action',{taskId:task.id,action:'assign',owner:'lv',version:task.version});assert.equal(next.owner,'lv');await assert.rejects(client.rpc('action',{taskId:task.id,action:'assign',owner:'hong',version:task.version}),/更新/);await service.call(manager,'manager-revoke');await assert.rejects(client.rpc('snapshot'),/失效/);await assert.rejects(service.call({role:'designer',personId:'lv'},'manager-pair-code',{host:'127.0.0.1'}));
});

test('action synchronizes saved edits, rejects stale versions and succeeds after lock is closed',async t=>{
 const {client,current,file,edit}=await setup(t);
 await client.rpc('action',{taskId:current().id,action:'start',version:current().version});
 const old=current(),lock=path.join(path.dirname(file()),'~$'+path.basename(file()));
 await fs.writeFile(lock,'Excel lock');
 await assert.rejects(client.rpc('action',{taskId:old.id,action:'review',version:old.version}),/Excel/);
 assert.equal(current().state,2);
 await fs.unlink(lock);await edit({H4:46268,I4:12});
 await assert.rejects(client.rpc('action',{taskId:old.id,action:'review',version:old.version}));
 assert.equal(current().state,2);assert.equal(current().workbookSyncIssue,null);
 await client.rpc('action',{taskId:old.id,action:'review',version:current().version});
 assert.equal(current().state,3);
});

test('normal refresh leaves sealed workbooks and archived files untouched; explicit refresh checks both',async t=>{
 const {service,current,edit,file}=await setup(t);clearInterval(service.requirementsSync.timer);await service.requirementsSync.running;
 await edit({H4:46268,I4:12,J4:46268,K4:13,M4:46268,N4:14});await service.call(manager,'sync-requirements');assert.equal(current().state,4);
 service.store.put('task',current().id,{...current(),sealed:true,sealedAt:Date.now()});
 const oldHash=current().workbookHash,wb=unpack(await fs.readFile(file()));wb.entries[wb.status.file]=strToU8(wb.status.content.replace('需求表','需求表（已核对）'));await fs.writeFile(file(),Buffer.from(zipSync(wb.entries)));
 let readCount=0;const read=fs.readFile;fs.readFile=async function(target,...args){if(String(target)===file())readCount++;return read.call(this,target,...args)};t.after(()=>{fs.readFile=read});
 const assetFile=path.join(service.nas.config.assetRoot,'removed.png');service.store.put('asset','completed-file',{id:'completed-file',taskId:current().id,files:[{path:assetFile}]});
 await service.call(manager,'sync-requirements');assert.equal(current().workbookHash,oldHash);assert.equal(readCount,0);assert.equal(service.store.get('asset','completed-file').missingAt,undefined);
 await service.call(manager,'sync-requirements',{includeCompleted:true});assert.notEqual(current().workbookHash,oldHash);assert.equal(current().workflowFields.N4,'14');assert.ok(readCount>0);assert.ok(service.store.get('asset','completed-file').missingAt);
});

test('explicit completed refresh is not swallowed by an in-flight background check',async()=>{
 const {RequirementsSync}=require('../core/requirements-sync.cjs');const sync=new RequirementsSync({store:{},nas:{}}),calls=[];let finish;
 sync.run=async(force,completed)=>{calls.push([force,completed]);if(calls.length===1)await new Promise(resolve=>finish=resolve);return {checked:true}};
 const background=sync.check(),manual=sync.check(true,{includeCompleted:true});finish();await Promise.all([background,manual]);assert.deepEqual(calls,[[false,false],[true,true]]);
});

test('manager rolls back every stage, clears workbook milestones and ratings, and can restart the full workflow',async t=>{
 const {service,current,file,edit}=await setup(t);clearInterval(service.requirementsSync.timer);await service.requirementsSync.running;
 await edit({H4:46268,I4:12,J4:46268,K4:13,M4:46268,N4:14,L4:'old-delivery'});
 let wb=unpack(await fs.readFile(file()));wb.entries[wb.status.file]=strToU8(wb.status.content.replace(/(<row r="5">[\s\S]*?)(<\/row>)/,'$1<c r="J5" t="inlineStr"><is><t>质量打分</t></is></c><c r="K5" t="inlineStr"><is><t>时效打分</t></is></c>$2').replace(/(<row r="6">[\s\S]*?)(<\/row>)/,'$1<c r="J6"><v>100</v></c><c r="K6" t="inlineStr"><is><t>满意</t></is></c>$2'));await fs.writeFile(file(),Buffer.from(zipSync(wb.entries)));
 await service.call(manager,'sync-requirements');assert.equal(current().state,4);
 const assetFile=path.join(service.nas.config.assetRoot,'old-output.png');await fs.writeFile(assetFile,'keep original delivery');
 let task=current();task.sealed=true;task.sealedAt=Date.now();task.deliveries=[{id:'prior',path:assetFile}];task.items[0].sealed=true;task.items[0].assetId='prior';task.items[0].assetPath=assetFile;service.store.put('task',task.id,task);service.store.put('asset','prior',{id:'prior',taskId:task.id,files:[{path:assetFile}]});service.store.put('upload','prior',{id:'prior',taskId:task.id,actor:'hong',status:'done'});
 const rollback=()=>service.call(manager,'action',{taskId:current().id,version:current().version,action:'rollback',confirmed:true});
 await assert.rejects(service.call({role:'designer',personId:'hong'},'action',{taskId:task.id,version:task.version,action:'rollback',confirmed:true}),/负责人/);
 await rollback();assert.equal(current().state,4);assert.equal(current().sealed,false);assert.equal(current().deliveries.length,1);
 await rollback();assert.equal(current().state,3);assert.equal(current().completedAt,null);assert.equal(current().deliveries.length,0);assert.equal(current().items[0].sealed,false);assert.equal(current().deliveryHistory[0].deliveries[0].id,'prior');
 wb=unpack(await fs.readFile(file()));for(const addr of ['M4','N4','L4','J6','K6'])assert.equal(wb.status.cells[addr].value,'');assert.equal(await fs.readFile(assetFile,'utf8'),'keep original delivery');
 await assert.rejects(service.assets.commit('prior',{role:'designer',personId:'hong'}),/回退前/);
 await rollback();assert.equal(current().state,2);assert.ok(current().runningSince);assert.equal(current().reviewAt,null);assert.equal(current().workflowFields.J4,'');
 await rollback();assert.equal(current().state,1);assert.equal(current().startedAt,null);assert.equal(current().runningSince,null);assert.equal(current().workflowFields.H4,'');
 await rollback();assert.equal(current().state,0);assert.equal(current().owner,null);assert.match(current().filename,/-未分配.xlsx$/);assert.equal(current().workflowFields.G4,'');
 await assert.rejects(rollback(),/待分配/);
 for(const [action,extra] of [['assign',{owner:'hong'}],['start',{}],['review',{}],['approve',{chatConfirmed:true}]])await service.call(action==='start'||action==='review'?{role:'designer',personId:'hong'}:manager,'action',{taskId:current().id,version:current().version,action,...extra});
 assert.equal(current().state,4);assert.equal(current().sealed,false);assert.equal(current().deliveries.length,0);assert.ok(service.store.events(current().id).filter(e=>e.kind==='rollback').length===5);
 await assert.rejects(service.assets.finish(current().id,{role:'designer',personId:'hong'},current().version));
});

test('rollback respects stale versions, duplicate originals, workbook locks and publishing uploads',async t=>{
 const {service,current,file}=await setup(t);clearInterval(service.requirementsSync.timer);await service.requirementsSync.running;
 const call=(version=current().version)=>service.call(manager,'action',{taskId:current().id,version,action:'rollback',confirmed:true});
 await assert.rejects(call(-1),/更新/);const lock=path.join(path.dirname(file()),'~$'+path.basename(file()));await fs.writeFile(lock,'locked');await assert.rejects(call(),/Excel/);assert.equal(current().state,1);await fs.unlink(lock);await service.call(manager,'sync-requirements');
 const duplicate=path.join(service.nas.config.taskRoot,STAGES[2],current().filename);await fs.copyFile(file(),duplicate);await assert.rejects(call(),/多个状态/);assert.equal(current().state,1);await fs.unlink(duplicate);await service.call(manager,'sync-requirements');
 service.store.put('upload','pending',{id:'pending',taskId:current().id,status:'publishing',files:[]});await assert.rejects(call(),/写入或传输/);assert.equal(current().state,1);
});

test('sealed rollback performs no NAS scan and does not wait for a background scan',async t=>{
 const {service,current}=await setup(t);clearInterval(service.requirementsSync.timer);await service.requirementsSync.running;
 const task={...current(),state:4,sealed:true,sealedAt:Date.now(),completedAt:Date.now()};service.store.put('task',task.id,task);
 const running=service.requirementsSync.running;service.requirementsSync.running=new Promise(()=>{});
 service.requirementsSync.check=async()=>{throw Error('full scan must not run')};service.requirementsSync.checkTask=async()=>{throw Error('metadata rollback must not read a workbook')};service.nas.ready=async()=>{throw Error('NAS must not be read')};service.assets.reconcileMissingAssets=async()=>{throw Error('archive scan must not run')};
 try {const started=Date.now();const next=await Promise.race([service.call(manager,'action',{taskId:task.id,version:task.version,action:'rollback',confirmed:true}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('rollback waited for unrelated scan')),1500);timer.unref()})]);
 assert.equal(next.sealed,false);assert.equal(next.state,4);assert.equal(next.completedAt,task.completedAt);assert.ok(Date.now()-started<1500);
 await assert.rejects(service.call(manager,'action',{taskId:task.id,version:task.version,action:'rollback',confirmed:true}));}finally{service.requirementsSync.running=running}
});

test('stage rollback reads only the selected requirement and leaves global refresh status unchanged',async t=>{
 const {service,current,file,edit,taskRoot}=await setup(t);clearInterval(service.requirementsSync.timer);await service.requirementsSync.running;
 const unrelated=path.join(taskRoot,STAGES[4],'26090311-其他品牌-其他产品-王燕-洪华.xlsx');await fs.writeFile(unrelated,'not part of this action');
 const originalRead=fs.readFile;let reads=0;fs.readFile=async function(target,...args){assert.notEqual(String(target),unrelated);if(String(target)===file())reads++;return originalRead.call(this,target,...args)};t.after(()=>{fs.readFile=originalRead});
 service.scanExisting=async()=>{throw Error('discovery must not run')};service.assets.reconcileMissingAssets=async()=>{throw Error('archive scan must not run')};service.requirementsSync.check=async()=>{throw Error('full refresh must not run')};
 const status=structuredClone(service.requirementsSync.status),old=current();await edit({H4:46268,I4:12});
 await assert.rejects(service.call(manager,'action',{taskId:old.id,version:old.version,action:'rollback',confirmed:true}),/更新/);assert.equal(current().state,2);
 await service.call(manager,'action',{taskId:old.id,version:current().version,action:'rollback',confirmed:true});assert.equal(current().state,1);assert.ok(reads>0);assert.deepEqual(service.requirementsSync.status,status);
});
async function correctBarcode(file,code='6970855224164'){
 const wb=unpack(await fs.readFile(file));wb.entries[wb.status.file]=strToU8(wb.status.content.replace(/(<c r="D6"[^>]*>[\s\S]*?<t>)[^<]*(<\/t>)/,'$1'+code+'$2'));await fs.writeFile(file,Buffer.from(zipSync(wb.entries)));
}
test('manager accepts a barcode correction atomically with rollback and preserves prior delivery identity',async t=>{
 const {service,current,file,edit}=await setup(t);clearInterval(service.requirementsSync.timer);await service.requirementsSync.running;
 await edit({H4:46268,I4:12,J4:46268,K4:13,M4:46268,N4:14});await service.call(manager,'sync-requirements');
 const old=current(),oldCode=old.code;old.deliveries=[{id:'old-code-delivery',code:oldCode}];old.items[0].sealed=true;old.items[0].assetId='old-code-delivery';service.store.put('task',old.id,old);service.store.put('asset','old-code-delivery',{id:'old-code-delivery',taskId:old.id,code:oldCode,files:[]});
 await correctBarcode(file());const changedBytes=await fs.readFile(file());
 const payload={taskId:old.id,version:old.version,action:'rollback',confirmed:true,acceptCodeCorrection:true};
 await assert.rejects(service.call(manager,'action',{...payload,acceptCodeCorrection:false}),/69码/);assert.equal(current().code,oldCode);
 const result=await service.call(manager,'action',payload);assert.equal(result.code,'6970855224164');assert.equal(result.items[0].code,result.code);assert.equal(result.state,3);assert.equal(result.deliveries.length,0);assert.equal(result.items[0].sealed,false);assert.equal(result.deliveryHistory.at(-1).items[0].code,oldCode);assert.equal(service.store.get('asset','old-code-delivery').code,oldCode);assert.equal(result.archiveRound,1);assert.equal(result.workbookSyncIssue,null);
 const wb=unpack(await fs.readFile(file()));assert.equal(wb.status.cells.D6.value,result.code);assert.equal(wb.status.cells.M4.value,'');assert.equal(wb.status.cells.N4.value,'');
 const event=service.store.events(old.id).find(e=>e.kind==='rollback');assert.deepEqual(event.body.codeCorrection,{from:oldCode,to:result.code});
 const job=service.store.all('job').find(j=>j.event?.body?.codeCorrection);assert.deepEqual(await fs.readFile(path.join(service.store.dir,'journals',job.id,'before.xlsx')),changedBytes);
 await service.call(manager,'action',{taskId:old.id,version:result.version,action:'rollback',confirmed:true});assert.equal(current().state,2);assert.equal(current().code,result.code);
});
test('barcode rollback retains permissions, version, duplicate and Excel lock checks',async t=>{
 const {service,current,file}=await setup(t);clearInterval(service.requirementsSync.timer);await service.requirementsSync.running;const old=current();await correctBarcode(file());
 const payload={taskId:old.id,version:old.version,action:'rollback',confirmed:true,acceptCodeCorrection:true};
 await assert.rejects(service.call({role:'designer',personId:'hong'},'action',payload),/负责人/);
 await assert.rejects(service.call(manager,'action',{...payload,version:-1}),/更新/);assert.equal(current().code,old.code);
 const lock=path.join(path.dirname(file()),'~$'+path.basename(file()));await fs.writeFile(lock,'locked');await assert.rejects(service.call(manager,'action',payload),/Excel/);await fs.unlink(lock);
 const duplicate=path.join(service.nas.config.taskRoot,STAGES[2],current().filename);await fs.copyFile(file(),duplicate);await assert.rejects(service.call(manager,'action',payload),/多个状态/);await fs.unlink(duplicate);
 service.store.put('upload','active',{id:'active',taskId:old.id,status:'publishing'});await assert.rejects(service.call(manager,'action',payload),/写入或传输/);assert.equal(current().code,old.code);service.store.remove('upload','active');
});
test('barcode correction fails safely if product also changes or workbook changes after validation',async t=>{
 const {service,current,file}=await setup(t);clearInterval(service.requirementsSync.timer);await service.requirementsSync.running;const old=current(),original=await fs.readFile(file());await correctBarcode(file());
 const corrected=await fs.readFile(file()),wb=unpack(corrected);wb.entries[wb.status.file]=strToU8(wb.status.content.replace('西红花','其他产品'));await fs.writeFile(file(),Buffer.from(zipSync(wb.entries)));
 const payload={taskId:old.id,version:old.version,action:'rollback',confirmed:true,acceptCodeCorrection:true};
 await assert.rejects(service.call(manager,'action',payload),/仅支持更正69码/);assert.equal(current().code,old.code);
 await fs.writeFile(file(),corrected);const check=service.requirementsSync.checkTask.bind(service.requirementsSync);service.requirementsSync.checkTask=async(...args)=>{const result=await check(...args);await fs.writeFile(file(),original);return result};
 await assert.rejects(service.call(manager,'action',payload),/原需求表已修改/);assert.equal(current().code,old.code);assert.equal(current().state,old.state);assert.equal(service.store.events(old.id).filter(e=>e.kind==='rollback').length,0);
});

async function completedCalibrationFixture(t){
 const f=await setup(t);await f.edit({H4:46268,I4:12,J4:46268,K4:13,M4:46268,N4:14});await f.service.requirementsSync.check(true);
 await f.service.requirementsSync.stop();
 const task=f.current();task.sealed=true;task.sealedAt=task.completedAt+1000;task.items[0]={...task.items[0],sealed:true,assetId:'legacy-asset',assetPath:'legacy/path',sealedAt:task.sealedAt};task.deliveries=[{id:'modern-asset',category:'main'}];f.service.store.put('task',task.id,task);
 f.changeItems=async(type='创意图',qty=3,rows=null)=>{const wb=unpack(await fs.readFile(f.file()));let xml=wb.status.content.replace(/(<c\b[^>]*r="F6"[^>]*>)[\s\S]*?<\/c>/,'$1<is><t>'+type+'</t></is></c>').replace(/(<c\b[^>]*r="G6"[^>]*>)[\s\S]*?<\/c>/,'$1<v>'+qty+'</v></c>');if(rows)xml=rows(xml);wb.entries[wb.status.file]=strToU8(xml);const bytes=Buffer.from(zipSync(wb.entries));await fs.writeFile(f.file(),bytes);return bytes};
 f.calibrate=(actor=manager,version=f.current().version)=>f.service.call(actor,'calibrate-contribution',{taskId:f.task.id,version});return f;
}

test('manager calibrates completed types and quantities without changing workbook, timing or archives',async t=>{
 const f=await completedCalibrationFixture(t),before=f.current(),saved=await f.changeItems();
 await assert.rejects(f.calibrate({role:'designer',personId:'hong'}),/仅负责人/);
 await assert.rejects(f.calibrate(manager,before.version-1),/已更新/);
 const result=await f.calibrate();assert.equal(result.previousPoints,1.5);assert.equal(result.nextPoints,6);
 const next=f.current();for(const key of ['completedAt','completedMonth','sealed','sealedAt','elapsedMs','owner','state'])assert.deepEqual(next[key],before[key]);assert.deepEqual(next.deliveries,before.deliveries);assert.equal(next.items[0].assetId,'legacy-asset');assert.equal(next.items[0].type,'creative');assert.equal(next.items[0].points,6);assert.deepEqual(await fs.readFile(f.file()),saved);
 assert.equal(f.service.store.events(next.id)[0].kind,'contribution-calibrated');
 await f.changeItems('简单信息修改',2);await f.calibrate();assert.equal(require('../core/rules.cjs').total(f.current()),0.3);
 const {RequirementsSync}=require('../core/requirements-sync.cjs');await new RequirementsSync(f.service).checkTask(next.id);assert.equal(f.current().workbookSyncIssue,null);
});

test('calibration keeps removed legacy archive links and adds contribution rows',async t=>{
 const f=await completedCalibrationFixture(t);await f.changeItems('创意图',4,xml=>xml.replace(/<row r="6">([\s\S]*?)<\/row>/,(_,cells)=>'<row r="7">'+cells.replace(/r="([A-Z]+)6"/g,'r="$17"')+'</row>'));
 await f.calibrate();assert.equal(f.current().items[0].row,7);assert.equal(f.current().items[0].points,8);assert.equal(f.current().retainedArchiveItems[0].assetId,'legacy-asset');
 const file=path.join(f.root,'assets','legacy.psd');await fs.writeFile(file,'original');f.service.store.put('asset','legacy-asset',{id:'legacy-asset',taskId:f.task.id,files:[{path:file}]});
 await f.service.assets.reconcileMissingAssets();assert.equal(f.current().sealed,true);await fs.unlink(file);await f.service.assets.reconcileMissingAssets();assert.equal(f.current().sealed,false);assert.equal(f.current().retainedArchiveItems[0].sealed,false);
});

test('calibration rejects locks, pending uploads, identity and workflow changes without partial changes',async t=>{
 const f=await completedCalibrationFixture(t),before=f.current();await f.changeItems();const saved=await fs.readFile(f.file()),lock=path.join(path.dirname(f.file()),'~$'+filename);await fs.writeFile(lock,'lock');await assert.rejects(f.calibrate(),/关闭 Excel/);await fs.unlink(lock);
 f.service.store.put('upload','pending',{id:'pending',taskId:f.task.id,status:'publishing'});await assert.rejects(f.calibrate(),/待处理/);f.service.store.remove('upload','pending');
 await f.edit({N4:15});await assert.rejects(f.calibrate(),/流转时间/);await fs.writeFile(f.file(),saved);
 const wb=unpack(saved);wb.entries[wb.status.file]=strToU8(wb.status.content.replace('6970855224163','6970855224999'));await fs.writeFile(f.file(),zipSync(wb.entries));await assert.rejects(f.calibrate(),/69码/);
 assert.deepEqual(f.current(),before);assert.equal(f.service.store.events(before.id).some(e=>e.kind==='contribution-calibrated'),false);
});

test('NAS refresh cannot implicitly authorize a completed contribution edit',async t=>{
 const f=await completedCalibrationFixture(t);await f.changeItems();const {RequirementsSync}=require('../core/requirements-sync.cjs');await new RequirementsSync(f.service).checkTask(f.task.id);
 assert.equal(f.current().items[0].points,1.5);assert.match(f.current().workbookSyncIssue.message,/负责人.*校准点数/);await f.calibrate();assert.equal(f.current().workbookSyncIssue,null);
});

test('calibration rejects duplicate originals and concurrent stale saves',async t=>{
 const f=await completedCalibrationFixture(t);await f.changeItems();const duplicate=path.join(f.taskRoot,STAGES[3],filename);await fs.copyFile(f.file(),duplicate);await assert.rejects(f.calibrate(),/唯一原需求表/);await fs.unlink(duplicate);
 const version=f.current().version,results=await Promise.allSettled([f.calibrate(manager,version),f.calibrate(manager,version)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.match(results.find(r=>r.status==='rejected').reason.message,/已更新/);assert.equal(f.service.store.events(f.task.id).filter(e=>e.kind==='contribution-calibrated').length,1);
});

test('calibration detects a workbook changed during validation and leaves the database unchanged',async t=>{
 const f=await completedCalibrationFixture(t);await f.changeItems();const before=f.current(),originalRead=fs.readFile;let reads=0;
 t.mock.method(fs,'readFile',async function(target,...args){const bytes=await originalRead(target,...args);if(target===f.file()&&++reads===2)return Buffer.concat([bytes,Buffer.from('changed')]);return bytes});
 await assert.rejects(f.calibrate(),/刚刚发生变化/);assert.deepEqual(f.current(),before);assert.equal(f.service.store.all('contributionCalibration').length,0);
});

test('remote manager can calibrate through authenticated RPC while designer cannot',async t=>{
 const f=await completedCalibrationFixture(t),pair=await f.service.call(manager,'manager-pair-code',{host:'127.0.0.1'}),remote=new Client(decodeCode(pair.code));await remote.pair();t.after(()=>remote.close());await f.changeItems();const payload={taskId:f.task.id,version:f.current().version};
 await assert.rejects(f.client.rpc('calibrate-contribution',payload),/仅负责人/);const result=await remote.rpc('calibrate-contribution',payload);assert.equal(result.nextPoints,6);
});

test('calibration preview reports row changes without applying them and confirms the reviewed workbook',async t=>{
 const f=await completedCalibrationFixture(t),before=f.current();const saved=await f.changeItems();
 const payload={taskId:f.task.id,version:before.version,preview:true};
 await assert.rejects(f.service.call({role:'designer',personId:'hong'},'calibrate-contribution',payload),/仅负责人/);
 const preview=await f.service.call(manager,'calibrate-contribution',payload);
 assert.equal(preview.preview,true);assert.equal(preview.version,before.version);assert.equal(preview.workbookHash,digest(saved));assert.equal(preview.previousPoints,1.5);assert.equal(preview.nextPoints,6);
 assert.equal(preview.changes.length,1);assert.equal(preview.changes[0].row,6);assert.equal(preview.changes[0].before.qty,1);assert.equal(preview.changes[0].after.type,'creative');assert.equal(preview.changes[0].after.qty,3);
 assert.deepEqual(f.current(),before);assert.equal(f.service.store.all('contributionCalibration').length,0);assert.equal(f.service.store.events(before.id).some(e=>e.kind==='contribution-calibrated'),false);
 await f.changeItems('创意图',4);
 await assert.rejects(f.service.call(manager,'calibrate-contribution',{taskId:f.task.id,version:preview.version,expectedHash:preview.workbookHash}),/与预览时不同/);assert.deepEqual(f.current(),before);
 const latest=await f.service.call(manager,'calibrate-contribution',payload);
 const result=await f.service.call(manager,'calibrate-contribution',{taskId:f.task.id,version:latest.version,expectedHash:latest.workbookHash});assert.equal(result.nextPoints,8);
 const correction=f.service.store.get('contributionCalibration',require('../core/store.cjs').calibrationKey(before));assert.equal(correction.archiveRound,0);assert.equal(correction.nextPoints,8);
});

test('calibration preview identifies added and removed rows separately',async t=>{
 const f=await completedCalibrationFixture(t);await f.changeItems('创意图',4,xml=>xml.replace(/<row r="6">([\s\S]*?)<\/row>/,(_,cells)=>'<row r="7">'+cells.replace(/r="([A-Z]+)6"/g,'r="$17"')+'</row>'));
 const preview=await f.service.call(manager,'calibrate-contribution',{taskId:f.task.id,version:f.current().version,preview:true});
 assert.deepEqual(preview.changes.map(c=>[c.row,c.before?.row||null,c.after?.row||null]),[[6,6,null],[7,null,7]]);assert.equal(f.current().items[0].row,6);
});

test('calibration ignores retired upload rounds but still blocks active uploads from its current round',async t=>{
 const f=await completedCalibrationFixture(t);f.service.store.put('task',f.task.id,{...f.current(),archiveRound:2});await f.changeItems();
 for(const [id,archiveRound,status] of [['old-uploading',1,'uploading'],['old-publishing',1,'publishing'],['cancelled',2,'cancelled']])f.service.store.put('upload',id,{id,taskId:f.task.id,archiveRound,status});
 const preview=await f.service.call(manager,'calibrate-contribution',{taskId:f.task.id,version:f.current().version,preview:true});assert.equal(preview.nextPoints,6);
 for(const status of ['uploading','publishing']){
  f.service.store.put('upload','active',{id:'active',taskId:f.task.id,archiveRound:2,status});
  await assert.rejects(f.calibrate(),/待处理/);
 }
 f.service.store.remove('upload','active');await f.calibrate();assert.equal(f.current().items[0].points,6);
 assert.equal(f.service.store.get('contributionCalibration',require('../core/store.cjs').calibrationKey(f.current())).archiveRound,2);
 assert.equal(f.service.store.get('upload','old-uploading').status,'uploading');assert.equal(f.service.store.get('upload','cancelled').status,'cancelled');
});

async function inboxReplacement(f,{name=filename,withoutId=false,patch={},changeItems=false}={}){
 const source=f.file(),wb=unpack(patchWorkbook(await fs.readFile(source),patch));
 if(withoutId)wb.entries['xl/workbook.xml']=strToU8(require('fflate').strFromU8(wb.entries['xl/workbook.xml']).replace(/<definedName\b[^>]*name="_DW_TASK_ID"[^>]*>[\s\S]*?<\/definedName>/,''));
 if(changeItems)wb.entries[wb.status.file]=strToU8(wb.status.content.replace('单图任务（复杂元素替换）','创意图').replace(/(<c\b[^>]*r="G6"[^>]*>\s*<v>)1(<\/v>)/,'$13$2'));
 const bytes=Buffer.from(zipSync(wb.entries)),target=path.join(f.taskRoot,STAGES[0],name);
 await fs.writeFile(target,bytes);if(source!==target)await fs.unlink(source);
 return {target,bytes};
}

for(const withoutId of [false,true])test('an assigned inbox replacement '+(withoutId?'without a task ID':'with the original task ID')+' preserves the task and receipts while updating requirement points',async t=>{
 const f=await setup(t);await f.client.rpc('read',{taskId:f.task.id,assignmentId:f.current().assignmentId});await f.service.requirementsSync.stop();f.service.requirementsSync.stopped=false;
 const before=f.current(),replacement=await inboxReplacement(f,{withoutId,changeItems:true});
 await f.service.requirementsSync.run(true,true);const next=f.current(),dest=path.join(f.taskRoot,STAGES[1],filename);
 assert.equal(f.service.store.all('task').length,1);assert.equal(next.id,before.id);assert.equal(next.state,1);assert.equal(next.owner,before.owner);assert.equal(next.assignmentId,before.assignmentId);
 assert.equal(next.receivedAt,before.receivedAt);assert.equal(next.readAt,before.readAt);assert.equal(next.assignedAt,before.assignedAt);assert.equal(next.items[0].type,'creative');assert.equal(next.items[0].qty,3);assert.equal(next.items[0].points,6);
 assert.equal(next.workbookSyncIssue,null);assert.equal(f.file(),dest);await assert.rejects(fs.access(replacement.target));assert.equal(require('../core/workbook.cjs').workbookTaskId(await fs.readFile(dest)),before.id);
 assert.deepEqual(unpack(await fs.readFile(dest)).entries['xl/worksheets/sheet2.xml'],unpack(replacement.bytes).entries['xl/worksheets/sheet2.xml']);
 const version=next.version;await f.service.requirementsSync.run(true,true);assert.equal(f.current().version,version);assert.equal(f.service.store.all('task').length,1);
});

test('a renamed replacement with the same task ID leaves inbox and keeps assignment history',async t=>{
 const f=await setup(t);await f.service.requirementsSync.stop();f.service.requirementsSync.stopped=false;const before=f.current(),name='26090311-九芝堂-西红花改图-王燕-洪华.xlsx';
 const replacement=await inboxReplacement(f,{name,changeItems:true});const result=await f.service.requirementsSync.run(true,true),next=f.current();
 assert.equal(result.relinked,1);assert.equal(f.service.store.all('task').length,1);assert.equal(next.id,before.id);assert.equal(next.filename,name);assert.equal(next.state,1);assert.equal(next.assignmentId,before.assignmentId);assert.equal(next.items[0].points,6);assert.equal(next.workbookSyncIssue,null);
 assert.equal(f.file(),path.join(f.taskRoot,STAGES[1],name));await assert.rejects(fs.access(replacement.target));assert.ok(f.service.store.events(next.id).some(e=>e.kind==='requirement-renamed'));
});

test('a new assigned workbook in inbox imports directly into pending design without creating a second task on refresh',async t=>{
 const f=await setup(t);await f.service.requirementsSync.stop();f.service.requirementsSync.stopped=false;const wb=unpack(workbook()),name='26090311-九芝堂-灵芝孢子粉-王燕-洪华.xlsx';
 wb.entries[wb.status.file]=strToU8(wb.status.content.replace('西红花','灵芝孢子粉').replace('6970855224163','6970855224999'));const source=path.join(f.taskRoot,STAGES[0],name);await fs.writeFile(source,zipSync(wb.entries));
 const result=await f.service.requirementsSync.run(true,true),task=f.service.store.all('task').find(task=>task.filename===name);assert.equal(result.imported,1);assert.ok(task);assert.equal(task.state,1);assert.equal(task.owner,'hong');assert.ok(task.assignmentId);assert.equal(task.startedAt,null);assert.equal(task.workbookSyncIssue,null);
 await assert.rejects(fs.access(source));const dest=path.join(f.taskRoot,STAGES[1],name);assert.equal(require('../core/workbook.cjs').workbookTaskId(await fs.readFile(dest)),task.id);await f.service.requirementsSync.run(true,true);assert.equal(f.service.store.all('task').length,2);
});

test('inbox normalization never resets started, previously timed, archived or uploading tasks or new workflow milestones',async t=>{
 const cases=[
  {label:'started',task:{state:2,startedAt:Date.now()-60000,runningSince:Date.now()-1000}},
  {label:'returned with elapsed time',task:{elapsedMs:60000}},
  {label:'returned with work intervals',task:{workIntervals:[{start:1,end:2,owner:'hong'}]}},
  {label:'delivery history',task:{deliveryHistory:[{at:1,items:[],deliveries:[]}]}},
  {label:'current assets',task:{deliveries:[{id:'kept-delivery',category:'main'}]}},
  {label:'uploading',upload:{status:'uploading'}},
  {label:'publishing',upload:{status:'publishing'}},
  {label:'new start milestone',patch:{H4:46268,I4:12}},
  {label:'partial start milestone',patch:{H4:46268,I4:''}},
  {label:'new review milestone',patch:{J4:46268,K4:13}},
  {label:'new confirmation milestone',patch:{M4:46268,N4:14}},
  {label:'missing assignment date',patch:{E4:'',F4:''}}
 ];
 for(const scenario of cases)await t.test(scenario.label,async st=>{
  const f=await setup(st);await f.service.requirementsSync.stop();f.service.requirementsSync.stopped=false;if(scenario.task){const original=f.file();f.service.store.put('task',f.task.id,{...f.current(),...scenario.task});if(original!==f.file())await fs.rename(original,f.file())}
  if(scenario.upload)f.service.store.put('upload','replacement-upload',{id:'replacement-upload',taskId:f.task.id,archiveRound:0,actor:'hong',...scenario.upload});
  const before=f.current(),replacement=await inboxReplacement(f,{patch:scenario.patch});await f.service.requirementsSync.run(true,true);const next=f.current();
  assert.equal(next.id,before.id);assert.equal(next.state,before.state);assert.equal(next.assignmentId,before.assignmentId);assert.equal(next.workbookHash,before.workbookHash);assert.equal(next.elapsedMs,before.elapsedMs);assert.equal(next.startedAt,before.startedAt);assert.equal(next.runningSince,before.runningSince);assert.deepEqual(next.workIntervals,before.workIntervals);assert.deepEqual(next.deliveries,before.deliveries);assert.deepEqual(next.deliveryHistory,before.deliveryHistory);
  assert.match(next.workbookSyncIssue.message,/待分配需求|封存资产|归档/);assert.deepEqual(await fs.readFile(replacement.target),replacement.bytes);if(scenario.upload)assert.equal(f.service.store.get('upload','replacement-upload').status,scenario.upload.status);
 });
});

test('an assigned inbox replacement waits for Excel close and rejects duplicate originals and foreign task IDs',async t=>{
 const f=await setup(t);await f.service.requirementsSync.stop();f.service.requirementsSync.stopped=false;const before=f.current(),replacement=await inboxReplacement(f,{changeItems:true}),lock=path.join(path.dirname(replacement.target),'~$'+filename);
 await fs.writeFile(lock,'Excel lock');await f.service.requirementsSync.run(true,true);assert.match(f.current().workbookSyncIssue.message,/保存并关闭/);assert.equal(f.current().workbookHash,before.workbookHash);assert.ok(await fs.stat(replacement.target));await fs.unlink(lock);
 const duplicate=path.join(f.taskRoot,STAGES[1],filename);await fs.copyFile(replacement.target,duplicate);await f.service.requirementsSync.run(true,true);assert.match(f.current().workbookSyncIssue.message,/多个状态文件夹/);assert.equal(f.current().items[0].points,before.items[0].points);await fs.unlink(duplicate);
 const wb=unpack(await fs.readFile(replacement.target)),foreign=require('node:crypto').randomUUID();wb.entries['xl/workbook.xml']=strToU8(require('fflate').strFromU8(wb.entries['xl/workbook.xml']).replace(before.id,foreign));await fs.writeFile(replacement.target,zipSync(wb.entries));await f.service.requirementsSync.run(true,true);assert.match(f.current().workbookSyncIssue.message,/内部编号属于另一任务/);assert.equal(f.current().id,before.id);assert.equal(f.current().workbookHash,before.workbookHash);
 await fs.writeFile(replacement.target,replacement.bytes);await f.service.requirementsSync.run(true,true);assert.equal(f.current().state,1);assert.equal(f.current().items[0].points,6);assert.equal(f.current().workbookSyncIssue,null);assert.equal(f.service.store.all('task').length,1);
});
