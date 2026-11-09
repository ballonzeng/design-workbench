'use strict';
// Registers already copied and verified archives. It never copies, renames or deletes files.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync,backup}=require('node:sqlite');
const {readPlan,snapshot,receiptState,assertManagerClosed}=require('./backfill-packaging-2026-11.cjs');
const {historicalId,isHistoricalTask}=require('../core/historical-tasks.cjs');
const {guarded,fileHash,folderName,isInside}=require('../core/nas.cjs');
const R=require('../core/rules.cjs');
const IMAGES=new Set(['.png','.jpg','.jpeg','.gif']);
const OUTPUTS=path.resolve(__dirname,'../outputs'),EXPECTED={records:6,files:57,bytes:685850386,sourceFiles:49,outputFiles:8};
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),fail=message=>{throw Error(message)};
const recordKey=row=>JSON.stringify([row.kind,row.id]);
function parseArgs(argv){
 argv=argv.flatMap(arg=>{const at=arg.indexOf('=');return arg.startsWith('--')&&at>0?[arg.slice(0,at),arg.slice(at+1)]:[arg]});
 const options={apply:false,verify:false};
 for(let i=0;i<argv.length;i++){
  const flag=argv[i];if(flag==='--apply')options.apply=true;else if(flag==='--verify')options.verify=true;else if(flag==='--dry-run'){}
  else if(['--db','--archives','--plan','--output','--expect-original-count','--closed-pid','--service-file'].includes(flag)){
   const value=argv[++i];if(!value||value.startsWith('--'))fail('Missing value: '+flag);
   options[{'--db':'dbPath','--archives':'archivesPath','--plan':'planPath','--output':'outputDir','--expect-original-count':'expectOriginalCount','--closed-pid':'closedPid','--service-file':'serviceFile'}[flag]]=value;
  }else fail('Unknown argument: '+flag);
 }
 if(options.apply&&options.verify)fail('--apply and --verify cannot be combined');
 for(const field of ['dbPath','archivesPath'])if(typeof options[field]!=='string'||!path.isAbsolute(options[field]))fail(field+' must be absolute');
 for(const field of ['planPath','serviceFile'])if(options[field]&&!path.isAbsolute(options[field]))fail(field+' must be absolute');
 for(const field of ['closedPid','expectOriginalCount'])if(options[field]!==undefined){options[field]=Number(options[field]);if(!Number.isSafeInteger(options[field])||options[field]<0||field==='closedPid'&&options[field]===0)fail('Invalid '+field)}
 return options;
}
function readSnapshot(db){db.exec('BEGIN');try{const result=snapshot(db);db.exec('COMMIT');return result}catch(e){db.exec('ROLLBACK');throw e}}
function outputDirectory(value){
 const dir=path.resolve(value||path.join(OUTPUTS,'packaging-backfill-2026-11-03'));
 if(!isInside(OUTPUTS,dir))fail('Receipts and backups must remain under workspace outputs');fs.mkdirSync(dir,{recursive:true});
 if(!isInside(fs.realpathSync(OUTPUTS),fs.realpathSync(dir)))fail('Output directory resolves outside workspace outputs');return dir;
}
function archiveId(archive){
 const value='historical-archive:v1:'+JSON.stringify([archive.taskId,archive.sourceRoot.toLowerCase(),archive.files.map(f=>[f.relativePath,f.kind,f.size,f.sha256])]);
 const b=crypto.createHash('sha256').update(value).digest().subarray(0,16);b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;
 const h=b.toString('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20);
}
function cleanRelative(value){
 if(typeof value!=='string'||!value||path.isAbsolute(value)||value.includes('\\')||value.split('/').some(v=>!v||v==='.'||v==='..'||/[<>:"|?*\x00-\x1f]/.test(v)))fail('Invalid relative file path');return value;
}
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function loadBundle(filename,planPath,state,expected=EXPECTED){
 const bytes=fs.readFileSync(filename),bundle=JSON.parse(bytes.toString('utf8'));
 if(bundle.schemaVersion!==1||bundle.source!=='user-confirmed-historical'||bundle.status!=='archived'||!Array.isArray(bundle.archives)||bundle.archives.length!==6)fail('Expected six completed archive manifests');
 if(!equal(bundle.totals,expected)){
  for(const field of Object.keys(expected))if(bundle.totals?.[field]!==expected[field])fail('Archive bundle total differs: '+field);
 }
 const {rows}=readPlan(planPath),desired=new Map(rows.map(row=>[historicalId(row.owner,row.product,row.completedDate,row.qty),row]));
 const historical=new Map(state.records.filter(row=>row.kind==='historicalTask').map(row=>[row.id,JSON.parse(row.body)]));
 const configRecord=state.records.find(row=>row.kind==='setting'&&row.id==='nas'),config=configRecord&&JSON.parse(configRecord.body);
 if(!config||typeof config.assetRoot!=='string'||!path.isAbsolute(config.assetRoot))fail('Database has no valid configured asset root');
 const ids=new Set(),taskIds=new Set(),sources=new Set(),destinations=new Set();let files=0,total=0,sourceFiles=0,outputFiles=0;
 for(const archive of bundle.archives){
  const task=historical.get(archive.taskId),row=desired.get(archive.taskId);
  if(!row||!task||!isHistoricalTask(task))fail('Archive does not match a valid intended historical task');
  if(archive.source!=='historical-supplement-archive'||archive.status!=='archived'||archive.identification!=='pending-code'||archive.category!=='packaging'||archive.author!==task.owner||archive.product!==task.product||archive.code!==null||!Number.isFinite(archive.at))fail('Archive identity differs from historical task');
  if(task.owner!==row.owner||task.product!==row.product||task.completedDate!==row.completedDate||task.items[0].qty!==row.qty)fail('Historical task differs from confirmed plan');
  if(typeof archive.sourceRoot!=='string'||!path.isAbsolute(archive.sourceRoot)||!Array.isArray(archive.files)||!archive.files.length||archiveId(archive)!==archive.id)fail('Archive source, files or identifier is invalid');
  if(ids.has(archive.id)||taskIds.has(archive.taskId)||sources.has(path.resolve(archive.sourceRoot).toLowerCase()))fail('Duplicate task, archive or source folder');
  ids.add(archive.id);taskIds.add(archive.taskId);sources.add(path.resolve(archive.sourceRoot).toLowerCase());
  const product=path.join(config.assetRoot,'_待69码定位','包装设计',folderName(task.product)),taskRoot=path.join(product,archive.deliveryFolder);
  if(archive.productPath!==product||archive.path!==taskRoot||archive.manifestPath!==path.join(taskRoot,'_archive-manifest.json'))fail('Archive destination differs from its fixed pending-code location');
  if(isInside(archive.sourceRoot,archive.path)||isInside(archive.path,archive.sourceRoot))fail('Source and destination folders cannot contain one another');
  const person=R.PEOPLE.find(p=>p.id===task.owner),date=archive.archiveDate;
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T12:00:00Z').toISOString().slice(0,10)!==date)fail('Invalid archive date');
  if(archive.deliveryFolder!==date.slice(5,7)+date.slice(8,10)+'-'+person.name+'-包装设计')fail('Archive delivery folder does not match designer and date');
  let archiveBytes=0;
  for(const file of archive.files){
   cleanRelative(file.relativePath);if(!['source','output'].includes(file.kind)||!Number.isSafeInteger(file.size)||file.size<0||!/^[a-f0-9]{64}$/.test(file.sha256)||file.name!==path.posix.basename(file.relativePath))fail('Invalid archived file descriptor');
   if(file.kind!==(IMAGES.has(path.posix.extname(file.relativePath).toLowerCase())?'output':'source'))fail('File source/image classification differs from native archive rules');
   const expectedPath=path.join(taskRoot,file.kind==='source'?'01.源文件':'02.导出图片',archive.deliveryFolder,...file.relativePath.split('/'));
   if(file.path!==expectedPath||file.relative!==archive.deliveryFolder+'/'+file.relativePath)fail('File is outside its category/task layout');
   const target=path.resolve(file.path).toLowerCase();if(destinations.has(target))fail('Repeated archive destination');destinations.add(target);
   files++;archiveBytes+=file.size;total+=file.size;if(file.kind==='source')sourceFiles++;else outputFiles++;
  }
  if(archive.totalSize!==archiveBytes||archive.fileCount!==archive.files.length)fail('Archive per-task totals differ from file list');
 }
 const totals={records:taskIds.size,files,bytes:total,sourceFiles,outputFiles};
 for(const field of Object.keys(expected))if(totals[field]!==expected[field])fail('Physical plan total differs: '+field);
 return {bundle,totals,config,archivesHash:sha(bytes)};
}
async function verifiedFile(filename,size,hash,stamps){
 const before=await fs.promises.lstat(filename);if(!before.isFile()||before.isSymbolicLink()||before.size!==size)fail('Archive file missing, linked, or wrong size');
 if(await fileHash(filename)!==hash)fail('Archive file SHA256 mismatch');
 const after=await fs.promises.lstat(filename);if(!after.isFile()||after.isSymbolicLink()||before.size!==after.size||before.mtimeMs!==after.mtimeMs)fail('Archive file changed during verification');
 stamps.push({path:filename,size:after.size,mtimeMs:after.mtimeMs});
}
async function sourceFilePaths(root){
 const result=[];
 async function walk(relative=''){
  const current=await guarded(root,...relative.split('/').filter(Boolean));
  for(const entry of await fs.promises.readdir(current,{withFileTypes:true})){
   const next=relative?relative+'/'+entry.name:entry.name,file=await guarded(root,...next.split('/')),stat=await fs.promises.lstat(file);
   if(stat.isSymbolicLink())fail('Source folder contains a link');
   if(stat.isDirectory())await walk(next);else if(stat.isFile())result.push(next);else fail('Source contains an unsupported entry');
  }
 }
 await walk();return result.sort();
}
async function verifyPhysical(archives,assetRoot){
 const stamps=[];
 for(const archive of archives){
  const source=await fs.promises.lstat(archive.sourceRoot);if(!source.isDirectory()||source.isSymbolicLink())fail('Original archive folder is missing or linked');await guarded(archive.sourceRoot);
  if(!equal(await sourceFilePaths(archive.sourceRoot),archive.files.map(file=>file.relativePath).sort()))fail('Source folder file list changed after archiving');
  const manifestPath=await guarded(assetRoot,path.relative(assetRoot,archive.manifestPath)),manifestBytes=await fs.promises.readFile(manifestPath);
  if(!equal(JSON.parse(manifestBytes.toString('utf8')),archive))fail('Published immutable manifest differs from registration bundle');
  await verifiedFile(manifestPath,manifestBytes.length,sha(manifestBytes),stamps);
  for(const file of archive.files){
   const destination=await guarded(assetRoot,path.relative(assetRoot,file.path)),original=await guarded(archive.sourceRoot,...file.relativePath.split('/'));
   await verifiedFile(destination,file.size,file.sha256,stamps);await verifiedFile(original,file.size,file.sha256,stamps);
  }
 }
 return stamps;
}
async function assertStamps(stamps){for(const previous of stamps){const current=await fs.promises.lstat(previous.path);if(!current.isFile()||current.isSymbolicLink()||current.size!==previous.size||current.mtimeMs!==previous.mtimeMs)fail('A verified file changed before registration')}}
function intendedRows(state,archives){
 const original=new Map(state.records.map(row=>[recordKey(row),row.body])),inserts=[],changed=[];
 for(const archive of archives){
  let touched=false;const body=JSON.stringify(archive);
  for(const [kind,id] of [['historicalArchive',archive.taskId],['asset',archive.id]]){
   const previous=original.get(JSON.stringify([kind,id]));if(previous!==undefined&&previous!==body)fail('An existing archive/asset index differs; nothing overwritten');
   if(previous===undefined){inserts.push({kind,id,body});touched=true}
  }
  if(touched)changed.push(archive);
 }
 return {inserts,changed};
}
function verifyWrites(before,after,inserts,changed,now){
 const previous=new Map(before.records.map(row=>[recordKey(row),row.body])),current=new Map(after.records.map(row=>[recordKey(row),row.body]));
 for(const [id,body] of previous)if(current.get(id)!==body)fail('An original record was modified');
 const extra=after.records.filter(row=>!previous.has(recordKey(row)));
 if(extra.length!==inserts.length||extra.some(row=>!inserts.some(i=>i.kind===row.kind&&i.id===row.id&&i.body===row.body)))fail('Unexpected record insertion');
 if(!equal(before.versions,after.versions)||!equal(before.events,after.events.slice(0,before.events.length)))fail('Original versions or events were modified');
 const events=after.events.slice(before.events.length);
 if(events.length!==changed.length||events.some(event=>event.at!==now||event.kind!=='historical-task-archived'||event.actor!=='zeng'||!changed.some(a=>a.taskId===event.taskId)))fail('Unexpected archive audit entries');
 return events.map(event=>event.seq);
}
function writeReceipt(filename,value){const temporary=filename+'.tmp';fs.writeFileSync(temporary,JSON.stringify(value,null,2));fs.renameSync(temporary,filename)}
async function runRegistration(options,{ensureClosed=assertManagerClosed,expected=EXPECTED}={}){
 const dbPath=path.resolve(options.dbPath),archivesPath=path.resolve(options.archivesPath),planPath=path.resolve(options.planPath||path.join(path.dirname(archivesPath),'plan.json'));
 if(!fs.statSync(dbPath).isFile())fail('Database must be an existing file');
 const mode=options.apply?'apply':options.verify?'verify':'dry-run',output=outputDirectory(options.outputDir),now=Date.now(),stamp=new Date(now).toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex'),receiptPath=path.join(output,'register-archive-'+mode+'-'+stamp+'.json');
 const db=new DatabaseSync(dbPath,{readOnly:!options.apply});let inTransaction=false,committed=false,receipt;
 try{
  db.exec('PRAGMA busy_timeout=5000');if(!options.apply)db.exec('PRAGMA query_only=ON');const before=readSnapshot(db);
  const nativeCount=before.records.filter(row=>row.kind==='task').length;if(options.expectOriginalCount!==undefined&&nativeCount!==Number(options.expectOriginalCount))fail('Native task count differs from expected');
  const {bundle,totals,config,archivesHash}=loadBundle(archivesPath,planPath,before,expected),{inserts,changed}=intendedRows(before,bundle.archives);
  const stamps=await verifyPhysical(bundle.archives,config.assetRoot);
  receipt={schemaVersion:1,mode,status:'verified-files',at:now,dbPath,archivesPath,archivesHash,planPath,before:receiptState(before),totals,archiveIds:bundle.archives.map(a=>a.id),taskIds:bundle.archives.map(a=>a.taskId),createdCount:changed.length,skippedCount:6-changed.length,newIndexCount:inserts.length,productionWritten:false};
  if(!options.apply){if(options.verify&&inserts.length)fail('Archive index registration is incomplete');if(readSnapshot(db).hash!==before.hash)fail('Database changed during preview');receipt.status=options.verify?'verified':'dry-run';writeReceipt(receiptPath,receipt);return {mode,status:receipt.status,totals,created:changed.length,skipped:6-changed.length,newIndexes:inserts.length,originalTasks:nativeCount,receiptPath}}
  ensureClosed(options,before);const backupPath=path.join(output,'before-archive-registration-'+stamp+'.sqlite');await backup(db,backupPath);
  const copy=new DatabaseSync(backupPath,{readOnly:true});try{if(readSnapshot(copy).hash!==before.hash)fail('Backup differs from verified source')}finally{copy.close()}
  receipt.backupPath=backupPath;receipt.backupSHA256=sha(fs.readFileSync(backupPath));receipt.status='backup-created';writeReceipt(receiptPath,receipt);
  db.exec('BEGIN IMMEDIATE');inTransaction=true;if(snapshot(db).hash!==before.hash)fail('Database changed since preview');ensureClosed(options,before);await assertStamps(stamps);
  const insert=db.prepare('INSERT INTO records(kind,id,body) VALUES(?,?,?)'),event=db.prepare('INSERT INTO events(at,taskId,actor,kind,body) VALUES(?,?,?,?,?)');
  for(const row of inserts)insert.run(row.kind,row.id,row.body);
  for(const archive of changed)event.run(now,archive.taskId,'zeng','historical-task-archived',JSON.stringify({assetId:archive.id,identification:'pending-code',path:archive.path,productPath:archive.productPath,manifestPath:archive.manifestPath,files:archive.fileCount,bytes:archive.totalSize,source:'user-confirmed-historical',archivesHash}));
  const after=snapshot(db),eventSeqs=verifyWrites(before,after,inserts,changed,now);if(intendedRows(after,bundle.archives).inserts.length)fail('Archive registration verification failed');
  db.exec('COMMIT');inTransaction=false;committed=true;receipt.status='applied';receipt.productionWritten=inserts.length>0;receipt.after=receiptState(after);receipt.rollback={requiresManagerClosed:true,backupPath,insertedIndexes:inserts.map(({kind,id})=>({kind,id})),insertedEventSeqs:eventSeqs};writeReceipt(receiptPath,receipt);
  return {mode,status:'applied',totals,created:changed.length,skipped:6-changed.length,newIndexes:inserts.length,originalTasks:nativeCount,backupPath,receiptPath};
 }catch(error){if(inTransaction)db.exec('ROLLBACK');if(receipt){receipt.status=committed?'committed-receipt-error':'failed';receipt.error=error.message;try{writeReceipt(receiptPath,receipt)}catch{}}if(committed)error.message='Registration committed; verify before retrying. '+error.message;throw error}finally{db.close()}
}
if(require.main===module)runRegistration(parseArgs(process.argv.slice(2))).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={parseArgs,archiveId,loadBundle,verifyPhysical,intendedRows,verifyWrites,runRegistration};
