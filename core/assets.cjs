'use strict';
const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');const crypto=require('node:crypto');const {Transform}=require('node:stream');const {pipeline}=require('node:stream/promises');
const {fail,safeName,own,CATEGORIES,PEOPLE,parts,rateFor}=require('./rules.cjs');
const {guarded,exists,ensureDir,fileHash,isInside,folderName}=require('./nas.cjs');const {digest}=require('./store.cjs');
const {classifyDelivery,normalizeDeliveryFolder}=require('./delivery.cjs');
const {nameDelivery}=require('./naming.cjs');
const {automaticNames}=require('./automatic-names.cjs');const {imageWidth}=require('./image-metadata.cjs');
const {archiveIdentity,currentUpload}=require('./archive-state.cjs');
const manifestIdentity=({files,delivery})=>digest(JSON.stringify(delivery?{files,delivery}:files));
function checkStorageLayout(upload){if(upload.storageLayout!==undefined&&![2,3].includes(upload.storageLayout))fail('上传记录的存储布局版本不支持，请更新负责人端',409)}
const SOURCE_EXT=new Set(['.psd','.psb','.ai','.cdr','.afdesign','.c4d','.blend','.aep','.prproj','.fig','.zip']);
const IMAGE_EXT=new Set(['.jpg','.jpeg','.png','.gif','.webp','.tif','.tiff']);
function hasCategoryAssets(task,category,exceptId=null){
 return (task.deliveries||[]).some(d=>d.category===category&&d.id!==exceptId)||[...(task.items||[]),...(task.retainedArchiveItems||[])].some(i=>i.category===category&&(i.sealed||i.assetId)&&i.assetId!==exceptId);
}
const uploadCategory=(task,upload)=>upload.spec?.category||task.items.find(i=>i.id===upload.itemId)?.category;
function archiveSpec(task,item,folder,{allowArchived=false}={}){
 if(folder!==undefined)folder=normalizeDeliveryFolder(folder);
 const p=parts(task.completedAt),author=PEOPLE.find(x=>x.id===task.owner)?.name;
 if(!author)fail('设计师资料不完整');
 const prefix=p.month+p.day+'-'+author+'-';
 if(!item){
  const available=CATEGORIES.filter(c=>!hasCategoryAssets(task,c.id));
  if(!folder)return {folderUploadVersion:2,namingVersion:4,namingRepairVersion:1,basePrefix:prefix,categories:available.map(c=>({id:c.id,name:c.name,folder:c.folder,output:c.output})),examples:available.map(c=>prefix+c.output)};
  const date=folder.slice(0,4),month=Number(date.slice(0,2)),day=Number(date.slice(2)),validDate=/^\d{4}$/.test(date)&&month>=1&&month<=12&&day>=1&&day<=[31,29,31,30,31,30,31,31,30,31,30,31][month-1];
  const actualPrefix=date+'-'+author+'-',cat=validDate&&CATEGORIES.find(c=>folder===actualPrefix+c.output);
  if(!cat)fail('交付文件夹命名不符合规则：应为「MMDD-'+author+'-产物类型」（日期可用实际交付日期），产物类型可选 '+CATEGORIES.map(c=>c.output).join('、')+'；当前为「'+String(folder)+'」。');
  if(!allowArchived&&hasCategoryAssets(task,cat.id))fail(cat.name+'已经归档，请勿重复上传');
  return {base:folder,basePrefix:actualPrefix,category:cat.id,categoryName:cat.name,expectedCount:null,product:task.items[0]?.product,folderUploadVersion:2,namingVersion:4};
 }
 const cat=CATEGORIES.find(c=>c.id===item.category);
 if(!cat)fail('资产类别或设计师资料不完整');
 const base=prefix+cat.output;
 const group=(task.items||[item]).filter(i=>i.category===item.category);
 // Storyboards and packaging proposals are work units, not exported-file counts.
 const count=group.some(i=>['video-storyboard','packaging-design'].includes(i.type))?null:group.reduce((sum,i)=>{const rate=rateFor(i.type);return sum+(rate.base?rate.base*i.qty+(i.extra||0):i.qty)},0);
 return {base,category:cat.id,expectedCount:count,product:item.product,folderUploadVersion:1};
}
function validateTaskManifest(task,files,delivery,options){
 if(!delivery||delivery.version!==1)fail('交付文件夹格式不支持，请更新两端程序');
 const spec=archiveSpec(task,null,delivery.folder,options),raw=classifyDelivery(spec,delivery.folder,files,delivery.directories),classified=[3,4].includes(delivery.namingVersion)?automaticNames(spec,raw,delivery.naming):delivery.namingVersion===2?nameDelivery(spec,raw):raw;
 return {spec,delivery:{version:1,...([2,3,4].includes(delivery.namingVersion)?{namingVersion:delivery.namingVersion}:{}),folder:delivery.folder,naming:delivery.naming?.repair===true?{repair:true,outputNames:delivery.naming.outputNames||{}}:undefined,directories:classified.directories},files:classified.files.map((f,index)=>{
  if(!/^[a-f0-9]{64}$/.test(f.sha256))fail('文件校验信息无效：'+f.relativePath);
  return {id:String(index),name:f.name,folder:f.folder,relativePath:f.relativePath,kind:f.kind,size:f.size,sha256:f.sha256,relative:f.relative,...(f.width?{width:f.width}:{})};
 })};
}
function validateManifest(task,item,files,delivery){
 const spec=archiveSpec(task,item);
 if(delivery!==undefined){
  if(!delivery||delivery.version!==1)fail('交付文件夹格式不支持，请更新两端程序');
  const classified=classifyDelivery(spec,delivery.folder,files,delivery.directories);
  return {spec,delivery:{version:1,folder:delivery.folder,directories:classified.directories},files:classified.files.map((f,index)=>{
   if(!/^[a-f0-9]{64}$/.test(f.sha256))fail('文件校验信息无效：'+f.relativePath);
   return {id:String(index),name:f.name,folder:f.folder,relativePath:f.relativePath,kind:f.kind,size:f.size,sha256:f.sha256,relative:f.relative};
  })};
 }
 if(!Array.isArray(files)||!files.length||files.length>500)fail('请选择源文件和最终产物，最多 500 个文件');
 let total=0;const names=new Set(),sources=[],outputs=[];
 const normalized=files.map((file,index)=>{
  if(!file||!['source','output'].includes(file.kind))fail('文件类别无效');
  safeName(file.name,'文件名');
  if(!Number.isSafeInteger(file.size)||file.size<1||file.size>8*1024**3||!/^[a-f0-9]{64}$/.test(file.sha256))fail('文件大小或校验信息无效');
  total+=file.size;const ext=path.extname(file.name).toLowerCase(),stem=file.name.slice(0,-ext.length);
  let relative;
  if(file.kind==='source'){
   if(!SOURCE_EXT.has(ext))fail('源文件格式不支持：'+ext);
   const valid=stem===spec.base||(spec.category==='project'&&['刀版','c4d'].some(type=>stem===spec.base.replace(/工程$/,type)));
   if(!valid)fail('封存失败，源文件命名不符合规则。');
   relative=file.name;sources.push(file);
  }else{
   if(spec.category==='video'){
    if(ext!=='.mp4'||stem!==spec.base||file.folder)fail('封存失败，视频命名不符合规则。');
    relative=file.name;
   }else{
    if(!IMAGE_EXT.has(ext)||file.folder!==spec.base)fail('封存失败，产物文件夹命名不符合规则。');
    if(!['six','packaging'].includes(spec.category)){
     const prefix=spec.category==='detail'?folderName(item.product)+'-详情':CATEGORIES.find(c=>c.id===spec.category).output;
     if(!stem.startsWith(prefix)||!/^\d{2}$/.test(stem.slice(prefix.length))||Number(stem.slice(prefix.length))<1)fail('封存失败，图片画板命名不符合规则。');
    }
    relative=path.join(spec.base,file.name);
   }
   outputs.push(file);
  }
  const key=(file.kind+'/'+relative).toLowerCase();if(names.has(key))fail('封存文件重名');names.add(key);
  return {id:String(index),name:file.name,folder:file.folder||'',kind:file.kind,size:file.size,sha256:file.sha256,relative};
 });
 if(spec.category!=='video'&&!sources.length)fail('请选择可编辑的源文件');
 if(spec.category!=='project'&&spec.expectedCount!=null&&outputs.length!==spec.expectedCount)fail('最终产物数量应为 '+spec.expectedCount+'，当前为 '+outputs.length);
 if(spec.category!=='project'&&spec.expectedCount==null&&!outputs.length)fail('最终产物至少应有 1 个，当前为 0');
 if(total>20*1024**3)fail('本次封存总大小不能超过 20 GB，请拆分事项');

 if(!['video','six','packaging'].includes(spec.category)&&outputs.length){
  const nums=outputs.map(f=>Number(path.basename(f.name,path.extname(f.name)).slice(-2))).sort((a,b)=>a-b);
  if(nums.some((n,i)=>n!==i+1))fail('图片序号需要从 01 连续编号');
 }
 return {files:normalized,spec};
}
async function checkSignature(file,name){
 const h=await fsp.open(file,'r');const b=Buffer.alloc(512);let count;try{({bytesRead:count}=await h.read(b,0,b.length,0))}finally{await h.close()}
 const ext=path.extname(name).toLowerCase(),s=b.subarray(0,count);
 let ok=true;
 if(ext==='.psd'||ext==='.psb')ok=s.toString('ascii',0,4)==='8BPS'&&s.length>=26;
 else if(ext==='.png')ok=s.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
 else if(ext==='.jpg'||ext==='.jpeg')ok=s[0]===255&&s[1]===216&&s[2]===255;
 else if(ext==='.webp')ok=s.toString('ascii',0,4)==='RIFF'&&s.toString('ascii',8,12)==='WEBP';
 else if(ext==='.mp4')ok=s.toString('ascii',4,8)==='ftyp';
 else if(ext==='.ai')ok=s.toString('ascii',0,4)==='%PDF'||s.toString('ascii',0,4)==='%!PS';
 else if(ext==='.zip')ok=s[0]===80&&s[1]===75;
 else if(ext==='.tif'||ext==='.tiff')ok=s.toString('ascii',0,2)==='II'||s.toString('ascii',0,2)==='MM';
 if(!ok)fail('文件内容与扩展名不符：'+name);
}
class Assets{
 constructor(store,nas,products=null){this.store=store;this.nas=nas;this.products=products;this.inflight=new Set();this.busy=new Set();this.publicationQueues=new Map()}
 lockBatch(id){
  if(this.busy.has(id)||[...this.inflight].some(k=>k.startsWith(id+'/')))fail('该批次仍有文件正在传输或处理，请等待结束后重试',409);
  this.busy.add(id);
 }
 checkUpload(u,task,actor){
  if(!u||u.actor!==actor.personId)fail('没有此封存权限',403);
  if(!task)fail('任务不存在',404);own(actor,task);
  checkStorageLayout(u);
  if(!currentUpload(task,u))fail('这是回退前的上传记录，请重新选择产物',409);
  if(!['uploading','publishing','done'].includes(u.status))fail('上传已取消或被新文件替代，请重新选择产物',409);
  if(u.taskIdentity&&u.taskIdentity!==archiveIdentity(task))fail('任务确认或需求内容已变化，请重新选择产物',409);
  if(task.blocked)fail('任务存在未恢复的文件同步，请先恢复后重试',409);
  if(hasCategoryAssets(task,uploadCategory(task,u),u.id))fail('该类别已经归档，请勿重复上传',409);
 }
 async verified(file,expected){
  try{const stat=await fsp.stat(file);return stat.isFile()&&stat.size===expected.size&&await fileHash(file)===expected.sha256}
  catch(e){if(e.code==='ENOENT')return false;throw e}
 }
 async refreshReceived(u){
  if(u.status==='done')return u;
  this.lockBatch(u.id);
  try{
  const next=structuredClone(u);next.received??={};
  for(const f of u.files){
   const stage=await guarded(this.nas.config.assetRoot,'_workbench-staging',u.id,f.id+'.part');
   let valid=await this.verified(stage,f);
   if(!valid&&u.published?.[f.id]){const dest=await guarded(this.nas.config.assetRoot,path.relative(this.nas.config.assetRoot,u.published[f.id]));valid=await this.verified(dest,f)}
   if(valid)next.received[f.id]??=Date.now();else delete next.received[f.id];
  }
  this.store.put('upload',next.id,next);return next;
  }finally{this.busy.delete(u.id)}
 }
 async publicationPlan(u,category){
  const plan=[];
  // Verify the complete package before creating any official files. A verified
  // published file is sufficient for recovery even if staging was already lost.
  for(const f of u.files){
   const dest=await guarded(this.nas.config.assetRoot,path.relative(this.nas.config.assetRoot,f.kind==='source'?category.source:category.output),f.relative);
   let source=dest;
   if(await exists(dest)){if(!await this.verified(dest,f))fail('正式库同名文件内容不同，未覆盖：'+f.name)}
   else{source=await guarded(this.nas.config.assetRoot,'_workbench-staging',u.id,f.id+'.part');if(!await this.verified(source,f))fail('暂存文件缺失或校验失败，请重新选择同一批产物补传：'+f.name)}
   await checkSignature(source,f.name);plan.push({file:f,source,dest});
  }
  return plan;
 }
 async publishFiles(u,category,plan){
  for(const d of u.delivery?.directories||[]){const dest=await guarded(this.nas.config.assetRoot,path.relative(this.nas.config.assetRoot,d.kind==='source'?category.source:category.output),d.relative);await fsp.mkdir(dest,{recursive:true})}
  for(const {file:f,source,dest} of plan){
   await fsp.mkdir(path.dirname(dest),{recursive:true});
   if(!await exists(dest))await fsp.copyFile(source,dest,fs.constants.COPYFILE_EXCL);
   if(!await this.verified(dest,f))fail('正式库同名文件内容不同或资产写入校验失败，未覆盖：'+f.name);
   u.published[f.id]=dest;this.store.put('upload',u.id,u);
  }
 }
 revisionCategory(category,task){
  if(!task.archiveRound)return category;
  const folder='返工-'+task.id+'-'+task.archiveRound;
  return {...category,source:path.join(category.source,folder),output:path.join(category.output,folder)};
 }
 categoryShape(category){
  if(!category||['path','source','output'].some(k=>typeof category[k]!=='string'||!path.isAbsolute(category[k])))fail('上传记录的资产目录不完整，请重新选择文件',409);
  const source=path.relative(category.path,category.source),output=path.relative(category.path,category.output);
  if(source===''&&output==='')return 'flat';
  if(source==='01.源文件'&&output==='02.导出图片')return 'split';
  fail('上传记录的源文件或产物目录不符合固定布局，未改动原产物',409);
 }
 taskCategory(category,task,shape=this.categoryShape(category)){
  const round=task.archiveRound||0;if(!Number.isSafeInteger(round)||round<0)fail('任务返工轮次无效',409);
  const folder=safeName('任务-'+safeName(task.id,'任务编号'),'任务目录');
  const root=path.join(category.path,folder,...(round?['返工-'+round]:[]));
  return {...category,path:root,source:shape==='split'?path.join(root,'01.源文件'):root,output:shape==='split'?path.join(root,'02.导出图片'):root};
 }
 deliveryCategory(category,task,shape=this.categoryShape(category)){
  const round=task.archiveRound||0;if(!Number.isSafeInteger(round)||round<0)fail('任务返工轮次无效',409);
  // Task IDs stay in metadata. Human-facing folders retain date / designer / type names.
  const root=round?path.join(category.path,'返工-'+round):category.path;
  return {...category,path:root,source:shape==='split'?path.join(root,'01.源文件'):root,output:shape==='split'?path.join(root,'02.导出图片'):root};
 }
 async withPublication(category,fn){
  const key=category.path.toLowerCase(),previous=this.publicationQueues.get(key)||Promise.resolve();let release;
  const current=new Promise(resolve=>release=resolve);this.publicationQueues.set(key,current);
  await previous.catch(()=>{});try{return await fn()}finally{release();if(this.publicationQueues.get(key)===current)this.publicationQueues.delete(key)}
 }
 checkReservedTargets(task,files,category){
  const targets=new Map(files.map(f=>[path.join(f.kind==='source'?category.source:category.output,f.relative).toLowerCase(),f]));
  for(const upload of this.store.all('upload')){
   if(upload.taskId===task.id||!['uploading','publishing'].includes(upload.status)||!upload.category||!currentUpload(this.store.get('task',upload.taskId),upload))continue;
   for(const f of upload.files||[]){const root=f.kind==='source'?upload.category.source:upload.category.output;if(typeof root!=='string'||typeof f.relative!=='string')continue;const own=targets.get(path.join(root,f.relative).toLowerCase());if(own&&own.sha256!==f.sha256)fail('同一交付位置已有其他任务正在上传，文件同名但内容不同。请区分实际交付日期或文件版本后重试：'+own.name,409)}
  }
 }
 async resolveUploadCategory(u,task,product,item,splitDelivery,{create=true,freezeLegacyFlat=false}={}){
  if(product.path!==u.product.path)fail('资产目录发生变化，请重新选择文件',409);
  if([2,3].includes(u.storageLayout)){
   if(u.taskId!==task.id||(u.archiveRound||0)!==(task.archiveRound||0))fail('上传记录与任务或返工轮次不一致，请重新选择产物',409);
   const base=await this.nas.categoryDirectory(product,item,create,'flat'),expected=u.storageLayout===2?this.taskCategory(base,task,this.categoryShape(u.category)):this.deliveryCategory(base,task,this.categoryShape(u.category));
   if(['path','source','output'].some(k=>u.category[k]!==expected[k]))fail('任务资产目录发生变化，未改动原产物，请重新选择文件',409);
   // Prepare fixes both the task directory and flat/split layout. New sibling
   // directories must never redirect an already prepared or publishing batch.
   return u.category;
  }
  if(u.storageLayout!==undefined)fail('上传记录的存储布局版本不支持，请更新负责人端',409);
  const resolved=this.revisionCategory(await this.nas.categoryDirectory(product,item,create,splitDelivery),task);
  const category=freezeLegacyFlat?{...resolved,source:u.category.source,output:u.category.output}:resolved;
  if(category.path!==u.category.path)fail('资产目录发生变化，请重新选择文件',409);
  return category;
 }
 async prepare(task,itemId,actor,payload){
  own(actor,task);if(task.state!==4)fail('运营确认完结后才能上传产物',409);
  if(task.blocked)fail('任务存在未恢复的文件同步，请先恢复后重试',409);
  const modern=!itemId&&payload.delivery?.version===1,item=modern?task.items[0]:task.items.find(i=>i.id===itemId);if(!item)fail('事项不存在',409);
  if(payload.selfChecked!==true)fail('请确认源文件可编辑、最终产物与运营确认内容一致');
  const {files,spec,delivery}=modern?validateTaskManifest(task,payload.files,payload.delivery,{allowArchived:true}):validateManifest(task,item,payload.files,payload.delivery);
  const manifestHash=manifestIdentity({files,delivery});
  const previous=this.store.all('upload').find(u=>currentUpload(task,u)&&u.itemId===(modern?null:itemId)&&u.actor===actor.personId&&['uploading','publishing','done'].includes(u.status)&&(!u.taskIdentity||u.taskIdentity===archiveIdentity(task))&&manifestIdentity(u)===manifestHash);
  if(hasCategoryAssets(task,spec.category,previous?.id))fail((spec.categoryName||'该类别')+'已经归档，请勿重复上传',409);
  if(previous){
   this.checkUpload(previous,task,actor);await this.nas.ready();
   if([2,3].includes(previous.storageLayout)){const assetItem=modern?{...item,category:spec.category}:item,product=await this.nas.productDirectory(assetItem);await this.resolveUploadCategory(previous,task,product,assetItem,!!previous.delivery,{create:false,freezeLegacyFlat:!previous.delivery})}
   return this.refreshReceived(previous);
  }
  if(task.sealed||!modern&&item.sealed)fail('任务已经封存',409);
  const assetItem=modern?{...item,category:spec.category}:item;
   await this.nas.ready();const productResolution=this.products?await this.products.confirm(assetItem,payload.productDecision):null,product=await this.nas.productDirectory(assetItem),category=this.deliveryCategory(await this.nas.categoryDirectory(product,assetItem,false,[2,3].includes(delivery?.namingVersion)?'flat':!!delivery),task);
  for(const u of this.store.all('upload'))if(currentUpload(task,u)&&uploadCategory(task,u)===spec.category&&u.status==='publishing')fail('上次封存正在恢复，请使用同一批文件重试');
  this.checkReservedTargets(task,files,category);
  for(const f of files){const target=path.join(f.kind==='source'?category.source:category.output,f.relative);await guarded(this.nas.config.assetRoot,path.relative(this.nas.config.assetRoot,target));if(await exists(target)&&await fileHash(target)!==f.sha256)fail('正式库存在同名但内容不同的文件，请确认新版本名称后上传：'+f.name)}
  const id=crypto.randomUUID(),stage=await ensureDir(this.nas.config.assetRoot,'_workbench-staging',id);
   const record={id,storageLayout:3,archiveRound:task.archiveRound||0,taskIdentity:archiveIdentity(task),taskId:task.id,itemId:modern?null:itemId,itemIds:modern?[]:task.items.filter(i=>i.category===item.category).map(i=>i.id),actor:actor.personId,manifestHash,files,spec,delivery,productResolution,status:'uploading',received:{},stage,product,category,createdAt:Date.now(),selfCheckedAt:Date.now()};
  const replaced=this.store.all('upload').filter(u=>u.taskId===task.id&&u.actor===actor.personId&&uploadCategory(task,u)===spec.category&&u.status==='uploading');
  if(replaced.some(u=>this.busy.has(u.id)||[...this.inflight].some(key=>key.startsWith(u.id+'/'))))fail('该类别仍有文件正在传输或处理，请等待结束后再更换文件');
  // Recheck after filesystem awaits so two simultaneous preparations cannot reserve conflicting bytes.
  this.checkReservedTargets(task,files,category);
  this.store.atomic(()=>{for(const u of replaced)this.store.put('upload',u.id,{...u,status:'cancelled',replacedBy:id,error:'已由重新选择的文件替代'});this.store.put('upload',id,record)});return record;
 }
 async receive(uploadId,fileId,actor,stream,length){
  const key=uploadId+'/'+fileId;if(this.inflight.has(key))fail('该文件正在上传',409);
  if(this.busy.has(uploadId))fail('该批次正在校验或归档，请等待结束后重试',409);
  const record=this.store.get('upload',uploadId),task=record&&this.store.get('task',record.taskId);
  this.checkUpload(record,task,actor);
  if(task.state!==4||task.sealed)fail('任务状态已变化，请重新选择产物',409);
  const file=record.files.find(f=>f.id===fileId);if(!file||!['uploading','publishing'].includes(record.status))fail('上传状态无效');
  if(Number(length)!==file.size)fail('上传长度不匹配');
  this.inflight.add(key);let destination,written=false;
  try{
   await this.nas.ready();destination=await guarded(this.nas.config.assetRoot,'_workbench-staging',record.id,file.id+'.part');
   await fsp.mkdir(path.dirname(destination),{recursive:true});
   const starting=this.store.get('upload',uploadId),current=this.store.get('task',record.taskId);this.checkUpload(starting,current,actor);
   if(current.state!==4||current.sealed||!['uploading','publishing'].includes(starting.status))fail('上传状态已变化，请重新选择产物',409);
   delete starting.received[fileId];this.store.put('upload',uploadId,starting);
   let received=0;const hash=crypto.createHash('sha256');
   const meter=new Transform({transform(chunk,_encoding,callback){received+=chunk.length;if(received>file.size)return callback(new Error('上传超过声明大小'));hash.update(chunk);callback(null,chunk)}});
   written=true;await pipeline(stream,meter,fs.createWriteStream(destination,{flags:'w'}));
   if(received!==file.size||hash.digest('hex')!==file.sha256)fail('上传完整性校验失败，请重试');
   await checkSignature(destination,file.name);
   const latest=this.store.get('upload',uploadId),latestTask=this.store.get('task',record.taskId);this.checkUpload(latest,latestTask,actor);
   if(latestTask.state!==4||latestTask.sealed||!['uploading','publishing'].includes(latest.status))fail('上传状态已变化，请重新选择产物',409);
   latest.received[fileId]=Date.now();this.store.put('upload',uploadId,latest);return {received:true};
  }catch(e){if(written)await fsp.unlink(destination).catch(()=>{});throw e}
  finally{this.inflight.delete(key)}
 }
 async commit(uploadId,actor){
  const upload=this.store.get('upload',uploadId);this.checkUpload(upload,upload&&this.store.get('task',upload.taskId),actor);
  this.lockBatch(uploadId);
  try{return await this.commitLocked(uploadId,actor)}finally{this.busy.delete(uploadId)}
 }
 async commitLocked(uploadId,actor){
  let u=this.store.get('upload',uploadId);if(!u||u.actor!==actor.personId)fail('没有此封存权限',403);
  let task=this.store.get('task',u.taskId);this.checkUpload(u,task,actor);
  if([...this.inflight].some(k=>k.startsWith(u.id+'/')))fail('该批次仍有文件正在传输，请等待结束后重试',409);
  const item=task.items.find(i=>i.id===u.itemId);
  if(u.spec?.folderUploadVersion===2){const done=task.deliveries?.find(d=>d.id===u.id);if(done){await this.finalizeDelivery(u,task,done);return task}return this.commitDelivery(u,task,actor)}
  if(item?.sealed&&item.assetId===u.id){await this.finalize(u,task);return task}
  if(task.state!==4||task.sealed||!item||item.sealed||u.status==='done')fail('任务状态已改变',409);
  if(u.files.some(f=>!u.received[f.id]))fail('还有文件尚未上传完整');
  await this.nas.ready();
  const product=await this.nas.productDirectory(item,true);
  // An older client may be resuming a flat upload after split folders were added.
  const category=await this.resolveUploadCategory(u,task,product,item,!!u.delivery,{freezeLegacyFlat:!u.delivery});
  return this.withPublication(category,async()=>{
  const plan=await this.publicationPlan(u,category);u.status='publishing';u.published??={};this.store.put('upload',u.id,u);
  try{
   await this.publishFiles(u,category,plan);
   const next=structuredClone(task),sealTime=Date.now();
   for(const nextItem of next.items.filter(i=>(u.itemIds||[u.itemId]).includes(i.id))){nextItem.sealed=true;nextItem.sealedAt=sealTime;nextItem.assetPath=category.path;nextItem.assetId=u.id;nextItem.productPath=product.path}
   next.sealed=next.items.every(i=>i.sealed);next.updatedAt=Date.now();next.version++;
   const addresses=[...new Set(next.items.filter(i=>i.sealed).map(i=>CATEGORIES.find(c=>c.id===i.category).name+'：'+i.assetPath))].join('\n');
    task=await this.nas.sync(task,next,{L4:addresses},{kind:'sealed',actor:actor.personId,body:{itemId:item.id,assetId:u.id,code:item.code,files:u.files.map(f=>({name:f.name,size:f.size,sha256:f.sha256,path:u.published[f.id]}))}});this.products?.recordArchive(item,product,u.productResolution);
   await this.finalize(u,task);
   return task;
  }catch(e){u.error=e.message;this.store.put('upload',u.id,u);throw e}
  });
 }
 async commitDelivery(u,task,actor){
  if(task.state!==4||task.sealed||u.status==='done')fail('任务状态已改变',409);
  if(task.deliveries?.some(d=>d.category===u.spec.category))fail(u.spec.categoryName+'已经归档，请勿重复上传',409);
  if(u.files.some(f=>!u.received[f.id]))fail('还有文件尚未上传完整');
  await this.nas.ready();const item={...task.items[0],category:u.spec.category};
  const product=await this.nas.productDirectory(item,true),category=await this.resolveUploadCategory(u,task,product,item,[2,3].includes(u.delivery?.namingVersion)?'flat':true);
  return this.withPublication(category,async()=>{
  const plan=await this.publicationPlan(u,category);
  if([3,4].includes(u.delivery?.namingVersion)&&u.spec.category==='main')for(const {file:f,source} of plan.filter(p=>p.file.kind==='output')){if(await imageWidth(source)!==f.width)fail('图片实际宽度与预览不一致，请重新选择：'+f.name)}
  u.status='publishing';u.published??={};this.store.put('upload',u.id,u);
  try{
   await this.publishFiles(u,category,plan);
   const next=structuredClone(task),at=Date.now(),delivery={id:u.id,category:u.spec.category,categoryName:u.spec.categoryName,path:category.path,folder:u.spec.base,productPath:product.path,at};
   next.deliveries=[...(next.deliveries||[]),delivery];next.sealed=false;next.updatedAt=at;next.version++;
   const addresses=next.deliveries.map(d=>(CATEGORIES.find(c=>c.id===d.category)?.name||d.categoryName)+'：'+d.path).join('\n');
    task=await this.nas.sync(task,next,{L4:addresses},{kind:'asset-archived',actor:actor.personId,body:{assetId:u.id,category:u.spec.category,code:item.code,files:u.files.map(f=>({name:f.name,size:f.size,sha256:f.sha256,path:u.published[f.id]}))}});this.products?.recordArchive(item,product,u.productResolution);
   await this.finalizeDelivery(u,task,delivery);return task;
  }catch(e){u.error=e.message;this.store.put('upload',u.id,u);throw e}
  });
 }
 async finish(taskId,actor,version){
  const task=this.store.get('task',taskId);if(!task)fail('任务不存在',404);
  const assisted=actor.role==='manager'&&!!this.store.get('removedMember',task.owner);
  if(actor.role==='designer')own(actor,task);
  else if(!assisted)fail('仅任务设计师或代已离职成员核对产物的负责人可以完成封存',403);
  if(task.blocked)fail('任务存在未恢复的文件同步，请先恢复后重试',409);
  if(task.state!==4)fail('任务尚不能完成封存',409);
  if(task.sealed){
   if(version!==task.version&&!(version===task.sealedFromVersion&&task.version===version+1))fail('任务已更新，请刷新后重试',409);
   return task;
  }
  if(version!==task.version)fail('任务已更新，请刷新后重试',409);
  if(!(task.deliveries||[]).length)fail('请先上传至少一类最终产物');
  if(this.store.all('upload').some(u=>currentUpload(task,u)&&(['uploading','publishing'].includes(u.status)||[...this.inflight].some(k=>k.startsWith(u.id+'/')))))fail('仍有产物正在上传或等待恢复');
  if(new Set(task.deliveries.map(d=>d.category)).size!==task.deliveries.length)fail('同一类别存在重复归档记录，请先核对后再封存');
  await this.nas.ready();
  for(const delivery of task.deliveries){
   const record=this.store.get('asset',delivery.id);
   if(!record||record.missingAt||!record.files?.length)fail('归档记录不完整，请刷新资产状态后重新上传');
   for(const file of record.files){
    const target=await guarded(this.nas.config.assetRoot,path.relative(this.nas.config.assetRoot,file.path));
    if(!await exists(target))fail('不能完成封存，正式库缺少文件：'+file.name+'。请恢复文件或刷新后重新上传');
    const stat=await fsp.stat(target);
    if(!stat.isFile()||stat.size!==file.size||await fileHash(target)!==file.sha256)fail('不能完成封存，正式库文件已改变：'+file.name+'。请恢复原文件后重试');
   }
  }
  // Completion normally skips background scans. Check this task's original
  // immediately before sealing, so a saved edit or Excel lock cannot be missed.
  if(task.workbookSyncIssue)fail('请先由负责人刷新已完结任务并处理原表异常：'+task.workbookSyncIssue.message,409);
  await this.nas.readTask(task);
  const next=structuredClone(task);next.sealed=true;next.sealedAt=Date.now();next.sealedFromVersion=version;next.updatedAt=next.sealedAt;next.version++;
  this.store.atomic(()=>{this.store.put('task',next.id,next);this.store.event('sealed',actor.personId,next.id,{categories:next.deliveries.map(d=>d.category),...(assisted?{assistedFor:task.owner}:{})})});return next;
 }
 async finalize(u,task){
  checkStorageLayout(u);
  const item=task.items.find(i=>i.id===u.itemId);
  if(!item?.sealed||item.assetId!==u.id)fail('封存记录尚未提交');
  const index={id:u.id,taskId:task.id,itemId:item.id,itemIds:u.itemIds||[item.id],code:item.code,product:u.product.name,brand:u.product.brand||item.brand,author:u.actor,path:item.assetPath,at:item.sealedAt,delivery:u.delivery,files:u.files.map(f=>({...f,path:u.published[f.id]}))};
  u={...u,status:'done',completedAt:item.sealedAt,error:null};
  this.store.atomic(()=>{this.store.put('asset',u.id,index);this.store.put('upload',u.id,u)});
  try{
   const auditDir=await ensureDir(this.nas.config.taskRoot,'_workbench-system','asset-records'),file=path.join(auditDir,u.id+'.json');
   await fsp.writeFile(file,JSON.stringify(index,null,2),{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e});
   const root=path.join(this.nas.config.assetRoot,'_workbench-staging'),stage=await guarded(root,u.id);
   if(isInside(root,stage)&&path.basename(stage)===u.id)await fsp.rm(stage,{recursive:true,force:true});
   u.maintenanceError=null;
  }catch(e){u.maintenanceError='资产已封存，记录备份或暂存清理待重试：'+e.message}
  this.store.put('upload',u.id,u);
 }
 async finalizeDelivery(u,task,delivery){
  checkStorageLayout(u);
  if(!(task.deliveries||[]).some(d=>d.id===u.id))fail('归档记录尚未提交');
  const item=task.items[0],index={id:u.id,taskId:task.id,itemId:null,itemIds:[],code:item.code,product:u.product.name,brand:u.product.brand||item.brand,author:u.actor,path:delivery.path,at:delivery.at,category:delivery.category,delivery:u.delivery,files:u.files.map(f=>({...f,path:u.published[f.id]}))};
  u={...u,status:'done',completedAt:delivery.at,error:null};this.store.atomic(()=>{this.store.put('asset',u.id,index);this.store.put('upload',u.id,u)});
  try{
   const auditDir=await ensureDir(this.nas.config.taskRoot,'_workbench-system','asset-records'),file=path.join(auditDir,u.id+'.json');
   await fsp.writeFile(file,JSON.stringify(index,null,2),{flag:'wx'}).catch(e=>{if(e.code!=='EEXIST')throw e});
   const root=path.join(this.nas.config.assetRoot,'_workbench-staging'),stage=await guarded(root,u.id);
   if(isInside(root,stage)&&path.basename(stage)===u.id)await fsp.rm(stage,{recursive:true,force:true});u.maintenanceError=null;
  }catch(e){u.maintenanceError='资产已归档，记录备份或暂存清理待重试：'+e.message}
  this.store.put('upload',u.id,u);
 }
 async retryPending(taskId=null){
  let restored=0;
  for(const candidate of this.store.all('upload')){
   if(taskId&&candidate.taskId!==taskId)continue;
   if(!['uploading','publishing'].includes(candidate.status)||candidate.files.some(f=>!candidate.received[f.id])||[...this.inflight].some(k=>k.startsWith(candidate.id+'/')))continue;
   if(!taskId&&candidate.retryAt&&candidate.retryAt>Date.now())continue;
   const task=this.store.get('task',candidate.taskId);if(!task||task.state!==4||task.sealed||task.blocked||(candidate.archiveRound||0)!==(task.archiveRound||0))continue;
   // A recovery error can occur before recoverJob marks the task blocked. Do not
   // start another publication while that task's workbook journal is unresolved.
   if(this.store.all('job').some(j=>j.kind==='workbook'&&j.status==='prepared'&&j.next?.id===task.id))continue;
   try{await this.commit(candidate.id,{role:'designer',personId:candidate.actor});restored++}
   catch(e){const latest=this.store.get('upload',candidate.id);if(latest&&latest.status!=='done')this.store.put('upload',latest.id,{...latest,error:e.message,retryAt:Date.now()+30000})}
  }
  return restored;
 }
 async recover(){
  for(const u of this.store.all('upload')){
   const task=this.store.get('task',u.taskId),item=task?.items.find(i=>i.id===u.itemId),delivery=task?.deliveries?.find(d=>d.id===u.id);
   if(u.status==='cancelled'||!currentUpload(task,u))continue;
   if(this.busy.has(u.id)||[...this.inflight].some(k=>k.startsWith(u.id+'/')))continue;
   this.lockBatch(u.id);
   try{
    if(u.spec?.folderUploadVersion===2&&delivery&&(u.status!=='done'||u.maintenanceError))await this.finalizeDelivery(u,task,delivery);
    else if(item?.sealed&&item.assetId===u.id&&(u.status!=='done'||u.maintenanceError))await this.finalize(u,task);
   }finally{this.busy.delete(u.id)}
  }
 }
 async reconcileMissingAssets({includeCompleted=true}={}){
  return this.store.exclusive(async()=>{
   await this.nas.ready();let changed=0,reopened=0,partial=0;
   for(const recorded of this.store.all('asset')){
    if(!includeCompleted&&this.store.get('task',recorded.taskId)?.state===4)continue;
    if(this.store.get('task',recorded.taskId)?.deliveryHistory?.some(h=>(h.deliveries||[]).some(d=>d.id===recorded.id)||(h.items||[]).some(i=>i.assetId===recorded.id)))continue;
    if(recorded.missingAt||!Array.isArray(recorded.files)||!recorded.files.length)continue;
    const checked=[];
    for(const file of recorded.files){
     if(typeof file?.path!=='string'||!file.path)continue;
     const target=await guarded(this.nas.config.assetRoot,path.relative(this.nas.config.assetRoot,file.path));
     checked.push({path:target,exists:await exists(target)});
    }
    // Old incomplete indexes cannot prove that an archive was deleted.
    if(checked.length!==recorded.files.length)continue;
    const missing=checked.filter(file=>!file.exists).map(file=>file.path),task=this.store.get('task',recorded.taskId);
    if(!missing.length){
     if(task?.assetSyncIssue?.assetId===recorded.id){delete task.assetSyncIssue;this.store.put('task',task.id,task);changed++}
     continue;
    }
    if(missing.length<checked.length){
     const message='封存资产不完整：缺少 '+missing.length+' / '+checked.length+' 个文件。请恢复缺失文件，或删除该次归档的其余文件后刷新并重新上传。';
     if(task&&(task.assetSyncIssue?.assetId!==recorded.id||task.assetSyncIssue.message!==message)){
      task.assetSyncIssue={assetId:recorded.id,stage:'正式资产库',message,missingFiles:missing.map(file=>path.basename(file)),at:Date.now()};
      this.store.put('task',task.id,task);changed++;partial++;
     }
     continue;
    }
    const now=Date.now(),asset={...recorded,missingAt:now,missingFiles:missing},upload=this.store.get('upload',recorded.id);
    let next=task,affected=false;
    if(task){
     next=structuredClone(task);
     const deliveries=next.deliveries||[],remaining=deliveries.filter(delivery=>delivery.id!==recorded.id);
     if(remaining.length!==deliveries.length){next.deliveries=remaining;affected=true}
     for(const item of [...(next.items||[]),...(next.retainedArchiveItems||[])]){
      if(item.assetId!==recorded.id)continue;
      item.sealed=false;delete item.sealedAt;delete item.assetPath;delete item.assetId;delete item.productPath;affected=true;
     }
     if(next.assetSyncIssue?.assetId===recorded.id)delete next.assetSyncIssue;
     if(affected){next.sealed=false;delete next.sealedAt;delete next.sealedFromVersion;next.updatedAt=now;next.version=(next.version||0)+1}
    }
    this.store.atomic(()=>{
     this.store.put('asset',recorded.id,asset);
     if(upload)this.store.put('upload',upload.id,{...upload,status:'cancelled',removedAt:now,error:'正式资产文件已被删除，可重新上传'});
     if(affected){this.store.put('task',next.id,next);this.store.event('asset-removed','nas',next.id,{assetId:recorded.id,missingFiles:missing})}
    });
    changed++;if(affected)reopened++;
   }
   return {changed,reopened,partial};
  });
 }
}
module.exports={Assets,archiveSpec,validateManifest,validateTaskManifest,checkSignature};
