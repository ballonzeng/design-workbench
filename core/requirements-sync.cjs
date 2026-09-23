'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const R=require('./rules.cjs'),{parseRequirement,workflowFields,workbookTaskId}=require('./workbook.cjs');
const {digest}=require('./store.cjs'),{guarded,exists}=require('./nas.cjs');
// Delivery category is chosen later from the designer's finished folder name.
const identity=t=>JSON.stringify([t.requestedAt,t.code,t.product]);
const itemIdentity=item=>[item.row,item.type,item.qty,item.extra||0,item.brand,item.workbookBrand,item.product,item.code,item.linkId||'',item.note||'',item.category||null];
const itemsIdentity=items=>JSON.stringify(items.map(itemIdentity));
const fileKey=name=>name.toLowerCase().replace(/-[^-]+\.xlsx$/,'');
function baselineFor(task){
 if(task.workflowFields)return task.workflowFields;
 const pair=time=>time?R.dayValues(time).map(String):['',''];
 const [E4,F4]=pair(task.assignedAt),[H4,I4]=pair(task.startedAt),[J4,K4]=pair(task.reviewAt),[M4,N4]=pair(task.completedAt);
 return {E4,F4,G4:R.PEOPLE.find(p=>p.id===task.owner)?.name||'',H4,I4,J4,K4,M4,N4};
}
function reconcileTask(old,parsed,fields,location,now=Date.now()){
 if(parsed.workbookTaskId&&parsed.workbookTaskId!==old.id)R.fail('需求表内部编号与当前任务不同，请负责人核对，未替换原任务');
 const dateCorrection=parsed.workbookTaskId===old.id&&old.code===parsed.code&&old.product===parsed.product&&!old.sealed&&!old.items.some(i=>i.sealed)&&!(old.deliveries||[]).length;
 if(identity(old)!==identity(parsed)&&!dateCorrection)R.fail('需求的产品、69码或需求时间已变化，请负责人核对；未自动替换已导入任务');
 const itemsChanged=itemsIdentity(old.items)!==itemsIdentity(parsed.items);
 if(itemsChanged&&(old.sealed||old.items.some(item=>item.sealed)))R.fail('此需求已有封存资产，不能再修改事项；请先核对或撤销对应封存');
 const baseline=baselineFor(old),changed=keys=>keys.some(k=>fields[k]!==baseline[k]);
 const folderChanged=location.state!==old.state;
 const times=parsed.templateTimes;
 let state=location.state;
 if(!folderChanged){
  if(changed(['H4','I4','J4','K4','M4','N4'])){
   const time=keys=>keys.every(k=>fields[k]!==''),partial=keys=>keys.some(k=>fields[k]!=='')&&!time(keys);
   // Templates often prefill a date with no hour; only a newly edited incomplete pair blocks sync.
   for(const [keys,name] of [[['H4','I4'],'设计开始'],[['J4','K4'],'设计完成'],[['M4','N4'],'确认']]){
    if(changed(keys)&&(partial(keys)||time(keys)&&!times[{H4:'startedAt',J4:'reviewAt',M4:'completedAt'}[keys[0]]]))R.fail(name+'日期和时间请成对填写（'+keys.join(' / ')+'），保存并关闭后会自动同步');
   }
   state=times.completedAt?4:times.reviewAt?3:times.startedAt?2:parsed.requestedDesigner==='未分配'?0:1;
  }else if(changed(['G4']))state=parsed.requestedDesigner==='未分配'?0:1;
 }
 const owner=state===0?null:R.PEOPLE.find(p=>p.name===parsed.requestedDesigner)?.id;
 if(state>0&&!owner)R.fail('当前阶段需要填写分配设计 G4，并将文件名最后一段改为同一设计师');
 if(state===0&&parsed.requestedDesigner!=='未分配')R.fail('待分配需求请清空分配设计 G4，并将文件名最后一段改为“未分配”');
 if((old.sealed||old.items.some(i=>i.sealed))&&(state!==old.state||owner!==old.owner||changed(['M4','N4'])))R.fail('此需求已有封存资产，不能通过修改 Excel 回退状态、改派或更改确认时间');
 if(state===4&&!times.completedAt&&!(old.completionFromFolder&&location.state===4&&!fields.M4&&!fields.N4))R.fail('已完结需求必须填写确认日期 M4 和确认时间 N4');
 const next=structuredClone(old),moved=state!==old.state,assigned=owner!==old.owner;
 if(dateCorrection)next.requestedAt=parsed.requestedAt;
 next.filename=location.filename;next.title=parsed.title;next.brand=parsed.brand;next.workbookBrand=parsed.workbookBrand;next.operator=parsed.operator;next.requestedDesigner=parsed.requestedDesigner;next.state=state;next.owner=owner;
 next.workbookTaskId=parsed.workbookTaskId||old.workbookTaskId||null;
 if(itemsChanged)next.items=parsed.items;
 next.workflowFields=fields;next.workbookHash=parsed.sourceHash;next.workbookSyncIssue=null;next.externalSyncedAt=now;
 if(moved||assigned){
  next.elapsedMs=R.elapsed(old,now);next.runningSince=null;next.pauseReason=null;
  next.startedAt=state>=2?(times.startedAt||old.startedAt||now):null;
  next.reviewAt=state>=3?(times.reviewAt||now):null;
  next.completedAt=state===4?(times.completedAt||old.completedAt):null;next.completedMonth=state===4?R.monthKey(next.completedAt):null;
  if(state===4)next.completionFromFolder=!times.completedAt;
  if(state===2){next.runningSince=now;next.externalTiming=true}
  if(state===4){next.confirmedBy='nas';next.confirmationMethod='NAS 原需求表记录确认'}
 }
 if(assigned||state>0&&!next.assignmentId){next.assignmentId=owner?crypto.randomUUID():null;next.assignedAt=owner?(times.assignedAt||now):null;next.receivedAt=null;next.readAt=null}
 if(owner&&times.assignedAt&&changed(['E4','F4']))next.assignedAt=times.assignedAt;
 if(state>=2&&times.startedAt&&changed(['H4','I4']))next.startedAt=times.startedAt;
 if(state>=3&&times.reviewAt&&changed(['J4','K4']))next.reviewAt=times.reviewAt;
 if(state===4&&times.completedAt){next.completedAt=times.completedAt;next.completedMonth=R.monthKey(times.completedAt);next.completionTimeSource='workbook-confirmed'}
 next.updatedAt=now;next.version++;
 return next;
}
class RequirementsSync{
 constructor(service){this.service=service;this.store=service.store;this.nas=service.nas;this.seen=new Map();this.running=null;this.stopped=false;this.status={lastCheckedAt:null,lastAttemptAt:null,scanned:0,state:'idle',error:null}}
 start(interval=5000){this.timer=setInterval(()=>this.check().catch(()=>{}),interval);this.timer.unref();this.check().catch(()=>{})}
 async stop(){this.stopped=true;clearInterval(this.timer);await this.running?.catch(()=>{})}
 check(force=false,{includeCompleted=false}={}){
  if(this.stopped)return Promise.resolve({changed:0,checked:false,state:'stopped',error:'同步服务已停止，尚未检查 NAS'});
  if(this.running)return force?this.running.then(()=>this.check(force,{includeCompleted})):this.running;
  this.running=this.run(force,includeCompleted).finally(()=>{this.running=null});return this.running;
 }
 checkTask(taskId,{acceptCodeCorrection=false}={}){
  // A task action neither waits for nor starts a full-library refresh.
  // A separate worker keeps the global sync status and cache unchanged.
  return new RequirementsSync(this.service).run(true,true,taskId,acceptCodeCorrection);
 }
 issue(task,message,location){
  const current=this.store.get('task',task.id);if(!current||current.version!==task.version)return false;
  if(current.workbookSyncIssue?.message===message&&current.workbookSyncIssue?.stage===location?.stage)return false;
  current.workbookSyncIssue={message,stage:location?.stage||R.STAGES[task.state],filename:location?.filename||task.filename,at:Date.now()};this.store.put('task',task.id,current);return true;
 }
 async run(force,includeCompleted=false,targetId=null,acceptCodeCorrection=false){
  let codeCorrection=null;
  let changed=0,discovery={imported:0,relinked:0,repaired:0,issues:[]},assetSync={changed:0,reopened:0,partial:0};const previousError=this.status.error;
  this.status={...this.status,state:'checking',lastAttemptAt:Date.now()};
  try{
   if(targetId)await this.nas.ready();
   else if(this.service.ensureNasConnection)await this.service.ensureNasConnection(force);
   else if(!this.nas.config||!this.nas.lease)throw Error('NAS 未连接，尚未执行检查');
   if(!targetId)discovery=await this.store.exclusive(()=>this.service.scanExisting({includeCompleted}));
   const target=targetId&&this.store.get('task',targetId);if(targetId&&!target)R.fail('任务不存在',404);
   const locations=[];
   for(let state=0;state<R.STAGES.length;state++){
    const dir=await guarded(this.nas.config.taskRoot,R.STAGES[state]);
    for(const entry of await fs.readdir(dir,{withFileTypes:true}))if(entry.isFile()&&/\.xlsx$/i.test(entry.name)&&!entry.name.startsWith('~$')&&!entry.name.startsWith('.')&&(!target||fileKey(entry.name)===fileKey(target.filename)))locations.push({state,stage:R.STAGES[state],filename:entry.name});
   }
   for(const task of target?[target]:this.store.all('task')){
    if(this.stopped)break;
    if(!includeCompleted&&task.state===4)continue;
    if(task.blocked||this.store.all('job').some(j=>j.status==='prepared'&&j.next?.id===task.id))continue;
    const matches=locations.filter(l=>fileKey(l.filename)===fileKey(task.filename));
    if(matches.length!==1){changed+=Number(this.issue(task,matches.length?'多个状态文件夹存在同一份需求，请保留唯一原表后同步':'五个状态文件夹内未找到原需求表，请检查是否被移动或改名'));continue}
    const location=matches[0];
    try{
     const file=await guarded(this.nas.config.taskRoot,location.stage,location.filename),stat=await fs.stat(file);
     const signature=location.stage+'/'+location.filename+':'+stat.size+':'+stat.mtimeMs;
     if(!force&&this.seen.get(task.id)?.signature===signature&&this.seen.get(task.id)?.hash===task.workbookHash&&!task.workbookSyncIssue)continue;
     if(await exists(path.join(path.dirname(file),'~$'+path.basename(file)))){
      changed+=Number(this.issue(task,'Excel 正在编辑原表；请保存并关闭，随后自动同步流转',location));continue;
     }
     if(stat.size>50*1024*1024)R.fail('需求表超过 50 MB，暂未同步');
     const bytes=await fs.readFile(file),after=await fs.stat(file);if(stat.size!==after.size||stat.mtimeMs!==after.mtimeMs)continue;
     const hash=digest(bytes);
     await this.store.exclusive(async()=>{
      const current=this.store.get('task',task.id);if(!current||current.version!==task.version||current.workbookHash!==task.workbookHash)return;
      if(current.blocked||this.store.all('job').some(j=>j.status==='prepared'&&j.next?.id===task.id))return;
      const fields=workflowFields(bytes);
      const internalId=workbookTaskId(bytes);
      if(internalId&&internalId!==task.id)R.fail('需求表内部编号属于另一任务，未同步');
      if(hash===task.workbookHash&&location.state===task.state&&location.filename===task.filename){
       if(!current.workflowFields||current.workbookSyncIssue){current.workflowFields=fields;current.workbookSyncIssue=null;this.store.put('task',task.id,current);changed++}
      }else{
       const categories=Object.fromEntries(task.items.map(i=>[i.row,i.category])),extras=Object.fromEntries(task.items.map(i=>[i.row,i.extra||0]));
       const parsed=parseRequirement(bytes,location.filename,{categories,extras});
       if(targetId&&acceptCodeCorrection&&parsed.code!==current.code){
        if(current.sealed||parsed.workbookTaskId!==current.id)R.fail('更正69码需要同一任务的原需求表，并先回退到待封存');
        if(location.state!==current.state||location.filename!==current.filename||['requestedAt','product','brand','workbookBrand','operator','requestedDesigner','title'].some(k=>parsed[k]!==current[k])||Object.keys(fields).some(k=>fields[k]!==current.workflowFields?.[k])||itemsIdentity(current.items.map(i=>({...i,code:parsed.code})))!==itemsIdentity(parsed.items.map(i=>({...i,category:current.items.find(old=>old.row===i.row)?.category}))))R.fail('本次仅支持更正69码后回退；产品、事项、时间或文件位置也有变化，请分别核对');
        if(current.state!==4&&((current.deliveries||[]).length||current.items.some(i=>i.sealed)))R.fail('当前任务仍有关联交付，请先核对封存状态');
        // Stage only: commit the corrected code together with the rollback journal.
        codeCorrection={version:current.version,previousHash:current.workbookHash,hash,from:current.code,to:parsed.code};
        return;
       }
       const next=reconcileTask(current,parsed,fields,location);
       const event={kind:'excel-synced',actor:'nas',body:{from:current.state,to:next.state,source:location.stage,filename:location.filename,owner:next.owner,itemsChanged:itemsIdentity(current.items)!==itemsIdentity(next.items),previousPoints:R.total(current),nextPoints:R.total(next)}};
       if(next.state!==location.state){
        // Use the saved external file as the journal's guarded source; do not overwrite external edits.
        await this.nas.sync({...current,state:location.state,filename:location.filename,workbookHash:hash},next,{},event);
       }else{
        const latest=await fs.stat(file);if(latest.size!==after.size||latest.mtimeMs!==after.mtimeMs||await exists(path.join(path.dirname(file),'~$'+path.basename(file))))return;
        this.store.atomic(()=>{this.store.put('task',task.id,next);this.store.event(event.kind,event.actor,task.id,event.body)});
       }
       changed++;
      }
      const identified=this.store.get('task',task.id);
      if(!internalId&&identified&&!identified.blocked){
       const next={...identified,workbookTaskId:task.id,version:identified.version+1};
       await this.nas.sync(identified,next,{}, {kind:'requirement-identified',actor:'system',body:{filename:location.filename}});changed++;
      }
      this.seen.set(task.id,{signature,hash});
     });
    }catch(e){changed+=Number(this.issue(task,e.reasons?.join('；')||e.message,location))}
   }
   this.status={...this.status,scanned:locations.length,error:null};
  }catch(e){this.status={...this.status,error:'NAS 原表同步暂未完成：'+e.message}}
  if(!targetId&&!this.status.error){
   try{assetSync=await this.service.assets.reconcileMissingAssets({includeCompleted})}
   catch(e){this.status={...this.status,error:'正式资产核对暂未完成：'+e.message}}
  }
  this.status={...this.status,state:this.status.error?'failed':'ready',...(this.status.error?{}:{lastCheckedAt:Date.now()})};
  if(changed||discovery.imported||discovery.relinked||discovery.repaired||assetSync.changed||this.status.error!==previousError||force)this.service.broadcast();
  else if(!targetId)this.service.emit?.('sync-status',this.status);
  return {checked:!this.status.error,codeCorrection,changed:changed+discovery.imported+discovery.relinked+discovery.repaired+assetSync.changed,workbooksChanged:changed,imported:discovery.imported,relinked:discovery.relinked,repaired:discovery.repaired,importIssues:discovery.issues.length,assetsChanged:assetSync.changed,assetsReopened:assetSync.reopened,partialAssets:assetSync.partial,...this.status};
 }
}
module.exports={RequirementsSync,reconcileTask,itemsIdentity};
