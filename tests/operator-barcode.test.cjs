'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {zipSync,strToU8,strFromU8}=require('fflate');
const {OperatorStore}=require('../operator/store.cjs'),{workbook}=require('../operator/test-fixture.cjs');
const {STAGES}=require('../core/rules.cjs'),{identifyWorkbook,parseRequirement,unpack,patchWorkbook}=require('../core/workbook.cjs');
const ID='11111111-1111-4111-8111-111111111111',CODE='6970855224164';
async function fixture(t,state=1,transform=bytes=>bytes){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'operator-barcode-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const stage of STAGES)await fs.mkdir(path.join(root,stage));
 const store=await new OperatorStore(path.join(root,'profile')).init();await store.configure({name:'王燕',root});
 const filename='26090311-九芝堂-西红花-王燕-洪华.xlsx',file=path.join(root,STAGES[state],filename),bytes=transform(identifyWorkbook(workbook(),ID));await fs.writeFile(file,bytes);
 const task=(await store.scan(state===4?'history':'active')).tasks[0];return {root,store,filename,file,bytes,task};
}
function changeXml(bytes,change){const wb=unpack(bytes);wb.entries[wb.status.file]=strToU8(change(wb.status.content));return Buffer.from(zipSync(wb.entries))}
async function manifests(root){const dir=path.join(root,'_workbench-system','recovery','barcode-corrections'),jobs=await fs.readdir(dir);return Promise.all(jobs.map(async job=>({dir:path.join(dir,job),...JSON.parse(await fs.readFile(path.join(dir,job,'manifest.json'),'utf8'))})))}

test('operator corrects own waiting, in-design and review barcode without changing workflow or other ZIP entries',async t=>{
 for(const state of [1,2,3])await t.test('stage '+state,async t=>{
  const f=await fixture(t,state,bytes=>changeXml(bytes,xml=>xml.replace('</sheetData>','</sheetData><sheetProtection sheet="1"/>'))),before=parseRequirement(f.bytes,f.filename),beforeZip=unpack(f.bytes);
  const result=await f.store.correctCode(f.task.id,CODE,f.task.sourceHash),afterBytes=await fs.readFile(f.file),after=parseRequirement(afterBytes,f.filename),afterZip=unpack(afterBytes);
  assert.equal(result.tasks[0].state,state);assert.equal(after.code,CODE);assert.equal(after.workbookTaskId,ID);assert.deepEqual(after.templateTimes,before.templateTimes);assert.equal(after.items[0].qty,before.items[0].qty);assert.equal(after.ratings.quality[0].value,before.ratings.quality[0].value);
  assert.match(afterZip.status.content,/<sheetProtection sheet="1"\/>/);for(const [name,value]of Object.entries(beforeZip.entries))if(name!==beforeZip.status.file)assert.deepEqual(afterZip.entries[name],value,name);
  const [record]=await manifests(f.root);assert.equal(record.status,'completed');assert.equal(record.from,before.code);assert.equal(record.to,CODE);assert.deepEqual(await fs.readFile(record.before),f.bytes);assert.match(await fs.readFile(path.join(f.store.dir,'actions.jsonl'),'utf8'),/correct-code/);
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).filter(name=>/^[.~]/.test(name)),[]);
 });
});

test('barcode correction rejects another operator, stale preview and externally saved originals',async t=>{
 const f=await fixture(t);f.store.settings.name='另一个运营';await assert.rejects(f.store.correctCode(f.task.id,CODE,f.task.sourceHash),/原需求已变化/);f.store.settings.name='王燕';
 await assert.rejects(f.store.correctCode(f.task.id,CODE,'0'.repeat(64)),/原需求已变化/);await fs.writeFile(f.file,patchWorkbook(f.bytes,{E4:46269}));await assert.rejects(f.store.correctCode(f.task.id,CODE,f.task.sourceHash),/原需求已变化/);
});

test('barcode correction respects Excel owner locks and validates the new code',async t=>{
 const f=await fixture(t),lock=path.join(path.dirname(f.file),'~$'+f.filename);await fs.writeFile(lock,'active');
 await assert.rejects(f.store.correctCode(f.task.id,CODE,f.task.sourceHash),/Excel/);assert.deepEqual(await fs.readFile(f.file),f.bytes);assert.equal(await fs.readFile(lock,'utf8'),'active');
 await assert.rejects(f.store.correctCode(f.task.id,'123',f.task.sourceHash),/13位/);
});

test('barcode correction rejects a copied internal task ID in another stage',async t=>{
 const f=await fixture(t),duplicate=path.join(f.root,STAGES[2],'26090311-九芝堂-西红花副本-王燕-洪华.xlsx');await fs.writeFile(duplicate,f.bytes);
 await assert.rejects(f.store.correctCode(f.task.id,CODE,f.task.sourceHash),/唯一原表/);assert.deepEqual(await fs.readFile(f.file),f.bytes);assert.deepEqual(await fs.readFile(duplicate),f.bytes);
});

test('barcode correction blocks completed tasks, an archive location and linked archive history',async t=>{
 await t.test('completed',async t=>{const f=await fixture(t,4);await assert.rejects(f.store.correctCode(f.task.id,CODE,f.task.sourceHash),/阶段/)});
 await t.test('location',async t=>{const f=await fixture(t,2,bytes=>patchWorkbook(bytes,{L4:'主图：旧产品目录'}));await assert.rejects(f.store.correctCode(f.task.id,CODE,f.task.sourceHash),/负责人核对产物归属/)});
 await t.test('history',async t=>{const f=await fixture(t,2),dir=path.join(f.root,'_workbench-system','asset-records');await fs.mkdir(dir,{recursive:true});await fs.writeFile(path.join(dir,'history.json'),JSON.stringify({taskId:ID}));await assert.rejects(f.store.correctCode(f.task.id,CODE,f.task.sourceHash),/负责人核对产物归属/);assert.deepEqual(await fs.readFile(f.file),f.bytes)});
});

test('barcode correction finds a moved column and a shared merged anchor for multiple items',async t=>{
 const f=await fixture(t,1,bytes=>changeXml(bytes,xml=>xml.replace(/r="D5"/g,'r="O5"').replace(/r="D6"/g,'r="O6"').replace('</sheetData>','<row r="7"><c r="B7" t="inlineStr"><is><t>九芝堂</t></is></c><c r="C7" t="inlineStr"><is><t>西红花</t></is></c><c r="F7" t="inlineStr"><is><t>单图任务（复杂元素替换）</t></is></c><c r="G7"><v>2</v></c></row></sheetData>').replace('count="1"><mergeCell','count="2"><mergeCell ref="O6:O7"/><mergeCell')));
 const result=await f.store.correctCode(f.task.id,CODE,f.task.sourceHash),after=unpack(await fs.readFile(f.file));assert.equal(result.tasks[0].items.length,2);assert.ok(result.tasks[0].items.every(item=>item.code===CODE));assert.equal(after.status.cells.O6.value,CODE);assert.equal(after.status.cells.O7,undefined);assert.equal(after.status.cells.D6,undefined);
});

test('a publication failure restores the original and leaves a recoverable journal',async t=>{
 const f=await fixture(t),copy=fs.copyFile;fs.copyFile=async(from,to,flags)=>{if(path.basename(from).startsWith('.operator-code-')&&from.endsWith('.tmp'))throw Object.assign(Error('模拟写入失败'),{code:'EIO'});return copy(from,to,flags)};t.after(()=>{fs.copyFile=copy});
 await assert.rejects(f.store.correctCode(f.task.id,CODE,f.task.sourceHash),/模拟写入失败/);assert.deepEqual(await fs.readFile(f.file),f.bytes);const [record]=await manifests(f.root);assert.equal(record.status,'rolled-back');assert.deepEqual(await fs.readFile(record.before),f.bytes);assert.deepEqual((await fs.readdir(path.dirname(f.file))).filter(name=>/^[.~]/.test(name)),[]);
});

test('an uncooperative concurrent save is never overwritten and both copies remain recoverable',async t=>{
 const f=await fixture(t),concurrent=patchWorkbook(f.bytes,{E4:46269}),copy=fs.copyFile;fs.copyFile=async(from,to,flags)=>{if(path.basename(from).startsWith('.operator-code-')&&from.endsWith('.tmp')){await fs.writeFile(to,concurrent);throw Object.assign(Error('目标已存在'),{code:'EEXIST'})}return copy(from,to,flags)};t.after(()=>{fs.copyFile=copy});
 await assert.rejects(f.store.correctCode(f.task.id,CODE,f.task.sourceHash),/未覆盖另一份保存/);assert.deepEqual(await fs.readFile(f.file),concurrent);const [record]=await manifests(f.root);assert.equal(record.status,'recovery-needed');assert.deepEqual(await fs.readFile(record.before),f.bytes);assert.deepEqual(await fs.readFile(record.backup),f.bytes);
});

test('a manifest failure after publication preserves the corrected original and backup without unlinking a later save',async t=>{
 for(const concurrentSave of [false,true])await t.test(concurrentSave?'a later Excel save is retained':'the published correction is retained',async t=>{
  const f=await fixture(t),writeFile=fs.writeFile,unlink=fs.unlink;let failureInjected=false,publishedBytes,currentFileUnlinks=0;
  fs.writeFile=async(file,data,options)=>{
   if(path.basename(file)==='manifest.json'&&!failureInjected&&JSON.parse(String(data)).status==='completed'){
    failureInjected=true;publishedBytes=await fs.readFile(f.file);
    if(concurrentSave){publishedBytes=patchWorkbook(publishedBytes,{E4:46269});await writeFile(f.file,publishedBytes)}
    throw Object.assign(Error('模拟已发布后日志写入失败'),{code:'EIO'});
   }
   return writeFile(file,data,options);
  };
  fs.unlink=async file=>{if(file===f.file)currentFileUnlinks++;return unlink(file)};
  t.after(()=>{fs.writeFile=writeFile;fs.unlink=unlink});
  await assert.rejects(f.store.correctCode(f.task.id,CODE,f.task.sourceHash),/恢复资料保留/);
  assert.equal(failureInjected,true);assert.equal(currentFileUnlinks,0);assert.deepEqual(await fs.readFile(f.file),publishedBytes);assert.equal(parseRequirement(publishedBytes,f.filename).code,CODE);
  const [record]=await manifests(f.root);assert.equal(record.status,'recovery-needed');assert.match(record.error,/已发布后日志写入失败/);assert.match(record.recoveryError,/当前原表与备份/);assert.deepEqual(await fs.readFile(record.before),f.bytes);assert.deepEqual(await fs.readFile(record.backup),f.bytes);
  if(concurrentSave)assert.equal(unpack(await fs.readFile(f.file)).status.cells.E4.value,'46269');
 });
});
