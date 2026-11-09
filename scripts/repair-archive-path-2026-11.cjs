'use strict';
// One specific layout-2 archive repair. Preview is the default; production apply
// must be reviewed separately and run with the manager completely closed.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync,backup}=require('node:sqlite');
const {guarded,isInside,fileHash}=require('../core/nas.cjs');
const {unpack,mergedValue,patchWorkbook}=require('../core/workbook.cjs');
const {hasWorkbookLock}=require('../core/workbook-lock.cjs');
const {snapshot,receiptState,assertManagerClosed}=require('./backfill-packaging-2026-11.cjs');
const TASK='847af439-ffa9-4459-8be1-57c4be5b6a11',UPLOAD='35762b63-b62d-4a73-a7ec-2931846d2ef1';
const ASSET_ROOT='\\\\Kyuan_NAS\\共享产品主图及详情\\00.设计资产库',TASK_ROOT='\\\\Kyuan_NAS\\任务对接库';
const OUTPUTS=path.resolve(__dirname,'../outputs'),DEFAULT_DB=path.join(process.env.APPDATA||'C:\\Users\\WIN10\\AppData\\Roaming','设计协作·负责人端','workspaces','49eccbca4e09212f9fa7','workbench.sqlite');
const FILES=[
 {id:'0',kind:'output',relative:path.join('1030-洪华-创意图','创意图01.jpg'),size:656134,sha256:'d8fe8d4c8c685249899a941212156028b9c04f61b645b31d76dd4852152c91fd'},
 {id:'1',kind:'source',relative:'1030-洪华-创意图.psd',size:45238788,sha256:'be7a091eb287b4564f403e9e3e36883adebf2a68f4e1c10a608d3d1aea93842c'}
];
const fail=message=>{throw Error(message)},sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
function processAlive(pid){try{process.kill(pid,0);return true}catch(error){return error.code!=='ESRCH'}}
function safelyStale(lease){return !!lease&&/^[a-f0-9-]{36}$/i.test(lease.id||'')&&lease.host===os.hostname()&&Number.isSafeInteger(lease.pid)&&lease.pid>0&&Number.isFinite(lease.at)&&!processAlive(lease.pid)}
async function exists(file){try{await fsp.lstat(file);return true}catch(error){if(error.code==='ENOENT')return false;throw error}}
function args(argv){
 const options={apply:false,dbPath:DEFAULT_DB};
 for(let i=0;i<argv.length;i++){if(argv[i]==='--apply')options.apply=true;else if(argv[i]==='--dry-run'){}else if(['--db','--output'].includes(argv[i])){const flag=argv[i],value=argv[++i];if(!value||value.startsWith('--')||!path.isAbsolute(value))fail(flag+' requires an absolute path');options[flag==='--db'?'dbPath':'outputDir']=value}else fail('Unknown option: '+argv[i])}
 return options;
}
function readState(db){db.exec('BEGIN');try{const state=snapshot(db);db.exec('COMMIT');return state}catch(error){db.exec('ROLLBACK');throw error}}
function row(state,kind,id){const entry=state.records.find(row=>row.kind===kind&&row.id===id);if(!entry)fail('Missing intended '+kind+' record');return JSON.parse(entry.body)}
function assertRoots(config,dbPath,fixtureRoot){
 if(!config||!path.isAbsolute(config.assetRoot||'')||!path.isAbsolute(config.taskRoot||''))fail('Configured NAS roots are missing');
 if(fixtureRoot){const root=path.resolve(fixtureRoot);if(path.dirname(root)!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('archive-path-repair-fixture-'))fail('Test fixture must be a dedicated temporary directory');for(const location of [dbPath,config.assetRoot,config.taskRoot])if(!isInside(root,location))fail('Fixture paths must stay in the dedicated temporary directory')}
 else if(!same(config.assetRoot,ASSET_ROOT)||!same(config.taskRoot,TASK_ROOT))fail('Only the specifically named company NAS roots may be repaired');
}
async function verifyFile(file,expected){const stat=await fsp.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==expected.size||await fileHash(file)!==expected.sha256)fail('File size/hash differs: '+file);return {size:stat.size,sha256:expected.sha256}}
async function listFiles(root){const result=[];async function visit(dir){for(const item of await fsp.readdir(dir,{withFileTypes:true})){const child=path.join(dir,item.name);if(item.isSymbolicLink())fail('Symbolic links are not allowed: '+child);if(item.isDirectory())await visit(child);else if(item.isFile())result.push(child);else fail('Unsupported entry: '+child)}}await visit(root);return result.sort()}
function changedRows(before,after){const old=new Map(before.records.map(row=>[row.kind+'\0'+row.id,row.body]));return after.records.filter(row=>old.get(row.kind+'\0'+row.id)!==row.body)}
async function makePlan(db,options,{fixtureRoot=null,files=FILES}={}){
 if(files!==FILES&&!fixtureRoot)fail('Production repair uses only the two fixed reviewed file hashes');
 const before=readState(db),config=row(before,'setting','nas'),task=row(before,'task',TASK),asset=row(before,'asset',UPLOAD),upload=row(before,'upload',UPLOAD);
 assertRoots(config,options.dbPath,fixtureRoot);
 if(task.state!==4||task.sealed!==true||task.owner!=='hong'||task.code!=='6979143610602'||task.runningSince||task.blocked||task.archiveRound)fail('The specific completed task identity/state changed');
 if(task.deliveries?.length!==1||task.deliveries[0].id!==UPLOAD||task.deliveries[0].category!=='creative'||task.deliveries[0].folder!=='1030-洪华-创意图')fail('Expected exactly the screenshot creative delivery');
 if(upload.taskId!==TASK||upload.actor!=='hong'||upload.status!=='done'||upload.storageLayout!==2||upload.archiveRound||upload.maintenanceError||asset.taskId!==TASK||asset.author!=='hong'||asset.category!=='creative')fail('Upload or asset no longer matches the layout-2 completed archive');
 const oldRoot=await guarded(config.assetRoot,path.relative(config.assetRoot,upload.category.path));
 if(path.basename(oldRoot)!=='任务-'+TASK||!same(oldRoot,task.deliveries[0].path)||!same(oldRoot,asset.path))fail('The three records do not point to the exact old UUID directory');
 if([...(task.items||[]),...(task.retainedArchiveItems||[])].some(item=>['assetPath','productPath'].some(key=>typeof item[key]==='string'&&isInside(oldRoot,item[key]))))fail('Legacy item-level live archive references need a separate reviewed migration');
 const categoryRoot=path.dirname(oldRoot),productRoot=path.dirname(categoryRoot);
 if(path.basename(categoryRoot)!=='04.创意图'||!same(productRoot,upload.product?.path)||!same(productRoot,task.deliveries[0].productPath)||!path.basename(productRoot).endsWith('-6979143610602'))fail('Product/category root differs from the reviewed screenshot');
 const category={path:categoryRoot,source:path.join(categoryRoot,'01.源文件'),output:path.join(categoryRoot,'02.导出图片')};
 if(!same(upload.category.source,path.join(oldRoot,'01.源文件'))||!same(upload.category.output,path.join(oldRoot,'02.导出图片')))fail('Old source/output layout differs');
 if(upload.files?.length!==2||asset.files?.length!==2||Object.keys(upload.published||{}).length!==2||files.length!==2)fail('Exactly two known archive files are required');
 for(const entry of before.records){const value=JSON.parse(entry.body);if(entry.kind==='upload'&&['uploading','publishing'].includes(value.status)&&((value.taskId===TASK)||value.product?.path&&same(value.product.path,productRoot)))fail('An active upload exists for this task/product');if(entry.kind==='job'&&value.status==='prepared'&&value.next?.id===TASK)fail('An unfinished task file transaction exists')}
 const transfers=[];
 for(const expected of files){
  const uploadFile=upload.files.find(file=>file.id===expected.id),assetFile=asset.files.find(file=>file.id===expected.id),relative=path.normalize(expected.relative);
  if(!uploadFile||!assetFile||uploadFile.kind!==expected.kind||assetFile.kind!==expected.kind||path.normalize(uploadFile.relative)!==relative||path.normalize(assetFile.relative)!==relative||uploadFile.size!==expected.size||assetFile.size!==expected.size||uploadFile.sha256!==expected.sha256||assetFile.sha256!==expected.sha256)fail('Manifest differs from the reviewed file: '+expected.id);
  const source=await guarded(config.assetRoot,path.relative(config.assetRoot,path.join(oldRoot,expected.kind==='source'?'01.源文件':'02.导出图片',relative))),destination=await guarded(config.assetRoot,path.relative(config.assetRoot,path.join(expected.kind==='source'?category.source:category.output,relative)));
  if(!same(source,assetFile.path)||!same(source,upload.published[expected.id]))fail('Manifest paths disagree');
  if(await exists(destination))fail('Target already exists; no overwrite or merge: '+destination);
  await verifyFile(source,expected);transfers.push({...expected,source,destination});
 }
 const existing=await listFiles(oldRoot);if(existing.length!==2||existing.some(file=>!transfers.some(transfer=>same(file,transfer.source))))fail('Old UUID directory contains untracked files; nothing moved');
 for(const entry of before.records){if(!['task','asset','upload'].includes(entry.kind)||entry.id===TASK||entry.id===UPLOAD)continue;const value=JSON.parse(entry.body);const references=entry.kind==='task'?[...(value.deliveries||[]).map(delivery=>delivery.path),...[...(value.items||[]),...(value.retainedArchiveItems||[])].flatMap(item=>[item.assetPath,item.productPath])]:entry.kind==='asset'?[value.path,...(value.files||[]).map(file=>file.path)]:[value.category?.path,...Object.values(value.published||{})];if(references.some(location=>typeof location==='string'&&isInside(oldRoot,location)))fail('Another live record references the old UUID directory')}
 const workbook=await guarded(config.taskRoot,'5.已完结',task.filename);if(await hasWorkbookLock(workbook,config.taskRoot,{recover:false}))fail('Excel is open; save and close the original workbook');
 const original=await fsp.readFile(workbook);if(sha(original)!==task.workbookHash)fail('Original workbook changed since its saved record; synchronize and review first');
 const wb=unpack(original),address=String(mergedValue(wb.status,'L4')??''),escaped=oldRoot.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp(escaped+'(?=$|[\\\\/\\r\\n;；])','gi'),newAddress=address.replace(pattern,categoryRoot),writeWorkbook=newAddress!==address;
 const patched=writeWorkbook?patchWorkbook(original,{L4:newAddress}):null;
 const nextTask=structuredClone(task),nextAsset=structuredClone(asset),nextUpload=structuredClone(upload);nextTask.deliveries[0].path=categoryRoot;nextAsset.path=categoryRoot;nextUpload.category=category;nextUpload.storageLayout=3;
 for(const transfer of transfers){nextAsset.files.find(file=>file.id===transfer.id).path=transfer.destination;nextUpload.published[transfer.id]=transfer.destination}
 if(patched)nextTask.workbookHash=sha(patched);
 const updates=[{kind:'task',id:TASK,body:JSON.stringify(nextTask)},{kind:'asset',id:UPLOAD,body:JSON.stringify(nextAsset)},{kind:'upload',id:UPLOAD,body:JSON.stringify(nextUpload)}];
 const leaseFile=await guarded(config.taskRoot,'_workbench-system','service.json');let lease=null;try{lease=JSON.parse(await fsp.readFile(leaseFile,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
 return {before,config,task,asset,upload,updates,original,patched,leaseFile,plan:{taskId:TASK,assetId:UPLOAD,storageLayout:{from:2,to:3},oldRoot,categoryRoot,productRoot,transfers,workbook:{path:workbook,sha256:sha(original),changesL4:writeWorkbook,beforeL4:address,afterL4:newAddress,afterSHA256:patched?sha(patched):sha(original)},applyBlockers:lease&&!safelyStale(lease)?['Office service lease exists: '+JSON.stringify(lease)]:[],staleLeaseBackupRequired:safelyStale(lease),preserved:['internal IDs','task version/state/points/timing','all events/task_versions/job/request/audit records'],recoveryBase:path.join(config.assetRoot,'_workbench-recovery','archive-path-repair')}};
}
async function writeReceipt(file,value){const temp=file+'.tmp';await fsp.writeFile(temp,JSON.stringify(value,null,2),{flag:'w'});await fsp.rename(temp,file)}
async function runRepair(options,{fixtureRoot=null,files=FILES}={}){
 options={...options,dbPath:path.resolve(options.dbPath||DEFAULT_DB)};
 const now=Date.now(),stamp=new Date(now).toISOString().replace(/[:.]/g,'-')+'-'+crypto.randomBytes(3).toString('hex'),output=path.resolve(options.outputDir||path.join(OUTPUTS,'archive-path-repair-2026-11-04'));
 if(fixtureRoot){if(!isInside(fixtureRoot,output))fail('Fixture output must stay inside its temporary root')}
 else if(!isInside(OUTPUTS,output))fail('Repair receipts/backups must stay under workspace outputs');
 await guarded(fixtureRoot||OUTPUTS,path.relative(fixtureRoot||OUTPUTS,output));await fsp.mkdir(output,{recursive:true});
 const receiptPath=path.join(output,'repair-'+(options.apply?'apply':'dry-run')+'-'+stamp+'.json'),db=new DatabaseSync(options.dbPath,{readOnly:!options.apply});
 let context,receipt,leaseId=null,inTransaction=false,committed=false,workbookPublished=false,workbookMoved=false,heartbeat,leaseError,adjacentBackup,heartbeatPending=Promise.resolve();
 try{
  db.exec('PRAGMA busy_timeout=5000');if(!options.apply)db.exec('PRAGMA query_only=ON');context=await makePlan(db,options,{fixtureRoot,files});
  const {before,config,plan}=context;receipt={schemaVersion:1,mode:options.apply?'apply':'dry-run',status:'planned',at:now,dbPath:options.dbPath,before:receiptState(before),plan,productionWritten:false,createdFiles:[]};
  await writeReceipt(receiptPath,receipt);
  if(!options.apply){if(readState(db).hash!==before.hash)fail('Database changed during read-only preview');return {mode:'dry-run',receiptPath,...plan}}
  if(!fixtureRoot)assertManagerClosed(options,before);
  if(await exists(context.leaseFile)){
   const bytes=await fsp.readFile(context.leaseFile),previous=JSON.parse(bytes.toString('utf8'));
   if(!safelyStale(previous))fail('Office service lock is live, remote, or unrecognized; do not take it over');
   receipt.staleLeaseBackup=path.join(output,'stale-service-'+stamp+'.json');await fsp.writeFile(receipt.staleLeaseBackup,bytes,{flag:'wx'});
   if(!(await fsp.readFile(context.leaseFile)).equals(bytes)||!safelyStale(previous))fail('Stale lease changed during verification');
   const preserved=await guarded(config.taskRoot,path.relative(config.taskRoot,context.leaseFile+'.archive-path-repair-'+stamp+'.stale'));
   await fsp.rename(context.leaseFile,preserved);receipt.staleLeasePreserved=preserved;
   const moved=await fsp.readFile(preserved);if(!moved.equals(bytes)){if(!await exists(context.leaseFile))await fsp.copyFile(preserved,context.leaseFile,fs.constants.COPYFILE_EXCL);fail('Lease changed during the atomic move; preserved original ownership for review')}
   await writeReceipt(receiptPath,receipt);
  }
  leaseId=crypto.randomUUID();const leaseRecord=()=>({id:leaseId,host:os.hostname(),pid:process.pid,at:Date.now(),maintenance:'single-task-archive-path-repair'});
  await fsp.writeFile(context.leaseFile,JSON.stringify(leaseRecord()),{flag:'wx'});
  const checkLease=async()=>{if(leaseError)throw leaseError;const current=JSON.parse(await fsp.readFile(context.leaseFile,'utf8'));if(current.id!==leaseId)fail('Maintenance lock changed; stop and inspect before retrying')};
  heartbeat=setInterval(()=>{heartbeatPending=heartbeatPending.then(async()=>{await checkLease();const temp=await guarded(config.taskRoot,path.relative(config.taskRoot,context.leaseFile+'.'+leaseId+'.tmp'));await fsp.writeFile(temp,JSON.stringify(leaseRecord()),{flag:'wx'});await checkLease();await fsp.rename(temp,context.leaseFile)}).catch(error=>{leaseError=error})},10000);heartbeat.unref();
  receipt.backupPath=path.join(output,'before-'+stamp+'.sqlite');await backup(db,receipt.backupPath);
  const backupDB=new DatabaseSync(receipt.backupPath,{readOnly:true});try{if(readState(backupDB).hash!==before.hash)fail('SQLite backup differs from the verified source')}finally{backupDB.close()}
  receipt.backupSHA256=await fileHash(receipt.backupPath);receipt.originalRecords=before.records.filter(row=>context.updates.some(update=>update.kind===row.kind&&update.id===row.id));receipt.intendedRecords=context.updates;
  if(context.patched){receipt.workbookBackup=path.join(output,'before-'+stamp+'.xlsx');await fsp.writeFile(receipt.workbookBackup,context.original,{flag:'wx'});receipt.workbookAfter=path.join(output,'after-'+stamp+'.xlsx');await fsp.writeFile(receipt.workbookAfter,context.patched,{flag:'wx'})}
  receipt.status='backed-up';await writeReceipt(receiptPath,receipt);
  for(const transfer of plan.transfers){await checkLease();await verifyFile(transfer.source,transfer);await guarded(config.assetRoot,path.relative(config.assetRoot,transfer.destination));await fsp.mkdir(path.dirname(transfer.destination),{recursive:true});await fsp.copyFile(transfer.source,transfer.destination,fs.constants.COPYFILE_EXCL);receipt.createdFiles.push(transfer.destination);receipt.filesystemWritten=true;receipt.productionWritten=true;await verifyFile(transfer.destination,transfer);await writeReceipt(receiptPath,receipt)}
  db.exec('BEGIN IMMEDIATE');inTransaction=true;if(snapshot(db).hash!==before.hash)fail('Database changed after the preview');await checkLease();
  if(await hasWorkbookLock(plan.workbook.path,config.taskRoot,{recover:false})||await fileHash(plan.workbook.path)!==plan.workbook.sha256)fail('Excel or the original workbook changed during repair');
  if(context.patched){
   adjacentBackup=path.join(path.dirname(plan.workbook.path),'.workbench-archive-path-repair-'+stamp+'.bak');await guarded(config.taskRoot,path.relative(config.taskRoot,adjacentBackup));await fsp.rename(plan.workbook.path,adjacentBackup);workbookMoved=true;receipt.adjacentWorkbookBackup=adjacentBackup;await writeReceipt(receiptPath,receipt);
   if(await fileHash(adjacentBackup)!==plan.workbook.sha256)fail('Workbook changed during the backup move; keep the preserved file for review');
   await fsp.copyFile(receipt.workbookAfter,plan.workbook.path,fs.constants.COPYFILE_EXCL);workbookPublished=true;if(await fileHash(plan.workbook.path)!==plan.workbook.afterSHA256)fail('Updated workbook failed verification');
  }
  const update=db.prepare('UPDATE records SET body=? WHERE kind=? AND id=? AND body=?');
  for(const entry of context.updates){const original=before.records.find(row=>row.kind===entry.kind&&row.id===entry.id);if(update.run(entry.body,entry.kind,entry.id,original.body).changes!==1)fail('An intended record changed unexpectedly')}
  const after=snapshot(db),changed=changedRows(before,after);
  if(changed.length!==3||changed.some(entry=>!context.updates.some(update=>update.kind===entry.kind&&update.id===entry.id&&update.body===entry.body))||JSON.stringify(before.events)!==JSON.stringify(after.events)||JSON.stringify(before.versions)!==JSON.stringify(after.versions))fail('Repair changed data outside the three intended path records');
  for(const transfer of plan.transfers)await verifyFile(transfer.destination,transfer);await checkLease();db.exec('COMMIT');inTransaction=false;committed=true;receipt.productionWritten=true;receipt.databaseWritten=true;receipt.after=receiptState(after);receipt.status='references-committed';await writeReceipt(receiptPath,receipt);if(readState(db).hash!==after.hash)fail('Database changed after committing the new references; preserve the old directory for review');
  // The old directory is preserved only after all new files and live references
  // have been verified. It is never recursively deleted.
  for(const transfer of plan.transfers)await verifyFile(transfer.source,transfer);
  const entries=await listFiles(plan.oldRoot);if(entries.length!==2||entries.some(file=>!plan.transfers.some(transfer=>same(file,transfer.source))))fail('Old directory gained files; references are repaired but directory was preserved in place');
  receipt.recoveryDirectory=await guarded(config.assetRoot,path.relative(config.assetRoot,path.join(plan.recoveryBase,stamp,'任务-'+TASK)));if(await exists(receipt.recoveryDirectory))fail('Recovery destination exists');await fsp.mkdir(path.dirname(receipt.recoveryDirectory),{recursive:true});receipt.status='moving-old-directory';await writeReceipt(receiptPath,receipt);await checkLease();await fsp.rename(plan.oldRoot,receipt.recoveryDirectory);
  for(const transfer of plan.transfers){await verifyFile(transfer.destination,transfer);await verifyFile(path.join(receipt.recoveryDirectory,path.relative(plan.oldRoot,transfer.source)),transfer)}
  receipt.status='applied';await writeReceipt(receiptPath,receipt);return {mode:'apply',status:'applied',receiptPath,backupPath:receipt.backupPath,recoveryDirectory:receipt.recoveryDirectory,files:plan.transfers.length,bytes:plan.transfers.reduce((sum,file)=>sum+file.size,0)};
 }catch(error){
  if(inTransaction){db.exec('ROLLBACK');inTransaction=false}
  if(context?.patched&&!committed&&workbookMoved){
   try{if(workbookPublished&&await fileHash(context.plan.workbook.path)===context.plan.workbook.afterSHA256){const failed=path.join(path.dirname(context.plan.workbook.path),'.workbench-archive-path-repair-'+stamp+'.failed-after');await fsp.rename(context.plan.workbook.path,failed)}if(!await exists(context.plan.workbook.path)&&await fileHash(adjacentBackup)===context.plan.workbook.sha256)await fsp.copyFile(adjacentBackup,context.plan.workbook.path,fs.constants.COPYFILE_EXCL)}catch(restoreError){error.message+='; workbook recovery needs review: '+restoreError.message}
  }
  if(receipt){receipt.status=committed?'references-committed-recovery-incomplete':'failed';receipt.error=error.message;try{await writeReceipt(receiptPath,receipt)}catch{}}
  if(committed)error.message='New references were committed; do not blindly rerun. See '+receiptPath+'. '+error.message;throw error;
 }finally{
  clearInterval(heartbeat);await heartbeatPending.catch(()=>{});if(leaseId&&context)try{const current=JSON.parse(await fsp.readFile(context.leaseFile,'utf8'));if(current.id===leaseId)await fsp.unlink(context.leaseFile)}catch{}db.close();
 }
}
if(require.main===module)runRepair(args(process.argv.slice(2))).then(result=>console.log(JSON.stringify(result,null,2))).catch(error=>{console.error(error.message);process.exitCode=1});
module.exports={TASK,UPLOAD,FILES,args,makePlan,runRepair};
