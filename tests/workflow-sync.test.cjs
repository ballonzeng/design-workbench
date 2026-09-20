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
 await service.call(manager,'configure',{taskRoot,assetRoot});await fs.writeFile(path.join(taskRoot,STAGES[1],filename),workbook());
 let task=await service.importFile(workbook(),filename,{},1,true);
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
test('duplicate originals and changed task identity are blocked with their status folder',async t=>{
 const {client,current,file,taskRoot}=await setup(t),other=path.join(taskRoot,STAGES[2],filename);
 await fs.copyFile(file(),other);await client.rpc('sync-requirements');assert.match(current().workbookSyncIssue.message,/多个状态文件夹/);assert.equal(current().workbookSyncIssue.stage,STAGES[1]);
 await fs.unlink(other);await client.rpc('sync-requirements');assert.equal(current().workbookSyncIssue,null);
 const wb=unpack(await fs.readFile(file()));wb.entries[wb.status.file]=strToU8(wb.status.content.replace('6970855224163','6970855224164'));await fs.writeFile(file(),zipSync(wb.entries));
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

test('normal refresh leaves completed workbooks and archived files untouched; explicit refresh checks both',async t=>{
 const {service,current,edit,file}=await setup(t);clearInterval(service.requirementsSync.timer);await service.requirementsSync.running;
 await edit({H4:46268,I4:12,J4:46268,K4:13,M4:46268,N4:14});await service.call(manager,'sync-requirements');assert.equal(current().state,4);
 const oldHash=current().workbookHash;await edit({N4:15});
 let readCount=0;const read=fs.readFile;fs.readFile=async function(target,...args){if(String(target)===file())readCount++;return read.call(this,target,...args)};t.after(()=>{fs.readFile=read});
 const assetFile=path.join(service.nas.config.assetRoot,'removed.png');service.store.put('asset','completed-file',{id:'completed-file',taskId:current().id,files:[{path:assetFile}]});
 await service.call(manager,'sync-requirements');assert.equal(current().workbookHash,oldHash);assert.equal(readCount,0);assert.equal(service.store.get('asset','completed-file').missingAt,undefined);
 await service.call(manager,'sync-requirements',{includeCompleted:true});assert.notEqual(current().workbookHash,oldHash);assert.equal(current().workflowFields.N4,'15');assert.ok(readCount>0);assert.ok(service.store.get('asset','completed-file').missingAt);
});

test('explicit completed refresh is not swallowed by an in-flight background check',async()=>{
 const {RequirementsSync}=require('../core/requirements-sync.cjs');const sync=new RequirementsSync({store:{},nas:{}}),calls=[];let finish;
 sync.run=async(force,completed)=>{calls.push([force,completed]);if(calls.length===1)await new Promise(resolve=>finish=resolve);return {checked:true}};
 const background=sync.check(),manual=sync.check(true,{includeCompleted:true});finish();await Promise.all([background,manual]);assert.deepEqual(calls,[[false,false],[true,true]]);
});
