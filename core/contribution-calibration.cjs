'use strict';
const fs=require('node:fs/promises');
const R=require('./rules.cjs'),{parseRequirement,workflowFields}=require('./workbook.cjs');
const {guarded}=require('./nas.cjs'),{digest,calibrationKey}=require('./store.cjs');
const {currentUpload}=require('./archive-state.cjs');
const {hasWorkbookLock}=require('./workbook-lock.cjs');

// Called inside the service mutation queue. Excel is the input, never an output.
async function calibrateContribution(service,actor,payload){
 R.manager(actor);
 const {store,nas}=service,old=store.get('task',payload.taskId);
 if(!old)R.fail('任务不存在',404);
 if(old.state!==4)R.fail('仅已完结任务可以校准点数',409);
 if(payload.version!==old.version)R.fail('任务已更新，请刷新后重新校准',409);
 if(old.blocked||store.all('job').some(j=>j.status==='prepared'&&j.next?.id===old.id)||store.all('upload').some(u=>currentUpload(old,u)&&['uploading','publishing'].includes(u.status)))R.fail('任务存在待处理的文件同步或上传，请完成后再校准',409);
 await nas.ready();
 const key=name=>name.toLowerCase().replace(/-[^-]+\.xlsx$/,'');let copies=0;
 for(const stage of R.STAGES)for(const entry of await fs.readdir(await guarded(nas.config.taskRoot,stage),{withFileTypes:true}))if(entry.isFile()&&/\.xlsx$/i.test(entry.name)&&!entry.name.startsWith('~$')&&key(entry.name)===key(old.filename))copies++;
 if(copies!==1)R.fail('五个状态文件夹内必须保留唯一原需求表，请核对重复文件或文件位置',409);
 const file=await guarded(nas.config.taskRoot,R.STAGES[4],old.filename);
 if(await hasWorkbookLock(file,nas.config.taskRoot))R.fail('请保存并关闭 Excel 后再校准点数',409);
 const before=await fs.stat(file);if(before.size>50*1024*1024)R.fail('需求表超过 50 MB，暂未校准');
 const bytes=await fs.readFile(file),hash=digest(bytes);
 if(payload.expectedHash!==undefined&&payload.expectedHash!==hash)R.fail('需求表与预览时不同，请重新读取变更后再确认校准',409);
 const parsed=parseRequirement(bytes,old.filename,{categories:Object.fromEntries(old.items.map(i=>[i.row,i.category])),extras:Object.fromEntries(old.items.map(i=>[i.row,i.extra||0]))});
 if(parsed.workbookTaskId!==old.id)R.fail('校准需要带有当前任务内部编号的原需求表，请先刷新已完结任务',409);
 for(const key of ['requestedAt','code','product','brand','workbookBrand','operator','requestedDesigner','title'])if(parsed[key]!==old[key])R.fail('点数校准不能同时修改产品、69码、需求时间、运营、设计师或文件名',409);
 const fields=workflowFields(bytes);
 if(!old.workflowFields||Object.keys(fields).some(k=>fields[k]!==old.workflowFields[k]))R.fail('点数校准不能同时修改流转时间或设计师，请恢复后重试',409);
 const next=structuredClone(old),archiveKeys=['sealed','sealedAt','assetId','assetPath','productPath'];
 next.items=parsed.items.map(item=>{
  const previous=old.items.find(i=>i.row===item.row);
  return {...item,...Object.fromEntries(archiveKeys.filter(k=>previous?.[k]!==undefined).map(k=>[k,previous[k]]))};
 });
 // Removed contribution rows must not orphan older per-row archive records.
 next.ratings=parsed.ratings;
 next.retainedArchiveItems=[...(old.retainedArchiveItems||[]),...old.items.filter(i=>i.assetId&&!next.items.some(n=>n.id===i.id))];
 const at=Date.now(),previousPoints=R.total(old),nextPoints=R.total(next);
 const items=next.items.map(({sealed,sealedAt,assetId,assetPath,productPath,...item})=>item);
 next.contributionCalibration={at,actor:actor.personId,completedAt:old.completedAt,owner:old.owner,code:old.code,archiveRound:old.archiveRound||0,items,previousPoints,nextPoints};
 next.workbookHash=hash;next.workbookSyncIssue=null;next.updatedAt=at;next.version++;
 const after=await fs.stat(file);
 if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||await hasWorkbookLock(file,nas.config.taskRoot,{recover:false})||digest(await fs.readFile(file))!==hash)R.fail('需求表刚刚发生变化，请关闭 Excel 后重新校准',409);
 if(payload.preview===true){
  const summary=({row,type,typeName,qty,extra=0,note='',linkId='',category})=>({row,type,typeName,qty,extra,note,linkId,category,points:R.itemPoints({type,qty,extra})});
  const previousItems=old.items.map(summary),nextItems=next.items.map(summary),rows=[...new Set([...previousItems,...nextItems].map(i=>i.row))].sort((a,b)=>a-b);
  const changes=rows.map(row=>({row,before:previousItems.find(i=>i.row===row)||null,after:nextItems.find(i=>i.row===row)||null})).filter(change=>JSON.stringify(change.before)!==JSON.stringify(change.after));
  return {preview:true,taskId:old.id,version:old.version,workbookHash:hash,previousPoints,nextPoints,previousItems,nextItems,changes,completedMonth:old.completedMonth};
 }
 store.atomic(()=>{
  store.put('task',old.id,next);
  store.put('contributionCalibration',calibrationKey(old),next.contributionCalibration);
  store.event('contribution-calibrated',actor.personId,old.id,{previousPoints,nextPoints,completedAt:old.completedAt,previousItems:old.items,nextItems:items,workbookHash:hash});
 });
 return {taskId:old.id,previousPoints,nextPoints,completedMonth:old.completedMonth};
}
module.exports={calibrateContribution};
