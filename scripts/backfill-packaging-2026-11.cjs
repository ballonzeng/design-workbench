'use strict';
// Deliberately separate from Store: opening this helper cannot migrate task_versions.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {DatabaseSync,backup}=require('node:sqlite');
const {prepareHistoricalTasks,isHistoricalTask}=require('../core/historical-tasks.cjs');
const R=require('../core/rules.cjs');
const ROOT=path.resolve(__dirname,'..'),OUTPUTS=path.join(ROOT,'outputs');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const key=row=>JSON.stringify([row.kind,row.id]);
const fail=message=>{throw Error(message)};
function parseArgs(argv){
 argv=argv.flatMap(arg=>{const at=arg.indexOf('=');return arg.startsWith('--')&&at>0?[arg.slice(0,at),arg.slice(at+1)]:[arg]});
 const options={apply:false,verify:false};
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];
  if(arg==='--apply')options.apply=true;
  else if(arg==='--verify')options.verify=true;
  else if(arg==='--dry-run'){}
  else if(['--db','--plan','--output','--expect-original-count','--closed-pid','--service-file'].includes(arg)){
   const value=argv[++i];if(!value||value.startsWith('--'))fail('Missing value: '+arg);
   options[{'--db':'dbPath','--plan':'planPath','--output':'outputDir','--expect-original-count':'expectOriginalCount','--closed-pid':'closedPid','--service-file':'serviceFile'}[arg]]=value;
  }else fail('Unknown argument: '+arg);
 }
 if(options.apply&&options.verify)fail('--apply and --verify cannot be combined');
 for(const field of ['dbPath','planPath'])if(typeof options[field]!=='string'||!path.isAbsolute(options[field]))fail('--'+(field==='dbPath'?'db':'plan')+' must be an absolute existing path');
 for(const field of ['expectOriginalCount','closedPid'])if(options[field]!==undefined){options[field]=Number(options[field]);if(!Number.isSafeInteger(options[field])||options[field]<0||field==='closedPid'&&options[field]===0)fail('Invalid '+field)}
 if(options.serviceFile&&!path.isAbsolute(options.serviceFile))fail('--service-file must be absolute');
 return options;
}
function readPlan(filename){
 const bytes=fs.readFileSync(filename),plan=JSON.parse(bytes.toString('utf8'));
 if(plan.status!=='confirmed')fail('The supplement plan must have status confirmed');
 if(!Array.isArray(plan.records)||plan.records.length!==6)fail('Expected exactly six confirmed packaging records');
 const rows=plan.records.map((row,index)=>{
  if(row.type!=='packaging-design'||row.dateMeaning!=='completed'||!['completed',4].includes(row.state))fail('Record '+(index+1)+' lacks confirmed completion meaning');
  if(row.completedDate&&row.date&&row.completedDate!==row.date)fail('Conflicting completion dates at record '+(index+1));
  if(row.rate!==undefined&&row.rate!==4||row.points!==undefined&&row.points!==row.qty*4)fail('Packaging rate/points mismatch');
  return {owner:row.owner||row.designer,product:row.product,qty:row.qty,completedDate:row.completedDate||row.date,brand:row.brand??null,code:row.code??null,operator:row.operator??null,note:row.note??null,sourceKey:row.dedupeKey||row.sourceKey||null};
 });
 if(rows.reduce((n,r)=>n+r.qty,0)!==12)fail('Expected twelve packaging proposals and forty-eight points');
 return {rows,planHash:sha(bytes)};
}
function snapshot(db){
 const records=db.prepare('SELECT kind,id,body FROM records ORDER BY kind,id').all();
 const events=db.prepare('SELECT seq,at,taskId,actor,kind,body FROM events ORDER BY seq').all();
 const versions=db.prepare('SELECT seq,taskId,at,body FROM task_versions ORDER BY seq').all();
 return {records,events,versions,hash:sha(JSON.stringify({records,events,versions}))};
}
function recordBodies(state,kind){return state.records.filter(row=>row.kind===kind).map(row=>({...JSON.parse(row.body),id:row.id}))}
function receiptState(state){
 const counts={};for(const row of state.records)counts[row.kind]=(counts[row.kind]||0)+1;
 return {snapshotHash:state.hash,recordCounts:counts,eventCount:state.events.length,lastEventSeq:state.events.at(-1)?.seq||0,taskVersionsCount:state.versions.length,taskVersionsHash:sha(JSON.stringify(state.versions)),eventsHash:sha(JSON.stringify(state.events)),originalRecords:state.records.map(row=>({kind:row.kind,id:row.id,sha256:sha(row.body)}))};
}
function transactionSnapshot(db){db.exec('BEGIN');try{const state=snapshot(db);db.exec('COMMIT');return state}catch(e){db.exec('ROLLBACK');throw e}}
function processAlive(pid){if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true}catch(e){return e.code!=='ESRCH'}}
function assertManagerClosed(options,state){
 if(options.closedPid&&processAlive(options.closedPid))fail('The original manager process is still running: '+options.closedPid);
 if(process.platform!=='win32')fail('Production apply requires Windows manager-process verification');
 const code="[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter \"Name='设计协作负责人端.exe'\" | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress";
 const text=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,timeout:20000}).trim();
 const value=text?JSON.parse(text):[],pids=Array.isArray(value)?value:[value];
 if(pids.length)fail('Exit the manager from the tray before applying; running PIDs: '+pids.join(','));
 const nas=state.records.find(row=>row.kind==='setting'&&row.id==='nas'),config=nas?JSON.parse(nas.body):null;
 const leaseFile=options.serviceFile||(config?.taskRoot?path.join(config.taskRoot,'_workbench-system','service.json'):null);
 if(leaseFile){
  let lease;try{lease=JSON.parse(fs.readFileSync(leaseFile,'utf8'))}catch(e){if(e.code==='ENOENT')return;throw e}
  if(lease.host!==os.hostname())fail('A remote manager lease is still present; do not modify its database');
  if(!Number.isSafeInteger(Number(lease.pid))||processAlive(Number(lease.pid)))fail('Manager NAS lease has not been safely released');
 }
}
function outputDirectory(input){
 const dir=path.resolve(input||path.join(OUTPUTS,'packaging-backfill-2026-11-03'));
 if(dir!==OUTPUTS&&!dir.toLowerCase().startsWith((OUTPUTS+path.sep).toLowerCase()))fail('Backups and receipts must remain under the workspace outputs directory');
 fs.mkdirSync(dir,{recursive:true});
 if(!fs.realpathSync(dir).toLowerCase().startsWith((fs.realpathSync(OUTPUTS)+path.sep).toLowerCase())&&fs.realpathSync(dir)!==fs.realpathSync(OUTPUTS))fail('Output directory resolves outside the workspace');
 return dir;
}
function contextFor(state,now){return {existingTasks:recordBodies(state,'task'),existingHistorical:recordBodies(state,'historicalTask'),people:R.PEOPLE.map(p=>({...p,removed:state.records.some(r=>r.kind==='removedMember'&&r.id===p.id)})),now,actor:'zeng',source:'user-confirmed-historical'}}
function verifyDesired(state,desired){
 const historical=new Map(recordBodies(state,'historicalTask').map(t=>[t.id,t]));
 const found=desired.map(expected=>{
  const record=historical.get(expected.id);if(!record||!isHistoricalTask(record))fail('Missing or invalid historical supplement: '+expected.id);
  if(record.owner!==expected.owner||record.product!==expected.product||record.completedDate!==expected.completedDate||record.items[0].qty!==expected.items[0].qty||record.items[0].points!==expected.items[0].points)fail('Supplement differs from confirmed plan: '+expected.id);
  return record;
 });
 const totals={records:found.length,qty:found.reduce((n,t)=>n+t.items[0].qty,0),points:found.reduce((n,t)=>n+t.items[0].points,0)};
 if(totals.records!==6||totals.qty!==12||totals.points!==48)fail('Post-write totals differ from 6 records, 12 proposals, 48 points');
 return totals;
}
function verifyOnlyIntendedWrites(before,after,inserted,now){
 const original=new Map(before.records.map(row=>[key(row),row.body])),current=new Map(after.records.map(row=>[key(row),row.body]));
 for(const [id,body] of original)if(current.get(id)!==body)fail('An existing record changed during backfill');
 const extra=after.records.filter(row=>!original.has(key(row)));
 if(extra.length!==inserted.length||extra.some(row=>row.kind!=='historicalTask'||!inserted.some(t=>t.id===row.id)))fail('Unexpected record insertion');
 if(JSON.stringify(before.versions)!==JSON.stringify(after.versions))fail('Native task_versions changed during backfill');
 if(JSON.stringify(after.events.slice(0,before.events.length))!==JSON.stringify(before.events))fail('Original events changed during backfill');
 const events=after.events.slice(before.events.length);
 if(events.length!==inserted.length||events.some(e=>e.kind!=='historical-task-supplemented'||e.actor!=='zeng'||e.at!==now||!inserted.some(t=>t.id===e.taskId)))fail('Unexpected event changes');
 return events.map(e=>e.seq);
}
function writeReceipt(filename,value){const temporary=filename+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value,null,2));fs.renameSync(temporary,filename)}
async function runBackfill(options,{ensureClosed=assertManagerClosed}={}){
 const dbPath=path.resolve(options.dbPath),planPath=path.resolve(options.planPath);
 if(!fs.statSync(dbPath).isFile())fail('Database path must be an existing file');
 const {rows,planHash}=readPlan(planPath),outputDir=outputDirectory(options.outputDir),now=Date.now();
 const stamp=new Date(now).toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex');
 const mode=options.apply?'apply':options.verify?'verify':'dry-run',receiptPath=path.join(outputDir,mode+'-'+stamp+'.json');
 const db=new DatabaseSync(dbPath,{readOnly:!options.apply});let inTransaction=false,committed=false,receipt;
 try{
  db.exec('PRAGMA busy_timeout=5000');if(!options.apply)db.exec('PRAGMA query_only=ON');
  const before=transactionSnapshot(db),context=contextFor(before,now);
  if(options.expectOriginalCount!==undefined&&context.existingTasks.length!==Number(options.expectOriginalCount))fail('Original native task count differs from expected '+options.expectOriginalCount);
  const desired=prepareHistoricalTasks(rows,{...context,existingTasks:[],existingHistorical:[]}).records;
  if(desired.length!==6||desired.reduce((n,t)=>n+t.items[0].points,0)!==48)fail('Confirmed plan cannot produce exactly six valid supplements');
  const prepared=prepareHistoricalTasks(rows,context),desiredIds=new Set(desired.map(t=>t.id));
  if(prepared.skipped.some(s=>!desiredIds.has(s.id)))fail('A confirmed row duplicates an original task; inspect before supplementing');
  for(const expected of desired){const previous=context.existingHistorical.find(t=>t.id===expected.id);if(previous&&!isHistoricalTask(previous))fail('Existing supplement ID has invalid content: '+expected.id)}
  receipt={schemaVersion:1,mode,status:'prepared',at:now,dbPath,planPath,planHash,before:receiptState(before),planned:{records:6,qty:12,points:48},createdCount:prepared.records.length,skippedCount:prepared.skipped.length,ids:desired.map(t=>t.id),backupPath:null,productionWritten:false};
  if(!options.apply){
   if(options.verify){receipt.totals=verifyDesired(before,desired);if(prepared.records.length)fail('Verification still has pending supplements');receipt.status='verified'}else receipt.status='dry-run';
   if(transactionSnapshot(db).hash!==before.hash)fail('Database changed while the read-only check was running; repeat the check');
   writeReceipt(receiptPath,receipt);return {mode,status:receipt.status,created:prepared.records.length,skipped:prepared.skipped.length,planned:receipt.planned,originalTasks:context.existingTasks.length,receiptPath};
  }
  ensureClosed(options,before);
  const backupPath=path.join(outputDir,'before-backfill-'+stamp+'.sqlite');await backup(db,backupPath);
  const backupDb=new DatabaseSync(backupPath,{readOnly:true});try{if(transactionSnapshot(backupDb).hash!==before.hash)fail('Backup does not match the verified source snapshot')}finally{backupDb.close()}
  receipt.backupPath=backupPath;receipt.backupSHA256=sha(fs.readFileSync(backupPath));receipt.status='backup-created';writeReceipt(receiptPath,receipt);
  db.exec('BEGIN IMMEDIATE');inTransaction=true;
  if(snapshot(db).hash!==before.hash)fail('Database changed after preview/backup; no supplements written');
  ensureClosed(options,before);
  const insert=db.prepare('INSERT INTO records(kind,id,body) VALUES(?,?,?)'),event=db.prepare('INSERT INTO events(at,taskId,actor,kind,body) VALUES(?,?,?,?,?)');
  for(const task of prepared.records){
   insert.run('historicalTask',task.id,JSON.stringify(task));
   event.run(now,task.id,'zeng','historical-task-supplemented',JSON.stringify({source:'user-confirmed-historical',completedDate:task.completedDate,completedTimePrecision:'day',owner:task.owner,product:task.product,type:'packaging-design',qty:task.items[0].qty,points:task.items[0].points,planHash}));
  }
  const after=snapshot(db),eventSeqs=verifyOnlyIntendedWrites(before,after,prepared.records,now);receipt.totals=verifyDesired(after,desired);
  db.exec('COMMIT');inTransaction=false;committed=true;
  receipt.status='applied';receipt.productionWritten=prepared.records.length>0;receipt.after=receiptState(after);receipt.rollback={requiresManagerClosed:true,backupPath,insertedHistoricalTaskIds:prepared.records.map(t=>t.id),insertedEventSeqs:eventSeqs};
  writeReceipt(receiptPath,receipt);
  return {mode,status:'applied',created:prepared.records.length,skipped:prepared.skipped.length,totals:receipt.totals,originalTasks:context.existingTasks.length,backupPath,receiptPath};
 }catch(e){
  if(inTransaction){db.exec('ROLLBACK');inTransaction=false}
  if(receipt){receipt.status=committed?'committed-receipt-error':'failed';receipt.error=e.message;try{writeReceipt(receiptPath,receipt)}catch{}}
  if(committed)e.message='Database commit completed; verify before retrying. Receipt error: '+e.message;
  throw e;
 }finally{db.close()}
}
if(require.main===module)runBackfill(parseArgs(process.argv.slice(2))).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={parseArgs,readPlan,snapshot,receiptState,assertManagerClosed,verifyDesired,verifyOnlyIntendedWrites,runBackfill};
