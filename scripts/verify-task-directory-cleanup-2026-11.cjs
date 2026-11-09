'use strict';
// Independent read-only database/document verification after the reviewed apply.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {snapshot}=require('./backfill-packaging-2026-11.cjs');
const {unpack,mergedValue}=require('../core/workbook.cjs');
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),fail=m=>{throw Error(m)};
async function exists(p){try{await fsp.lstat(p);return true}catch(e){if(e.code==='ENOENT')return false;throw e}}
async function main(){const receiptPath=path.resolve(process.argv[2]),r=JSON.parse(await fsp.readFile(receiptPath));if(r.status!=='completed'||r.mode!=='apply'||r.groups.some(g=>g.status!=='applied'))fail('Migration is not fully applied');
 const planBytes=await fsp.readFile(r.planBackup),plan=JSON.parse(planBytes);if(sha(planBytes)!==r.planHash)fail('Plan hash differs');
 const db=new DatabaseSync(plan.database,{readOnly:true}),backup=new DatabaseSync(r.backup,{readOnly:true});
 try{const before=snapshot(backup),after=snapshot(db),jobs=plan.planners.flatMap(x=>x.jobs),intended=new Map(jobs.flatMap(j=>j.records).map(x=>[x.kind+'\0'+x.id,x.nextBody])),originals=new Map(before.records.map(x=>[x.kind+'\0'+x.id,x.body]));
  if(after.records.length!==before.records.length||JSON.stringify(before.events)!==JSON.stringify(after.events)||JSON.stringify(before.versions)!==JSON.stringify(after.versions))fail('Record/history counts or values changed');
  for(const x of after.records){const key=x.kind+'\0'+x.id;if(x.body!==(intended.get(key)||originals.get(key)))fail('Unexpected record change '+key)}
  const roots=jobs.flatMap(j=>j.roots),liveKinds=['task','asset','upload','historicalArchive'];
  for(const x of after.records.filter(x=>liveKinds.includes(x.kind)))for(const root of roots)if(x.body.toLowerCase().includes(JSON.stringify(root.source).slice(1,-1).toLowerCase()))fail('Stale live path '+x.kind+'/'+x.id);
  for(const root of roots)if(await exists(root.source))fail('Old UUID root still exists '+root.source);
  let missing=0;for(const m of jobs.flatMap(j=>j.missing)){if(await exists(m.oldPath)||await exists(m.target))fail('A missing file was unexpectedly substituted');missing++}
  const docs=[];for(const g of r.groups)for(const d of g.documents){const bytes=await fsp.readFile(d.path),l4=String(mergedValue(unpack(bytes).status,'L4')??'');if(sha(bytes)!==d.afterHash||/任务-[a-f0-9-]{36}/i.test(l4))fail('Workbook hash/address differs');docs.push({path:d.path,sha256:sha(bytes),L4:l4})}
  let sidecars=0;for(const s of jobs.flatMap(j=>j.sidecars)){const bytes=await fsp.readFile(s.path);if(!bytes.equals(Buffer.from(s.nextBytesBase64,'base64')))fail('Sidecar bytes differ');const v=JSON.parse(bytes);for(const root of roots)if(JSON.stringify(v).includes(JSON.stringify(root.source).slice(1,-1)))fail('Old path in migrated sidecar');sidecars++}
  const backupHash=sha(await fsp.readFile(r.backup));if(backupHash!==r.backupSHA256)fail('Backup hash differs');
  if(await exists(path.join(plan.taskRoot,'_workbench-system','service.json')))fail('Maintenance lease remains');
  const result={status:'verified',receiptPath,recordsChecked:after.records.length,intendedRecordChanges:intended.size,taskCount:after.records.filter(x=>x.kind==='task').length,historicalTaskCount:after.records.filter(x=>x.kind==='historicalTask').length,eventsUnchanged:true,taskVersionsUnchanged:true,oldRootsAbsent:roots.length,declaredMissingStillAbsent:missing,sidecarsChecked:sidecars,workbooks:docs,backupSHA256:backupHash,dbIntegrity:db.prepare('PRAGMA integrity_check').get(),leaseReleased:true};
  await fsp.writeFile(path.join(path.dirname(receiptPath),'post-verification.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{db.close();backup.close()}}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
