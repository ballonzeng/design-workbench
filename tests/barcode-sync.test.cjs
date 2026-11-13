'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {zipSync,strToU8}=require('fflate');
const {workbook}=require('../operator/test-fixture.cjs');
const {Service}=require('../core/service.cjs');
const {parseRequirement,identifyWorkbook,unpack,workflowFields}=require('../core/workbook.cjs');
const {RequirementsSync,reconcileTask}=require('../core/requirements-sync.cjs');
const {archiveIdentity}=require('../core/archive-state.cjs');
const {digest}=require('../core/store.cjs');
const R=require('../core/rules.cjs');
const manager={role:'manager',personId:'zeng'},designer={role:'designer',personId:'hong'};
const filename='26090311-测试品牌-合成商品-测试运营-洪华.xlsx',oldCode='6999999999901',newCode='6999999999902';
const escape=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const cell=(address,value)=>typeof value==='number'?'<c r="'+address+'"><v>'+value+'</v></c>':'<c r="'+address+'" t="inlineStr"><is><t>'+escape(value)+'</t></is></c>';

// All files are generated from a tiny synthetic fixture, never real NAS demands.
function syntheticWorkbook(){
 const wb=unpack(workbook()),cells={A1:'合成测试需求表',A3:'阶段情况',B3:'需求日期',G3:'分配设计',L3:'文件位置',D5:'69码',J5:'质量打分',K5:'时效打分',
  A4:'',B4:46268,C4:11,D4:'测试运营',E4:46268,F4:11,G4:'洪华',H4:'',I4:'',J4:'',K4:'',L4:'',M4:'',N4:'',
  B6:'测试品牌',C6:'合成商品',D6:oldCode,F6:'完整主图精做',G6:2,H6:'保留主图说明',J6:'',K6:'',
  B7:'测试品牌',C7:'合成商品',D7:oldCode,F7:'单图任务（复杂元素替换）',G7:1,H7:'保留修改说明',J7:'',K7:''};
 const rows=new Map();for(const [address,value] of Object.entries(cells)){const row=Number(address.match(/\d+$/)[0]);if(!rows.has(row))rows.set(row,[]);rows.get(row).push(cell(address,value))}
 wb.entries[wb.status.file]=strToU8('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'+[...rows].sort((a,b)=>a[0]-b[0]).map(([row,cells])=>'<row r="'+row+'">'+cells.join('')+'</row>').join('')+'</sheetData></worksheet>');
 return Buffer.from(zipSync(wb.entries));
}
function editCells(bytes,patch){
 const wb=unpack(bytes);let xml=wb.status.content;
 for(const [address,value] of Object.entries(patch)){
  const expression=new RegExp('<c\\b(?=[^>]*\\br="'+address+'")[^>]*(?:\\/>|>[\\s\\S]*?<\\/c>)');
  assert.match(xml,expression,'Synthetic fixture must contain '+address);xml=xml.replace(expression,cell(address,value));
 }
 wb.entries[wb.status.file]=strToU8(xml);return Buffer.from(zipSync(wb.entries));
}
const corrected=bytes=>editCells(bytes,{D6:newCode,D7:newCode});
function unitFixture(state=1){
 const id=crypto.randomUUID(),bytes=identifyWorkbook(syntheticWorkbook(),id),parsed=parseRequirement(bytes,filename),fields=workflowFields(bytes);
 const old={...parsed,id,state,owner:'hong',version:7,filename,assignmentId:'assignment-synthetic',assignedAt:parsed.templateTimes.assignedAt,receivedAt:100,readAt:101,elapsedMs:123456,startedAt:null,runningSince:null,sealed:false,workflowFields:fields,workbookHash:digest(bytes)};
 const nextBytes=corrected(bytes),nextParsed=parseRequirement(nextBytes,filename);
 return {old,bytes,nextBytes,parsed:nextParsed,fields:workflowFields(nextBytes),location:{state,stage:R.STAGES[state],filename}};
}
async function setup(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'barcode-sync-')),taskRoot=path.join(root,'requests'),assetRoot=path.join(root,'assets');await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);
 const service=await new Service(path.join(root,'db'),{host:'127.0.0.1',port:0}).start();
 t.after(async()=>{await service.stop();await fs.rm(root,{recursive:true,force:true})});
 await service.call(manager,'configure',{taskRoot,assetRoot});await service.requirementsSync.stop();service.requirementsSync.stopped=false;
 const bytes=syntheticWorkbook();await fs.writeFile(path.join(taskRoot,R.STAGES[1],filename),bytes);const imported=await service.importFile(bytes,filename,{},1,true);
 const current=()=>service.store.get('task',imported.id),file=()=>service.nas.taskPath(current());
 const edit=async patch=>{const bytes=editCells(await fs.readFile(file()),patch);await fs.writeFile(file(),bytes);return bytes};
 const check=()=>service.requirementsSync.checkTask(imported.id);
 const action=(actor,action,extra={})=>service.call(actor,'action',{taskId:imported.id,action,version:current().version,...extra});
 return {root,taskRoot,assetRoot,service,current,file,edit,check,action};
}

test('a barcode-only correction retains task, assignments, receipts, points and timing, then completes the workflow',async t=>{
 const f=await setup(t);await f.service.call(designer,'read',{taskId:f.current().id,assignmentId:f.current().assignmentId});
 f.service.store.put('task',f.current().id,{...f.current(),elapsedMs:765432});
 const before=f.current(),bytes=await f.edit({D6:newCode,D7:newCode});await f.check();const after=f.current();
 assert.equal(after.code,newCode);assert.ok(after.items.every(i=>i.code===newCode));
 for(const key of ['id','state','owner','assignmentId','assignedAt','receivedAt','readAt','elapsedMs','startedAt','runningSince'])assert.deepEqual(after[key],before[key],key);
 assert.deepEqual(after.items.map(i=>[i.id,i.type,i.qty,i.points,i.note]),before.items.map(i=>[i.id,i.type,i.qty,i.points,i.note]));
 assert.equal(after.workbookHash,digest(bytes));assert.equal(after.workbookSyncIssue,null);assert.equal(f.service.store.all('task').length,1);
 for(const [actor,name,state] of [[designer,'start',2],[designer,'review',3],[manager,'approve',4]]){
  const task=await f.action(actor,name,name==='approve'?{chatConfirmed:true}:{});assert.equal(task.state,state);assert.equal(task.code,newCode);
 }
 assert.equal(parseRequirement(await fs.readFile(f.file()),filename).code,newCode);
});

test('starting with the visible version tolerates only its own safe barcode pre-sync',async t=>{
 const f=await setup(t),before=f.current();await f.edit({D6:newCode,D7:newCode});
 const started=await f.service.call(designer,'action',{taskId:before.id,action:'start',version:before.version});
 assert.equal(started.state,2);assert.equal(started.code,newCode);assert.equal(started.id,before.id);assert.ok(started.version>before.version);
});

test('barcode correction keeps an active or paused design clock and its accumulated intervals intact',async t=>{
 for(const mode of ['running','paused'])await t.test(mode,async t=>{
  const f=await setup(t);await f.action(designer,'start');await f.action(designer,'pause',{reason:'暂时离开'});
  if(mode==='running')await f.action(designer,'resume');
  // Imported work can later have tracked intervals; correcting the code must retain both markers.
  f.service.store.put('task',f.current().id,{...f.current(),timingIncomplete:true,importedTiming:true,externalTiming:true});
  const before=f.current();assert.equal(before.state,2);assert.ok(before.workIntervals.length);assert.equal(!!before.runningSince,mode==='running');
  await f.edit({D6:newCode,D7:newCode});await f.check();const after=f.current();
  assert.equal(after.code,newCode);assert.equal(after.workbookSyncIssue,null);
  for(const key of ['state','owner','assignmentId','assignedAt','startedAt','elapsedMs','runningSince','workIntervals','pauseReason','timingTracked','timingIncomplete','importedTiming','externalTiming','workflowFields'])assert.deepEqual(after[key],before[key],mode+': '+key);
  assert.equal(R.total(after),R.total(before));
 });
});

test('a review-stage barcode correction preserves review milestones, rejects mixed workflow edits and can approve',async t=>{
 const f=await setup(t);await f.action(designer,'start');await f.action(designer,'review');const before=f.current();
 assert.equal(before.state,3);assert.ok(before.reviewAt);const originalHour=before.workflowFields.K4,differentHour=(Number(originalHour)+1)%24;
 await f.edit({D6:newCode,D7:newCode,K4:differentHour});await f.check();
 assert.equal(f.current().code,oldCode);assert.equal(f.current().state,3);assert.equal(f.current().reviewAt,before.reviewAt);assert.equal(f.current().workbookHash,before.workbookHash);assert.ok(f.current().workbookSyncIssue);
 await f.edit({K4:originalHour});await f.check();const after=f.current();
 assert.equal(after.code,newCode);assert.equal(after.workbookSyncIssue,null);
 for(const key of ['state','owner','assignmentId','assignedAt','startedAt','reviewAt','elapsedMs','runningSince','workIntervals','pauseReason','timingTracked','workflowFields'])assert.deepEqual(after[key],before[key],key);
 const approved=await f.action(manager,'approve',{chatConfirmed:true});assert.equal(approved.state,4);assert.equal(approved.code,newCode);assert.equal(approved.reviewAt,before.reviewAt);assert.equal(R.total(approved),R.total(before));
});

test('a completed unarchived task keeps approval month, ratings and points while expiring its old upload',async t=>{
 const f=await setup(t);await f.action(designer,'start');await f.action(designer,'review');await f.action(manager,'approve',{chatConfirmed:true});
 const scored=await f.edit({J6:80,K6:'满意',J7:100}),ratings=parseRequirement(scored,filename).ratings;
 // Model an already recorded operator approval; the action under test edits only the barcode.
 f.service.store.put('task',f.current().id,{...f.current(),ratings,workbookHash:digest(scored)});const before=f.current();
 assert.deepEqual(before.ratings.quality,[{row:6,value:80},{row:7,value:100}]);
 const upload={id:'old-barcode-upload',taskId:before.id,actor:before.owner,status:'uploading',archiveRound:before.archiveRound||0,taskIdentity:archiveIdentity(before),files:[]};f.service.store.put('upload',upload.id,upload);
 await f.edit({D6:newCode,D7:newCode});await f.check();const after=f.current();
 assert.equal(after.code,newCode);assert.equal(after.state,4);assert.equal(after.archiveRound,(before.archiveRound||0)+1);
 for(const key of ['completedAt','completedMonth','ratings','owner','assignmentId','readAt','elapsedMs','confirmationMethod','confirmedBy'])assert.deepEqual(after[key],before[key],key);
 assert.equal(R.total(after),R.total(before));assert.equal(after.workbookSyncIssue,null);assert.equal(f.service.store.get('upload',upload.id).status,'cancelled');
});

test('a completed barcode correction accepts new operator ratings in the same save and retains them on the next sync',async t=>{
 const f=await setup(t);await f.action(designer,'start');await f.action(designer,'review');await f.action(manager,'approve',{chatConfirmed:true});const before=f.current();
 const bytes=await f.edit({D6:newCode,D7:newCode,J6:80,J7:60,K6:'不满'}),ratings=parseRequirement(bytes,filename).ratings;
 assert.notDeepEqual(ratings,before.ratings);await f.check();const after=f.current();
 assert.equal(after.code,newCode);assert.ok(after.items.every(i=>i.code===newCode));assert.equal(after.state,4);assert.equal(after.workbookSyncIssue,null);assert.deepEqual(after.ratings,ratings);
 assert.deepEqual(after.ratings,{quality:[{row:6,value:80},{row:7,value:60}],timeliness:'不满'});
 for(const key of ['completedAt','completedMonth','owner','assignmentId','elapsedMs','confirmationMethod','confirmedBy'])assert.deepEqual(after[key],before[key],key);
 assert.equal(after.workbookHash,digest(bytes));assert.deepEqual(await fs.readFile(f.file()),bytes);assert.equal(R.total(after),R.total(before));
 await f.check();const repeated=f.current();assert.deepEqual(repeated.ratings,ratings);assert.equal(repeated.code,newCode);assert.equal(repeated.workbookHash,digest(bytes));assert.equal(repeated.version,after.version);assert.equal(repeated.archiveRound,after.archiveRound);assert.equal(repeated.workbookSyncIssue,null);
 assert.equal(f.service.store.events(before.id).filter(event=>event.kind==='rollback').length,0);
});

test('ordinary refresh and background checks adopt a saved barcode correction while a completed task awaits archive',async t=>{
 for(const mode of ['ordinary refresh','background','first background after restart'])await t.test(mode,async t=>{
  const f=await setup(t);await f.action(designer,'start');await f.action(designer,'review');await f.action(manager,'approve',{chatConfirmed:true});
  const scored=await f.edit({J6:80,J7:100,K6:'满意'}),ratings=parseRequirement(scored,filename).ratings;
  f.service.store.put('task',f.current().id,{...f.current(),ratings,workbookHash:digest(scored),receivedAt:100,readAt:101});
  const before=f.current(),saved=await f.edit({D6:newCode,D7:newCode});
  const result=mode==='first background after restart'?await new RequirementsSync(f.service).check():mode==='background'?await f.service.requirementsSync.check():await f.service.call(designer,'sync-requirements');
  const after=f.current();assert.equal(result.checked,true);assert.equal(after.code,newCode);assert.equal(after.workbookSyncIssue,null);
  assert.ok(after.items.every(item=>item.code===newCode));assert.equal(after.workbookHash,digest(saved));assert.deepEqual(await fs.readFile(f.file()),saved);
  for(const key of ['id','state','sealed','owner','assignmentId','assignedAt','receivedAt','readAt','elapsedMs','startedAt','reviewAt','completedAt','completedMonth','confirmationMethod','confirmedBy','ratings'])assert.deepEqual(after[key],before[key],key);
  assert.deepEqual(after.items.map(item=>[item.id,item.row,item.type,item.qty,item.points,item.note]),before.items.map(item=>[item.id,item.row,item.type,item.qty,item.points,item.note]));
  assert.equal(R.total(after),R.total(before));assert.equal(f.service.store.all('task').length,1);
  const events=f.service.store.events(before.id).filter(event=>event.kind==='excel-synced'&&event.body.codeCorrection);
  assert.equal(events.length,1);assert.deepEqual(events[0].body.codeCorrection,{from:oldCode,to:newCode});
 });
});

test('unchanged pending archives stay cached on ordinary refresh; explicit completed refresh rereads them',async t=>{
 const f=await setup(t);await f.action(designer,'start');await f.action(designer,'review');await f.action(manager,'approve',{chatConfirmed:true});
 await f.service.call(manager,'sync-requirements');const before=f.current(),target=f.file();
 const read=fs.readFile;let reads=0;t.mock.method(fs,'readFile',async(file,...args)=>{if(String(file)===target)reads++;return read(file,...args)});
 const missing=path.join(f.assetRoot,'do-not-scan-completed.png');f.service.store.put('asset','pending-asset',{id:'pending-asset',taskId:before.id,files:[{path:missing}]});
 await f.service.call(manager,'sync-requirements');await f.service.requirementsSync.check();await f.service.call(designer,'sync-requirements');
 assert.equal(reads,0);assert.equal(f.current().version,before.version);assert.equal(f.service.store.get('asset','pending-asset').missingAt,undefined);
 await f.service.call(manager,'sync-requirements',{includeCompleted:true});assert.ok(reads>0);assert.ok(f.service.store.get('asset','pending-asset').missingAt);
});

test('only saved pending workbooks are reread while sealed history stays untouched',async t=>{
 const f=await setup(t);await f.action(designer,'start');await f.action(designer,'review');await f.action(manager,'approve',{chatConfirmed:true});
 const extra=[];
 for(const [title,sealed] of [['合成任务二',false],['合成已封存',true]]){
  const name=filename.replace('合成商品',title),bytes=editCells(syntheticWorkbook(),{H4:46268,I4:12,J4:46268,K4:13,M4:46268,N4:14,H6:title});
  await fs.writeFile(path.join(f.taskRoot,R.STAGES[4],name),bytes);let task=await f.service.importFile(bytes,name,{},4,true);
  if(sealed){task={...task,sealed:true,sealedAt:Date.now()};f.service.store.put('task',task.id,task)}
  extra.push({task,file:f.service.nas.taskPath(task)});
 }
 await f.service.call(manager,'sync-requirements');
 const stable=f.current(),changed=extra[0],sealed=extra[1];
 await fs.writeFile(changed.file,corrected(await fs.readFile(changed.file)));await fs.writeFile(sealed.file,corrected(await fs.readFile(sealed.file)));
 const read=fs.readFile,counts=new Map();t.mock.method(fs,'readFile',async(file,...args)=>{const key=String(file);counts.set(key,(counts.get(key)||0)+1);return read(file,...args)});
 const result=await f.service.call(manager,'sync-requirements');
 assert.equal(result.checked,true);assert.equal(counts.get(f.file())||0,0);assert.equal(counts.get(changed.file),1);assert.equal(counts.get(sealed.file)||0,0);
 assert.equal(f.current().version,stable.version);assert.equal(f.service.store.get('task',changed.task.id).code,newCode);assert.deepEqual(f.service.store.get('task',sealed.task.id),sealed.task);
});

test('a save during pending-archive sync is retried without adopting stale bytes',async t=>{
 const f=await setup(t);await f.action(designer,'start');await f.action(designer,'review');await f.action(manager,'approve',{chatConfirmed:true});
 await f.service.call(manager,'sync-requirements');const before=f.current(),bytes=await f.edit({D6:newCode,D7:newCode}),latestCode='6999999999903',later=editCells(bytes,{D6:latestCode,D7:latestCode}),target=f.file();
 const stat=fs.stat;let stats=0;t.mock.method(fs,'stat',async(...args)=>{if(String(args[0])===target&&++stats===3){await fs.writeFile(target,later);const now=new Date(Date.now()+2000);await fs.utimes(target,now,now)}return stat(...args)});
 await f.service.call(manager,'sync-requirements');assert.ok(stats>=3);assert.equal(f.current().code,oldCode);assert.equal(f.current().workbookHash,before.workbookHash);assert.deepEqual(await fs.readFile(target),later);
 await f.service.requirementsSync.check();assert.equal(f.current().code,latestCode);assert.equal(f.current().workbookHash,digest(later));assert.equal(f.current().workbookSyncIssue,null);
});

test('pending-archive barcode changes resume after an Excel lock is removed',async t=>{
 const f=await setup(t);await f.action(designer,'start');await f.action(designer,'review');await f.action(manager,'approve',{chatConfirmed:true});
 await f.service.call(manager,'sync-requirements');const before=f.current();await f.edit({D6:newCode,D7:newCode});
 const lock=path.join(path.dirname(f.file()),'~$'+filename);await fs.writeFile(lock,'synthetic Excel lock');
 await f.service.requirementsSync.check();assert.equal(f.current().code,oldCode);assert.equal(f.current().workbookHash,before.workbookHash);assert.match(f.current().workbookSyncIssue.message,/Excel|占用/);
 await fs.unlink(lock);await f.service.requirementsSync.check();assert.equal(f.current().code,newCode);assert.equal(f.current().workbookSyncIssue,null);
});

test('ordinary refresh reports pending workbook conflicts without adopting mixed requirement edits',async t=>{
 const f=await setup(t);await f.action(designer,'start');await f.action(designer,'review');await f.action(manager,'approve',{chatConfirmed:true});
 const before=f.current();await f.edit({D6:newCode,D7:newCode,G6:before.items[0].qty+1});
 const result=await f.service.call(manager,'sync-requirements');assert.equal(result.checked,true);assert.equal(result.taskIssues,1);
 assert.equal(f.current().code,oldCode);assert.equal(f.current().workbookHash,before.workbookHash);assert.equal(R.total(f.current()),R.total(before));assert.match(f.current().workbookSyncIssue.message,/69码|事项/);
 await f.edit({G6:before.items[0].qty});const retried=await f.service.call(manager,'sync-requirements');assert.equal(retried.taskIssues,0);assert.equal(f.current().code,newCode);assert.equal(f.current().workbookSyncIssue,null);
});

test('reconcile changes only barcode identity and preserves item IDs and point metadata',()=>{
 const f=unitFixture();f.old.items[0].calibrationNote='负责人确认的点数说明';
 const after=reconcileTask(f.old,f.parsed,f.fields,f.location,200000);
 assert.equal(after.code,newCode);assert.ok(after.items.every(i=>i.code===newCode));assert.equal(after.version,f.old.version+1);
 assert.equal(after.items[0].calibrationNote,f.old.items[0].calibrationNote);assert.equal(after.items[0].points,f.old.items[0].points);assert.equal(after.readAt,f.old.readAt);
});

test('automatic barcode adoption never accepts another task, changed product, missing ID or mixed requirement edits',async t=>{
 const variants=[
  ['another task',f=>{f.parsed.workbookTaskId=crypto.randomUUID()}],
  ['missing fixed ID',f=>{f.parsed.workbookTaskId=null}],
  ['another product',f=>{f.parsed.product='另一商品';for(const i of f.parsed.items)i.product=f.parsed.product}],
  ['another brand',f=>{f.parsed.brand='另一品牌';for(const i of f.parsed.items)i.brand=f.parsed.brand}],
  ['another workbook brand',f=>{f.parsed.workbookBrand='另一表内品牌';for(const i of f.parsed.items)i.workbookBrand=f.parsed.workbookBrand}],
  ['another operator',f=>{f.parsed.operator='其他运营'}],
  ['another designer',f=>{f.parsed.requestedDesigner='吕慧芸'}],
  ['another title',f=>{f.parsed.title='合成商品改稿'}],
  ['another requested time',f=>{f.parsed.requestedAt+=3600000}],
  ['quantity edit',f=>{f.parsed.items[0].qty++}],
  ['note edit',f=>{f.parsed.items[0].note='新增需求'}],
  ['link edit',f=>{f.parsed.items[0].linkId='https://example.invalid/other'}],
  ['item type edit',f=>{f.parsed.items[0].type='simple'}],
  ['workflow edit',f=>{f.fields.H4='46268';f.fields.I4='12';f.parsed.templateTimes.startedAt=f.old.requestedAt+3600000}],
  ['different folder',f=>{f.location.state=2;f.location.stage=R.STAGES[2]}],
  ['invalid barcode',f=>{f.parsed.code='123';for(const i of f.parsed.items)i.code='123'}]
 ];
 for(const [name,mutate] of variants)await t.test(name,()=>{const f=unitFixture();mutate(f);assert.throws(()=>reconcileTask(f.old,f.parsed,f.fields,f.location),undefined,name)});
});

test('current archived assets and pending publication still require explicit manager repair',async t=>{
 const variants=[
  ['delivery',f=>{f.old.deliveries=[{id:'current-delivery',category:'main'}]}],
  ['sealed task',f=>{f.old.sealed=true}],
  ['sealed item',f=>{f.old.items[0].sealed=true}],
  ['retained asset',f=>{f.old.retainedArchiveItems=[{assetId:'still-linked'}]}],
  ['pending publication',f=>{f.uploads=[{id:'publishing',taskId:f.old.id,archiveRound:0,status:'publishing'}]}]
 ];
 for(const [name,mutate] of variants)await t.test(name,()=>{const f=unitFixture();mutate(f);assert.throws(()=>reconcileTask(f.old,f.parsed,f.fields,f.location,Date.now(),f.uploads||[]))});
});

test('duplicate originals and Excel locks cannot be bypassed by barcode correction',async t=>{
 const f=await setup(t),before=f.current();await f.edit({D6:newCode,D7:newCode});
 const duplicate=path.join(f.taskRoot,R.STAGES[2],filename);await fs.copyFile(f.file(),duplicate);await f.check();
 assert.equal(f.current().code,oldCode);assert.match(f.current().workbookSyncIssue.message,/多个状态文件夹/);await fs.unlink(duplicate);
 const lock=path.join(path.dirname(f.file()),'~$'+filename);await fs.writeFile(lock,'synthetic Excel lock');await f.check();
 assert.equal(f.current().code,oldCode);assert.equal(f.current().workbookHash,before.workbookHash);assert.match(f.current().workbookSyncIssue.message,/Excel|占用/);
 await fs.unlink(lock);await f.check();assert.equal(f.current().code,newCode);assert.equal(f.current().workbookSyncIssue,null);
});

test('barcode pre-sync cannot turn an already stale action into a valid request',async t=>{
 const f=await setup(t),stale=f.current();f.service.store.put('task',stale.id,{...stale,version:stale.version+1,readAt:Date.now()});
 await f.edit({D6:newCode,D7:newCode});
 await assert.rejects(f.service.call(designer,'action',{taskId:stale.id,action:'start',version:stale.version}),/任务已更新|刷新/);
 assert.equal(f.current().state,1);assert.equal(f.current().code,newCode);
});

test('a workbook saved again during barcode adoption is never overwritten or committed from stale bytes',async t=>{
 const f=await setup(t),before=f.current(),bytes=await f.edit({D6:newCode,D7:newCode}),later=editCells(bytes,{H6:'同步期间再次保存的需求说明'}),target=f.file();
 const stat=fs.stat;let reads=0;
 t.mock.method(fs,'stat',async(...args)=>{if(String(args[0])===target&&++reads===3){await fs.writeFile(target,later);const now=new Date(Date.now()+2000);await fs.utimes(target,now,now)}return stat(...args)});
 await f.check();assert.ok(reads>=3,'Must reach the post-read concurrency check');
 assert.equal(f.current().code,oldCode);assert.equal(f.current().workbookHash,before.workbookHash);assert.deepEqual(await fs.readFile(target),later);
});
