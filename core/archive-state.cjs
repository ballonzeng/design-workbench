'use strict';

// Archive identity excludes display metadata, receipts and the version counter.
// It changes when an approval, assignment, requirement or rework round changes.
function archiveIdentity(task){
 return JSON.stringify([task.archiveRound||0,task.owner,task.requestedAt,task.completedAt,task.brand,task.workbookBrand,task.product,task.code,
  (task.items||[]).map(i=>[i.id,i.row,i.type,i.qty,i.extra||0,i.category,i.brand,i.workbookBrand,i.product,i.code,i.linkId||'',i.note||''])]);
}
function currentUpload(task,upload){return !!task&&upload.taskId===task.id&&(upload.archiveRound||0)===(task.archiveRound||0)}
function hasCurrentAssets(task){return !!(task.sealed||task.deliveries?.length||[...(task.items||[]),...(task.retainedArchiveItems||[])].some(i=>i.sealed||i.assetId))}
function hasPublishingUpload(task,uploads){return uploads.some(u=>currentUpload(task,u)&&u.status==='publishing')}
function resetArchive(next,previous,now){
 next.deliveryHistory=[...(previous.deliveryHistory||[]),{at:now,completedAt:previous.completedAt,sealedAt:previous.sealedAt,deliveries:previous.deliveries||[],items:structuredClone([...(previous.items||[]),...(previous.retainedArchiveItems||[])])}];
 delete next.retainedArchiveItems;delete next.contributionCalibration;
 delete next.ratings;
 next.archiveRound=(previous.archiveRound||0)+1;next.deliveries=[];
 for(const item of next.items){item.sealed=false;for(const key of ['sealedAt','assetId','assetPath','productPath'])delete item[key]}
 next.sealed=false;delete next.sealedAt;delete next.sealedFromVersion;delete next.assetSyncIssue;
}
// Call in the same transaction as the task update, including journal recovery.
// Keep files and history; only idle batches whose approval expired are retired.
function cancelStaleUploads(store,task,now=Date.now()){
 for(const upload of store.all('upload')){
  if(upload.taskId!==task.id||upload.status!=='uploading')continue;
  if(task.state!==4||upload.actor!==task.owner||!currentUpload(task,upload)||upload.taskIdentity&&upload.taskIdentity!==archiveIdentity(task)){
   store.put('upload',upload.id,{...upload,status:'cancelled',cancelledAt:now,error:'任务已回退或确认内容已变化，请重新选择产物'});
  }
 }
}
module.exports={archiveIdentity,currentUpload,hasCurrentAssets,hasPublishingUpload,resetArchive,cancelStaleUploads};
