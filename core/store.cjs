'use strict';
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const calibrationKey=task=>task.id+':'+task.completedAt+':'+task.owner+':round:'+(task.archiveRound||0);
class Store{
 constructor(dir){
  fs.mkdirSync(dir,{recursive:true});this.dir=dir;this.db=new DatabaseSync(path.join(dir,'workbench.sqlite'));
  this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(kind,id)); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,taskId TEXT,actor TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL);');
  this.queue=Promise.resolve();
  this.db.exec('CREATE TABLE IF NOT EXISTS task_versions(seq INTEGER PRIMARY KEY AUTOINCREMENT,taskId TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS task_versions_lookup ON task_versions(taskId,at,seq);');
  this.atomic(()=>{for(const row of this.db.prepare("SELECT id,body FROM records WHERE kind='task'").all())if(!this.db.prepare('SELECT 1 FROM task_versions WHERE taskId=? LIMIT 1').get(row.id))this.saveTaskVersion({...JSON.parse(row.body),id:row.id})});
 }
 get(kind,id){const r=this.db.prepare('SELECT body FROM records WHERE kind=? AND id=?').get(kind,id);return r?JSON.parse(r.body):null}
 all(kind){return this.db.prepare('SELECT body FROM records WHERE kind=?').all(kind).map(r=>JSON.parse(r.body))}
 removedMembers(){return this.db.prepare('SELECT id,body FROM records WHERE kind=?').all('removedMember').map(r=>({...JSON.parse(r.body),personId:r.id}))}
 historicalTasks(){
  const {isHistoricalTask}=require('./historical-tasks.cjs');
  return this.all('historicalTask').filter(isHistoricalTask).map(task=>{
   const archive=this.get('historicalArchive',task.id);
   if(archive?.status==='archived'&&archive.taskId===task.id&&archive.author===task.owner&&archive.category==='packaging'&&Number.isFinite(archive.at)&&path.isAbsolute(archive.path||'')&&path.isAbsolute(archive.productPath||'')&&archive.files?.length&&archive.files.every(f=>path.isAbsolute(f.path||'')&&/^[a-f0-9]{64}$/.test(f.sha256)&&Number.isSafeInteger(f.size)&&f.size>0))return {...task,historicalArchive:archive};
   return task;
  });
 }
 put(kind,id,body){
  if(kind==='task'&&!this.inAtomic)return this.atomic(()=>this.put(kind,id,body));
  this.db.prepare('INSERT INTO records(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run(kind,id,JSON.stringify(body));
  if(kind==='task')this.saveTaskVersion({...body,id});
 }
 saveTaskVersion(task){
  const fields=['id','state','sealed','requestedAt','createdAt','assignedAt','startedAt','reviewAt','completedAt','completedMonth','sealedAt','brand','product','code','title','operator','owner','items','elapsedMs','runningSince','filename','importedTiming','externalTiming','completionFromFolder','completionTimeSource','archiveRound','workIntervals','timingTracked','timingIncomplete','ratings'];
  const body=JSON.stringify(Object.fromEntries(fields.filter(k=>task[k]!==undefined).map(k=>[k,task[k]])));
  const previous=this.db.prepare('SELECT body FROM task_versions WHERE taskId=? ORDER BY seq DESC LIMIT 1').get(task.id);
  if(previous?.body!==body)this.db.prepare('INSERT INTO task_versions(taskId,at,body) VALUES(?,?,?)').run(task.id,Date.now(),body);
 }
 reportTasks(cutoff){
  const rows=this.db.prepare('SELECT v.body,v.at FROM task_versions v WHERE v.at<=? AND v.seq=(SELECT v2.seq FROM task_versions v2 WHERE v2.taskId=v.taskId AND v2.at<=? ORDER BY v2.at DESC,v2.seq DESC LIMIT 1)').all(cutoff,cutoff);
  const tasks=rows.map(r=>({...JSON.parse(r.body),reportSnapshotAt:r.at})).filter(t=>!t.deleted),known=new Set(tasks.map(t=>t.id));
  // Apply an explicit manager correction to the same completed round only.
  // Workflow, ownership and timing remain those recorded at the report cutoff.
  for(const task of tasks){
   const round=task.archiveRound||0;
   const correction=this.get('contributionCalibration',calibrationKey(task))||(round===0?this.get('contributionCalibration',task.id+':'+task.completedAt+':'+task.owner):null);
   if(correction&&task.state===4&&task.completedAt===correction.completedAt&&task.owner===correction.owner&&task.code===correction.code&&round===(correction.archiveRound||0)){task.items=structuredClone(correction.items);task.reportCalibrationAt=correction.at}
  }
  // Explicit, date-only supplements are new evidence about an earlier completion.
  // Their audit timestamp remains today; do not forge historical task versions.
  const {isHistoricalTask}=require('./historical-tasks.cjs');
  for(const task of this.historicalTasks())if(isHistoricalTask(task)&&task.completedAt<=cutoff&&!known.has(task.id)){tasks.push({...task,reportHistoricalBackfill:true,reportSupplementedAt:task.createdAt});known.add(task.id)}
  const unavailable=this.all('task').filter(t=>!known.has(t.id)&&Math.min(t.createdAt||Infinity,t.requestedAt||Infinity)<=cutoff).map(t=>({id:t.id,filename:t.filename,reason:'该周期早于可追溯版本记录，无法还原当时人员、事项和状态'}));
  return {tasks,unavailable};
 }
 reportEvents(start,end){return this.db.prepare('SELECT * FROM events WHERE at>=? AND at<? ORDER BY seq').all(start,end).map(r=>({...r,body:JSON.parse(r.body)}))}
 remove(kind,id){if(kind==='task'&&!this.inAtomic)return this.atomic(()=>this.remove(kind,id));this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind,id);if(kind==='task')this.db.prepare('INSERT INTO task_versions(taskId,at,body) VALUES(?,?,?)').run(id,Date.now(),JSON.stringify({id,deleted:true}))}
 event(kind,actor,taskId,body={}){return this.db.prepare('INSERT INTO events(at,taskId,actor,kind,body) VALUES(?,?,?,?,?)').run(Date.now(),taskId||null,actor,kind,JSON.stringify(body))}
 events(taskId,limit=200){return this.db.prepare('SELECT * FROM events WHERE taskId=? ORDER BY seq DESC LIMIT ?').all(taskId,limit).map(r=>({...r,body:JSON.parse(r.body)}))}
 recent(limit=100){return this.db.prepare('SELECT seq,at,taskId,actor,kind,body FROM events ORDER BY seq DESC LIMIT ?').all(limit).map(r=>({...r,body:JSON.parse(r.body)}))}
 atomic(fn){if(this.inAtomic)return fn();this.db.exec('BEGIN IMMEDIATE');this.inAtomic=true;try{const result=fn();this.db.exec('COMMIT');return result}catch(e){this.db.exec('ROLLBACK');throw e}finally{this.inAtomic=false}}
 exclusive(fn){const p=this.queue.then(fn,fn);this.queue=p.catch(()=>{});return p}
 close(){this.db.close()}
}
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
module.exports={Store,digest,calibrationKey};
