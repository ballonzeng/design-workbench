'use strict';
const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');const crypto=require('node:crypto');const {Transform}=require('node:stream');const {pipeline}=require('node:stream/promises');
const {fail,safeName,own,CATEGORIES,PEOPLE,parts,rateFor}=require('./rules.cjs');
const {guarded,exists,ensureDir,fileHash,isInside,folderName}=require('./nas.cjs');const {digest}=require('./store.cjs');
const {classifyDelivery,normalizeDeliveryFolder}=require('./delivery.cjs');
const {nameDelivery}=require('./naming.cjs');
const {automaticNames}=require('./automatic-names.cjs');const {imageWidth}=require('./image-metadata.cjs');
const SOURCE_EXT=new Set(['.psd','.psb','.ai','.cdr','.afdesign','.c4d','.blend','.aep','.prproj','.fig','.zip']);
const IMAGE_EXT=new Set(['.jpg','.jpeg','.png','.gif','.webp','.tif','.tiff']);
function archiveSpec(task,item,folder){
 if(folder!==undefined)folder=normalizeDeliveryFolder(folder);
 const p=parts(task.completedAt),author=PEOPLE.find(x=>x.id===task.owner)?.name;
 if(!author)fail('设计师资料不完整');
 const prefix=p.month+p.day+'-'+author+'-';
 if(!item){
  const available=CATEGORIES.filter(c=>!(task.deliveries||[]).some(d=>d.category===c.id));
  if(!folder)return {folderUploadVersion:2,namingVersion:4,basePrefix:prefix,categories:available.map(c=>({id:c.id,name:c.name,folder:c.folder,output:c.output})),examples:available.map(c=>prefix+c.output)};
  const date=folder.slice(0,4),month=Number(date.slice(0,2)),day=Number(date.slice(2)),validDate=/^\d{4}$/.test(date)&&month>=1&&month<=12&&day>=1&&day<=[31,29,31,30,31,30,31,31,30,31,30,31][month-1];
  const actualPrefix=date+'-'+author+'-',cat=validDate&&CATEGORIES.find(c=>folder===actualPrefix+c.output);
  if(!cat)fail('交付文件夹命名不符合规则：应为「MMDD-'+author+'-产物类型」（日期可用实际交付日期），产物类型可选 '+CATEGORIES.map(c=>c.output).join('、')+'；当前为「'+String(folder)+'」。');
  if((task.deliveries||[]).some(d=>d.category===cat.id))fail(cat.name+'已经归档，请勿重复上传');
  return {base:folder,basePrefix:actualPrefix,category:cat.id,categoryName:cat.name,expectedCount:null,product:task.items[0]?.product,folderUploadVersion:2,namingVersion:4};
 }
 const cat=CATEGORIES.find(c=>c.id===item.category);
 if(!cat)fail('资产类别或设计师资料不完整');
 const base=prefix+cat.output;
 const group=(task.items||[item]).filter(i=>i.category===item.category);
 const count=group.reduce((sum,i)=>{const rate=rateFor(i.type);return sum+(rate.base?rate.base*i.qty+(i.extra||0):i.qty)},0);
 return {base,category:cat.id,expectedCount:count,product:item.product,folderUploadVersion:1};
}
function validateTaskManifest(task,files,delivery){
 if(!delivery||delivery.version!==1)fail('交付文件夹格式不支持，请更新两端程序');
 const spec=archiveSpec(task,null,delivery.folder),raw=classifyDelivery(spec,delivery.folder,files,delivery.directories),classified=[3,4].includes(delivery.namingVersion)?automaticNames(spec,raw):delivery.namingVersion===2?nameDelivery(spec,raw):raw;
 return {spec,delivery:{version:1,...([2,3,4].includes(delivery.namingVersion)?{namingVersion:delivery.namingVersion}:{}),folder:delivery.folder,directories:classified.directories},files:classified.files.map((f,index)=>{
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
    if(spec.category==='six'){
     if(!['正面','背面','左侧','右侧','顶面','底面'].includes(stem))fail('封存失败，六面图文件名不符合规则。');
    }else{
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
 if(spec.category!=='project'&&outputs.length!==spec.expectedCount)fail('最终产物数量应为 '+spec.expectedCount+'，当前为 '+outputs.length);
 if(total>20*1024**3)fail('本次封存总大小不能超过 20 GB，请拆分事项');
 if(spec.category==='six'&&outputs.length!==6)fail('六面图需要完整的 6 个面');
 if(spec.category!=='video'&&spec.category!=='six'&&outputs.length){
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
 constructor(store,nas,products=null){this.store=store;this.nas=nas;this.products=products;this.inflight=new Set()}
 revisionCategory(category,task){
  if(!task.archiveRound)return category;
  const folder='返工-'+task.id+'-'+task.archiveRound;
  return {...category,source:path.join(category.source,folder),output:path.join(category.output,folder)};
 }
 async prepare(task,itemId,actor,payload){
  own(actor,task);if(task.state!==4)fail('运营确认完结后才能上传产物',409);
  const modern=!itemId&&payload.delivery?.version===1,item=modern?task.items[0]:task.items.find(i=>i.id===itemId);if(!item||task.sealed||!modern&&item.sealed)fail('任务不存在或已经封存',409);
  if(payload.selfChecked!==true)fail('请确认源文件可编辑、最终产物与运营确认内容一致');
  const {files,spec,delivery}=modern?validateTaskManifest(task,payload.files,payload.delivery):validateManifest(task,item,payload.files,payload.delivery);
  const assetItem=modern?{...item,category:spec.category}:item;
   await this.nas.ready();const productResolution=this.products?await this.products.confirm(assetItem,payload.productDecision):null,product=await this.nas.productDirectory(assetItem),category=this.revisionCategory(await this.nas.categoryDirectory(product,assetItem,false,[2,3].includes(delivery?.namingVersion)?'flat':!!delivery),task);
   const manifestHash=digest(JSON.stringify(delivery?{files,delivery,productResolution}:files));
  const previous=this.store.all('upload').find(u=>u.taskId===task.id&&u.itemId===(modern?null:itemId)&&u.actor===actor.personId&&u.manifestHash===manifestHash&&(u.archiveRound||0)===(task.archiveRound||0)&&u.status!=='cancelled');
  if(previous)return previous;
  for(const u of this.store.all('upload'))if(u.taskId===task.id&&(modern?u.spec?.category===spec.category:u.itemId===itemId)&&u.status==='publishing')fail('上次封存正在恢复，请使用同一批文件重试');
  for(const f of files){const target=path.join(f.kind==='source'?category.source:category.output,f.relative);await guarded(this.nas.config.assetRoot,path.relative(this.nas.config.assetRoot,target));if(await exists(target)&&await fileHash(target)!==f.sha256)fail('正式库存在同名但内容不同的文件，请确认新版本名称后上传：'+f.name)}
  const id=crypto.randomUUID(),stage=await ensureDir(this.nas.config.assetRoot,'_workbench-staging',id);
   const record={id,archiveRound:task.archiveRound||0,taskId:task.id,itemId:modern?null:itemId,itemIds:modern?[]:task.items.filter(i=>i.category===item.category).map(i=>i.id),actor:actor.personId,manifestHash,files,spec,delivery,productResolution,status:'uploading',received:{},stage,product,category,createdAt:Date.now(),selfCheckedAt:Date.now()};
  const replaced=this.store.all('upload').filter(u=>u.taskId===task.id&&u.actor===actor.personId&&(modern?u.spec?.category===spec.category:u.itemId===itemId)&&u.status==='uploading');
  if(replaced.some(u=>[...this.inflight].some(key=>key.startsWith(u.id+'/'))))fail('该类别仍有文件正在传输，请等待结束后再更换文件');
  this.store.atomic(()=>{for(const u of replaced)this.store.put('upload',u.id,{...u,status:'cancelled',replacedBy:id,error:'已由重新选择的文件替代'});this.store.put('upload',id,record)});return record;
 }
 async receive(uploadId,fileId,actor,stream,length){
  const key=uploadId+'/'+fileId;if(this.inflight.has(key))fail('该文件正在上传',409);
  const record=this.store.get('upload',uploadId),task=record&&this.store.get('task',record.taskId);
  if(!record||record.actor!==actor.personId||actor.role!=='designer')fail('没有此上传权限',403);own(actor,task);
  if((record.archiveRound||0)!==(task.archiveRound||0)||task.state!==4)fail('任务已回退，请重新选择产物',409);
  const file=record.files.find(f=>f.id===fileId);if(!file||record.status!=='uploading')fail('上传状态无效');
  if(Number(length)!==file.size)fail('上传长度不匹配');
  await this.nas.ready();this.inflight.add(key);
  const destination=await guarded(this.nas.config.assetRoot,'_workbench-staging',record.id,file.id+'.part');
  try{
   const starting=this.store.get('upload',uploadId);delete starting.received[fileId];this.store.put('upload',uploadId,starting);
   let received=0;const hash=crypto.createHash('sha256');
   const meter=new Transform({transform(chunk,_encoding,callback){received+=chunk.length;if(received>file.size)return callback(new Error('上传超过声明大小'));hash.update(chunk);callback(null,chunk)}});
   await pipeline(stream,meter,fs.createWriteStream(destination,{flags:'w'}));
   if(received!==file.size||hash.digest('hex')!==file.sha256)fail('上传完整性校验失败，请重试');
   await checkSignature(destination,file.name);
   const latest=this.store.get('upload',uploadId);latest.received[fileId]=Date.now();this.store.put('upload',uploadId,latest);return {received:true};
  }catch(e){if(await exists(destination))await fsp.unlink(destination);throw e}
  finally{this.inflight.delete(key)}
 }
 async commit(uploadId,actor){
  let u=this.store.get('upload',uploadId);if(!u||u.actor!==actor.personId)fail('没有此封存权限',403);
  let task=this.store.get('task',u.taskId);own(actor,task);
  if((u.archiveRound||0)!==(task.archiveRound||0))fail('这是回退前的上传记录，请重新选择产物',409);
  const item=task.items.find(i=>i.id===u.itemId);
  if(u.spec?.folderUploadVersion===2){const done=task.deliveries?.find(d=>d.id===u.id);if(done){await this.finalizeDelivery(u,task,done);return task}return this.commitDelivery(u,task,actor)}
  if(item?.sealed&&item.assetId===u.id){await this.finalize(u,task);return task}
  if(task.state!==4||item.sealed)fail('任务状态已改变',409);
  if(u.files.some(f=>!u.received[f.id]))fail('还有文件尚未上传完整');
  await this.nas.ready();
  const product=await this.nas.productDirectory(item,true),resolvedCategory=this.revisionCategory(await this.nas.categoryDirectory(product,item,true,!!u.delivery),task);
  // An older client may be resuming a flat upload after split folders were added.
  const category=u.delivery?resolvedCategory:{...resolvedCategory,source:u.category.source,output:u.category.output};
  if(product.path!==u.product.path||category.path!==u.category.path)fail('资产目录发生变化，请重新选择文件');
  const publishing=u.status==='publishing';u.status='publishing';u.published??={};this.store.put('upload',u.id,u);
  try{
   for(const d of u.delivery?.directories||[]){const dest=await guarded(this.nas.config.assetRoot,path.relative(this.nas.config.assetRoot,d.kind==='source'?category.source:category.output),d.relative);await fsp.mkdir(dest,{recursive:true})}
   for(const f of u.files){
    const source=await guarded(this.nas.config.assetRoot,'_workbench-staging',u.id,f.id+'.part');
    if(await fileHash(source)!==f.sha256)fail('暂存文件校验失败');
    const dest=await guarded(this.nas.config.assetRoot,path.relative(this.nas.config.assetRoot,f.kind==='source'?category.source:category.output),f.relative);
    await fsp.mkdir(path.dirname(dest),{recursive:true});
    if(await exists(dest)){if(await fileHash(dest)!==f.sha256)fail('正式库同名文件内容不同，未覆盖')}
    else{await fsp.copyFile(source,dest,fs.constants.COPYFILE_EXCL);if(await fileHash(dest)!==f.sha256)fail('资产写入校验失败')}
    u.published[f.id]=dest;this.store.put('upload',u.id,u);
   }
   const next=structuredClone(task),sealTime=Date.now();
   for(const nextItem of next.items.filter(i=>(u.itemIds||[u.itemId]).includes(i.id))){nextItem.sealed=true;nextItem.sealedAt=sealTime;nextItem.assetPath=category.path;nextItem.assetId=u.id;nextItem.productPath=product.path}
   next.sealed=next.items.every(i=>i.sealed);next.updatedAt=Date.now();next.version++;
   const addresses=[...new Set(next.items.filter(i=>i.sealed).map(i=>CATEGORIES.find(c=>c.id===i.category).name+'：'+i.assetPath))].join('\n');
    task=await this.nas.sync(task,next,{L4:addresses},{kind:'sealed',actor:actor.personId,body:{itemId:item.id,assetId:u.id,code:item.code,files:u.files.map(f=>({name:f.name,size:f.size,sha256:f.sha256,path:u.published[f.id]}))}});this.products?.recordArchive(item,product,u.productResolution);
   await this.finalize(u,task);
   return task;
  }catch(e){u.error=e.message;this.store.put('upload',u.id,u);throw e}
 }
 async commitDelivery(u,task,actor){
  if(task.state!==4||task.sealed)fail('任务状态已改变',409);
  if(u.files.some(f=>!u.received[f.id]))fail('还有文件尚未上传完整');
  await this.nas.ready();const item={...task.items[0],category:u.spec.category};
  const product=await this.nas.productDirectory(item,true),category=this.revisionCategory(await this.nas.categoryDirectory(product,item,true,[2,3].includes(u.delivery?.namingVersion)?'flat':true),task);
  if(product.path!==u.product.path||category.path!==u.category.path)fail('资产目录发生变化，请重新选择文件');
  if([3,4].includes(u.delivery?.namingVersion)&&u.spec.category==='main')for(const f of u.files.filter(f=>f.kind==='output')){const file=await guarded(this.nas.config.assetRoot,'_workbench-staging',u.id,f.id+'.part');if(await imageWidth(file)!==f.width)fail('图片实际宽度与预览不一致，请重新选择：'+f.name)}
  const publishing=u.status==='publishing';u.status='publishing';u.published??={};this.store.put('upload',u.id,u);
  try{
   for(const d of u.delivery.directories||[]){const dest=await guarded(this.nas.config.assetRoot,path.relative(this.nas.config.assetRoot,d.kind==='source'?category.source:category.output),d.relative);await fsp.mkdir(dest,{recursive:true})}
   for(const f of u.files){
    const source=await guarded(this.nas.config.assetRoot,'_workbench-staging',u.id,f.id+'.part');
    if(await fileHash(source)!==f.sha256)fail('暂存文件校验失败');
    const dest=await guarded(this.nas.config.assetRoot,path.relative(this.nas.config.assetRoot,f.kind==='source'?category.source:category.output),f.relative);
    await fsp.mkdir(path.dirname(dest),{recursive:true});
    if(await exists(dest)){if(await fileHash(dest)!==f.sha256)fail('正式库同名文件内容不同，未覆盖')}
    else{await fsp.copyFile(source,dest,fs.constants.COPYFILE_EXCL);if(await fileHash(dest)!==f.sha256)fail('资产写入校验失败')}
    u.published[f.id]=dest;this.store.put('upload',u.id,u);
   }
   const next=structuredClone(task),at=Date.now(),delivery={id:u.id,category:u.spec.category,categoryName:u.spec.categoryName,path:category.path,folder:u.spec.base,productPath:product.path,at};
   next.deliveries=[...(next.deliveries||[]),delivery];next.sealed=false;next.updatedAt=at;next.version++;
   const addresses=next.deliveries.map(d=>(CATEGORIES.find(c=>c.id===d.category)?.name||d.categoryName)+'：'+d.path).join('\n');
    task=await this.nas.sync(task,next,{L4:addresses},{kind:'asset-archived',actor:actor.personId,body:{assetId:u.id,category:u.spec.category,code:item.code,files:u.files.map(f=>({name:f.name,size:f.size,sha256:f.sha256,path:u.published[f.id]}))}});this.products?.recordArchive(item,product,u.productResolution);
   await this.finalizeDelivery(u,task,delivery);return task;
  }catch(e){u.error=e.message;this.store.put('upload',u.id,u);throw e}
 }
 async finish(taskId,actor,version){
  const task=this.store.get('task',taskId);if(!task)fail('任务不存在',404);own(actor,task);
  if(task.state!==4||task.sealed)fail('任务尚不能完成封存',409);
  if(version!==task.version)fail('任务已更新，请刷新后重试',409);
  if(!(task.deliveries||[]).length)fail('请先上传至少一类最终产物');
  if(this.store.all('upload').some(u=>u.taskId===task.id&&['uploading','publishing'].includes(u.status)))fail('仍有产物正在上传或等待恢复');
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
  const next=structuredClone(task);next.sealed=true;next.sealedAt=Date.now();next.updatedAt=next.sealedAt;next.version++;
  this.store.atomic(()=>{this.store.put('task',next.id,next);this.store.event('sealed',actor.personId,next.id,{categories:next.deliveries.map(d=>d.category)})});return next;
 }
 async finalize(u,task){
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
   try{await this.commit(candidate.id,{role:'designer',personId:candidate.actor});restored++}
   catch(e){const latest=this.store.get('upload',candidate.id);if(latest&&latest.status!=='done')this.store.put('upload',latest.id,{...latest,error:e.message,retryAt:Date.now()+30000})}
  }
  return restored;
 }
 async recover(){
  for(const u of this.store.all('upload')){
   const task=this.store.get('task',u.taskId),item=task?.items.find(i=>i.id===u.itemId),delivery=task?.deliveries?.find(d=>d.id===u.id);
   if(u.spec?.folderUploadVersion===2&&delivery&&(u.status!=='done'||u.maintenanceError))await this.finalizeDelivery(u,task,delivery);
   else if(item?.sealed&&item.assetId===u.id&&(u.status!=='done'||u.maintenanceError))await this.finalize(u,task);
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
     if(affected){next.sealed=false;delete next.sealedAt;next.updatedAt=now;next.version=(next.version||0)+1}
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
