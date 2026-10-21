'use strict';
const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');const os=require('node:os');const crypto=require('node:crypto');
const {fail,STAGES,safeName,CATEGORIES,parts}=require('./rules.cjs');
const {digest}=require('./store.cjs');const {patchWorkbook,workflowFields,identifyWorkbook}=require('./workbook.cjs');
const {cancelStaleUploads}=require('./archive-state.cjs');
const {hasWorkbookLock}=require('./workbook-lock.cjs');
async function exists(file){try{await fsp.lstat(file);return true}catch(e){if(e.code==='ENOENT')return false;throw e}}
const REMOTE_LEASE_STALE_MS=120000,LOCAL_LEASE_STALE_MS=15000;
function processAlive(pid){
 if(!Number.isSafeInteger(pid)||pid<=0)return null;
 try{process.kill(pid,0);return true}catch(e){return e.code==='EPERM'}
}
function leaseOwnerOnline(lease,host,now=Date.now()){
 if(!lease||typeof lease!=='object')return false;
 if(lease.host!==host)return now-Number(lease.at)<REMOTE_LEASE_STALE_MS;
 const alive=processAlive(Number(lease.pid));
 if(alive!==null)return alive;
 return now-Number(lease.at)<LOCAL_LEASE_STALE_MS;
}
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
async function fileHash(file){const hash=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);return hash.digest('hex')}
function isInside(root,file){const rel=path.relative(path.resolve(root),path.resolve(file));return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel))}
async function guarded(root,...parts){
 const target=path.resolve(root,...parts);if(!isInside(root,target))fail('文件路径超出已连接目录',403);
 let walk=path.resolve(root);
 for(const part of [null,...path.relative(root,target).split(path.sep).filter(Boolean)]){
  if(part)walk=path.join(walk,part);
  try{const s=await fsp.lstat(walk);if(s.isSymbolicLink())fail('不允许通过链接目录写入 NAS',403)}catch(e){if(e.code==='ENOENT')break;throw e}
 }
 return target;
}
async function ensureDir(root,...parts){const p=await guarded(root,...parts);await fsp.mkdir(p,{recursive:true});return p}
function folderName(value){
 const result=String(value??'').replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().replace(/\\/g,'＼').replace(/\//g,'／').replace(/:/g,'：').replace(/\*/g,'×').replace(/\?/g,'？').replace(/"/g,'”').replace(/</g,'＜').replace(/>/g,'＞').replace(/\|/g,'｜').replace(/[. ]+$/,'');
 return safeName(result,'产品名');
}
class Nas{
 constructor(store){this.store=store;this.config=null;this.lease=null;this.timer=null;this.error=null}
 async connect(config){
  for(const key of ['taskRoot','assetRoot'])if(typeof config[key]!=='string'||!path.isAbsolute(config[key]))fail('请选择完整的需求库和资产库路径');
  if(isInside(config.taskRoot,config.assetRoot)||isInside(config.assetRoot,config.taskRoot))fail('需求库和资产库需要分别设置，不能相互包含');
  for(const root of [config.taskRoot,config.assetRoot]){const s=await fsp.stat(root);if(!s.isDirectory())fail('选择的路径不是文件夹');await guarded(root)}
  if(this.config&&this.store.all('task').length&&(path.resolve(this.config.taskRoot)!==path.resolve(config.taskRoot)||path.resolve(this.config.assetRoot)!==path.resolve(config.assetRoot)))fail('已有任务时不能更换数据目录，请使用独立的测试环境');
  await this.release();
  this.config={taskRoot:path.resolve(config.taskRoot),assetRoot:path.resolve(config.assetRoot)};
  const sys=await ensureDir(this.config.taskRoot,'_workbench-system');
  const leaseFile=path.join(sys,'service.json'),id=crypto.randomUUID(),host=os.hostname();
  const leaseRecord=()=>({id,host,pid:process.pid,at:Date.now()});
  try{await fsp.writeFile(leaseFile,JSON.stringify(leaseRecord()),{flag:'wx'})}
  catch(e){
   if(e.code!=='EEXIST')throw e;
   let previous=JSON.parse(await fsp.readFile(leaseFile,'utf8'));
   if(previous.host===host&&!Number.isSafeInteger(Number(previous.pid))){
    const remaining=LOCAL_LEASE_STALE_MS-(Date.now()-Number(previous.at));
    if(remaining>0){
     await wait(remaining+100);
     const current=JSON.parse(await fsp.readFile(leaseFile,'utf8'));
     if(current.id!==previous.id)fail('该需求库已有负责人服务在线：'+current.host);
     previous=current;
    }
   }
   if(leaseOwnerOnline(previous,host))fail('该需求库已有负责人服务在线：'+previous.host);
   const stale=path.join(sys,'expired-'+crypto.randomUUID()+'.json');
   await fsp.rename(leaseFile,stale);
   await fsp.writeFile(leaseFile,JSON.stringify(leaseRecord()),{flag:'wx'});
  }
  this.lease={file:leaseFile,id};this.error=null;
  try{
   for(const stage of STAGES)await ensureDir(this.config.taskRoot,stage);
   await ensureDir(this.config.assetRoot,'_workbench-staging');
   // Real write/read/rename check, confined to the configured system directories.
   for(const root of [sys,path.join(this.config.assetRoot,'_workbench-staging')]){
    const a=path.join(root,'probe-'+id),b=a+'-renamed';
    await fsp.writeFile(a,id,{flag:'wx'});if(await fsp.readFile(a,'utf8')!==id)fail('NAS 写入校验失败');
    await fsp.rename(a,b);await fsp.unlink(b);
   }
   this.store.put('setting','nas',this.config);
   this.timer=setInterval(()=>this.heartbeat().catch(e=>{this.error=e.message}),10000);this.timer.unref();
  }catch(e){await this.release();throw e}
  return this.config;
 }
 async heartbeat(){
  const action=()=>this.writeHeartbeat();
  const pending=(this.heartbeatPending||Promise.resolve()).then(action,action);
  this.heartbeatPending=pending.catch(()=>{});return pending;
 }
 async writeHeartbeat(){
  if(!this.lease)return;
  const current=JSON.parse(await fsp.readFile(this.lease.file,'utf8'));
  if(current.id!==this.lease.id){const e=new Error('NAS 服务已由其他电脑接管，等待当前负责人服务退出');e.code='LEASE_LOST';throw e}
  const temp=this.lease.file+'.'+this.lease.id+'.tmp';
  await fsp.writeFile(temp,JSON.stringify({...current,at:Date.now()}));await fsp.rename(temp,this.lease.file);this.error=null;
 }
 async ready(){if(!this.config||!this.lease)fail('请先连接 NAS');if(this.error)fail('NAS 连接异常：'+this.error);await this.heartbeat();await fsp.access(this.config.assetRoot)}
 async release(){
  clearInterval(this.timer);this.timer=null;
  if(this.heartbeatPending)await this.heartbeatPending;
  if(this.lease){const l=this.lease;this.lease=null;try{const current=JSON.parse(await fsp.readFile(l.file,'utf8'));if(current.id===l.id)await fsp.unlink(l.file)}catch(e){if(e.code!=='ENOENT')this.error=e.message}}
 }
 taskPath(task){return path.join(this.config.taskRoot,STAGES[task.state],task.filename)}
 async readTask(task){
  await this.ready();const file=await guarded(this.config.taskRoot,STAGES[task.state],task.filename);
  if(await hasWorkbookLock(file,this.config.taskRoot))fail('检测到 Excel 占用记录，请保存并关闭后重试');
  const bytes=await fsp.readFile(file);if(digest(bytes)!==task.workbookHash)fail('NAS 原需求表已修改，请保存并关闭 Excel，点击刷新同步后再操作；未覆盖原文件',409);
  return bytes;
 }
 async sync(oldTask,next,patch,event){
  await this.ready();const source=this.taskPath(oldTask),dest=await guarded(this.config.taskRoot,STAGES[next.state],next.filename);
  const original=await this.readTask(oldTask),patched=Object.keys(patch).length?patchWorkbook(original,patch,{resetRatingsFor:event.kind==='rollback'&&oldTask.state!==next.state?next.items:null}):original;
  const bytes=next.workbookTaskId===next.id?identifyWorkbook(patched,next.id):patched;
  if(source!==dest&&await exists(dest))fail('目标目录已有同名需求表，未覆盖');
  const jobId=crypto.randomUUID(),backup=path.join(path.dirname(source),'.workbench-'+jobId+'.bak');
  const journal=path.join(this.store.dir,'journals',jobId);await fsp.mkdir(journal,{recursive:true});
  await fsp.writeFile(path.join(journal,'before.xlsx'),original,{flag:'wx'});
  await fsp.writeFile(path.join(journal,'after.xlsx'),bytes,{flag:'wx'});
  next.workbookHash=digest(bytes);next.workflowFields=workflowFields(bytes);next.workbookSyncIssue=null;
  const job={id:jobId,kind:'workbook',status:'prepared',phase:'prepared',source,dest,backup,originalHash:digest(original),nextHash:next.workbookHash,next,event,at:Date.now()};
  this.store.put('job',jobId,job);
  try{
   if(await fileHash(source)!==job.originalHash)fail('需求表刚刚发生变化，请重试',409);
   job.phase='moving';this.store.put('job',job.id,job);
   await fsp.rename(source,backup);
   // A save can land after the last source hash read. Validate the exact file
   // we moved before publishing an older journal over the newly saved version.
   if(await fileHash(backup)!==job.originalHash)fail('需求表刚刚发生变化，已保留最新保存，请刷新后重试',409);
   job.phase='publishing';this.store.put('job',job.id,job);
   await fsp.copyFile(path.join(journal,'after.xlsx'),dest,fs.constants.COPYFILE_EXCL);
   if(await fileHash(dest)!==job.nextHash)fail('NAS 需求表写入校验失败');
   this.finishJob(job);
   await this.cleanupBackup(job);
   return next;
  }catch(e){
   job.error=e.message;this.store.put('job',job.id,job);
   try{await this.recoverJob(job)}catch(recoveryError){e.message+='；'+recoveryError.message}
   const current=this.store.get('task',next.id);if(current?.version===next.version&&current.workbookHash===next.workbookHash)return current;
   throw e;
  }
 }
 rollbackUnpublishedJob(job){
  this.store.atomic(()=>{
   this.store.put('job',job.id,{...job,status:'rolled-back'});
   if(job.recoveryBlocked){const t=this.store.get('task',job.next.id),other=this.store.all('job').some(j=>j.id!==job.id&&j.status==='prepared'&&j.next?.id===job.next.id);if(t?.blocked==='文件同步待恢复'&&!other)this.store.put('task',t.id,{...t,blocked:null})}
  });
 }
 finishJob(job){
  this.store.atomic(()=>{this.store.put('task',job.next.id,{...job.next,blocked:null});cancelStaleUploads(this.store,job.next);this.store.event(job.event.kind,job.event.actor,job.next.id,job.event.body);this.store.put('job',job.id,{...job,status:'done',error:null})});
 }
 async cleanupBackup(job){if(await exists(job.backup)&&await fileHash(job.backup)===job.originalHash)await fsp.unlink(job.backup)}
 async recoverJob(job){
  if(job.status==='done'){try{await this.cleanupBackup(job);if(job.cleanupError)this.store.put('job',job.id,{...job,cleanupError:null})}catch(e){this.store.put('job',job.id,{...job,cleanupError:'历史备份清理待重试：'+e.message})}return}
  await this.ready();
  for(const p of [job.source,job.dest,job.backup])await guarded(this.config.taskRoot,path.relative(this.config.taskRoot,p));
  const backupExists=await exists(job.backup),destExists=await exists(job.dest);
  if(['prepared','moving','restoring'].includes(job.phase)){
   // These stages never published after.xlsx. A changed source is an external
   // save, not a broken workflow transaction, and must not be replaced by it.
   if(!backupExists){this.rollbackUnpublishedJob(job);return}
   try{
    const backupHash=await fileHash(job.backup);
    if(job.phase==='restoring'&&job.recoveryHash!==backupHash)fail('恢复期间备份内容发生变化，已保留当前文件和备份');
    const sourceExists=await exists(job.source),restored=job.phase==='restoring'&&sourceExists&&await fileHash(job.source)===backupHash;
    if((job.dest!==job.source&&destExists)||(sourceExists&&!restored))fail('另一份保存已出现在原表或目标位置，未覆盖该文件；已保留原表备份供核对');
    if(!restored){job.phase='restoring';job.recoveryHash=backupHash;this.store.put('job',job.id,job);await fsp.copyFile(job.backup,job.source,fs.constants.COPYFILE_EXCL)}
    if(await fileHash(job.source)!==backupHash||await fileHash(job.backup)!==backupHash)fail('最新原表恢复校验未完成，已保留当前文件和备份');
    await fsp.unlink(job.backup);this.rollbackUnpublishedJob(job);return;
   }catch(e){
    const t=this.store.get('task',job.next.id);if(t){if(!t.blocked)job.recoveryBlocked=true;this.store.put('job',job.id,job);this.store.put('task',t.id,{...t,blocked:'文件同步待恢复'})}
    fail('需求表同步已暂停：'+e.message+'；备份：'+job.backup);
   }
  }
  if(destExists&&await fileHash(job.dest)===job.nextHash&&backupExists&&await fileHash(job.backup)===job.originalHash){this.finishJob(job);await this.cleanupBackup(job);return}
  if(backupExists&&await fileHash(job.backup)===job.originalHash&&!await exists(job.source)&&!destExists){await fsp.rename(job.backup,job.source);this.store.put('job',job.id,{...job,status:'rolled-back'});return}
  if(!backupExists&&await exists(job.source)&&await fileHash(job.source)===job.originalHash){this.store.put('job',job.id,{...job,status:'rolled-back'});return}
  const t=this.store.get('task',job.next.id);if(t)this.store.put('task',t.id,{...t,blocked:'文件同步待恢复'});
  fail('文件同步状态需要核对，保留了原文件备份');
 }
 async recover(taskId=null){const failures=[];for(const job of this.store.all('job'))if(job.kind==='workbook'&&job.status!=='rolled-back'&&(!taskId||job.next?.id===taskId)){try{await this.recoverJob(job)}catch(e){this.store.put('job',job.id,{...job,error:e.message});failures.push(e)}}if(failures.length)throw failures[0]}
 async productDirectory(item,create=false){
  await this.ready();const root=this.config.assetRoot;
  const matches=[];
  for(const brand of await fsp.readdir(root,{withFileTypes:true})){
   if(!brand.isDirectory()||/^(00\.|99\.|#|_|[.])/.test(brand.name))continue;
   const dir=await guarded(root,brand.name);
   for(const product of await fsp.readdir(dir,{withFileTypes:true})){
    if(product.isDirectory()&&product.name.endsWith('-'+item.code))matches.push({brand:brand.name,name:product.name,path:await guarded(root,brand.name,product.name)});
   }
  }
  if(matches.length>1)fail('同一69码匹配到多个产品目录，请负责人先处理重复档案');
  if(matches.length===1)return matches[0];
  safeName(item.brand,'品牌');const productName=folderName(item.product),p=await guarded(root,item.brand,productName+'-'+item.code);
  if(create)await ensureDir(root,item.brand,productName+'-'+item.code);
  return {brand:item.brand,name:productName+'-'+item.code,path:p,isNew:true};
 }
 async categoryDirectory(product,item,create=false,splitDelivery=false){
  const category=CATEGORIES.find(c=>c.id===item.category);if(!category)fail('请选择资产类别');
  const suffix=category.id==='project'?'产品素材-工程':category.name;
  let matches=[];
  if(await exists(product.path))matches=(await fsp.readdir(product.path,{withFileTypes:true})).filter(d=>d.isDirectory()&&d.name.split('.').slice(1).join('.')===suffix);
  if(matches.length>1)fail('该产品存在多个同类资产目录，请先合并规则');
  let folder=matches[0]?.name||category.folder;
  if(!matches.length){
   const brandDir=path.join(this.config.assetRoot,product.brand);
   if(await exists(brandDir)){
    const templates=(await fsp.readdir(brandDir,{withFileTypes:true})).filter(d=>d.isDirectory()&&d.name.startsWith('00.产品结构示例'));
    if(templates.length===1){const template=await guarded(this.config.assetRoot,product.brand,templates[0].name);const found=(await fsp.readdir(template,{withFileTypes:true})).filter(d=>d.isDirectory()&&d.name.split('.').slice(1).join('.')===suffix);if(found.length===1)folder=found[0].name}
   }
  }
  const destination=await guarded(this.config.assetRoot,path.relative(this.config.assetRoot,product.path),folder);
  if(create)await fsp.mkdir(destination,{recursive:true});
  const split=splitDelivery==='flat'?false:splitDelivery||await exists(path.join(destination,'01.源文件'))&&await exists(path.join(destination,'02.导出图片'));
  if(create&&split)for(const child of ['01.源文件','02.导出图片'])await ensureDir(this.config.assetRoot,path.relative(this.config.assetRoot,destination),child);
  return {path:destination,source:split?path.join(destination,'01.源文件'):destination,output:split?path.join(destination,'02.导出图片'):destination};
 }
}
module.exports={Nas,exists,guarded,ensureDir,fileHash,isInside,folderName,leaseOwnerOnline,REMOTE_LEASE_STALE_MS,LOCAL_LEASE_STALE_MS};
