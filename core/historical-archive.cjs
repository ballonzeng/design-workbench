'use strict';
// Copy-only archives for confirmed historical records that have no workbook.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const R=require('./rules.cjs'),{guarded,fileHash,folderName,isInside}=require('./nas.cjs'),{isHistoricalTask}=require('./historical-tasks.cjs');
const IMAGES=new Set(['.png','.jpg','.jpeg','.gif']),PENDING='_待69码定位',SOURCE='historical-supplement-archive';
const LIMITS={files:500,directories:1000,depth:24,fileSize:8*1024**3,totalSize:20*1024**3};
const stable=(a,b)=>a<b?-1:a>b?1:0;
const uuid=value=>{const b=crypto.createHash('sha256').update(value).digest().subarray(0,16);b[6]=(b[6]&15)|80;b[8]=(b[8]&63)|128;const h=b.toString('hex');return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20)};
function validDate(value){const d=typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)?new Date(value+'T12:00:00Z'):new Date(NaN);if(!Number.isFinite(+d)||d.toISOString().slice(0,10)!==value)R.fail('归档日期须为有效的 YYYY-MM-DD');return value}
function relative(value){if(typeof value!=='string'||!value||path.isAbsolute(value)||value.includes('\\')||value.split('/').some(p=>!p||p==='.'||p==='..'||/[<>:"|?*\x00-\x1f]/.test(p))||value.split('/').length>LIMITS.depth)R.fail('文件相对路径无效');return value}
async function inventory(root,{hash=true}={}){
 const stat=await fsp.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())R.fail('源目录必须是真实文件夹，不能为链接');await guarded(root);
 const files=[],directories=[];let size=0;
 async function walk(rel=''){
  const dir=await guarded(root,...rel.split('/').filter(Boolean)),entries=(await fsp.readdir(dir,{withFileTypes:true})).sort((a,b)=>stable(a.name,b.name));
  for(const entry of entries){
   const sub=relative(rel?rel+'/'+entry.name:entry.name),file=await guarded(root,...sub.split('/')),before=await fsp.lstat(file);
   if(before.isSymbolicLink())R.fail('源目录不能包含链接：'+sub);
   if(before.isDirectory()){directories.push(sub);if(directories.length>LIMITS.directories)R.fail('源目录的子目录过多');await walk(sub)}
   else if(before.isFile()){
    size+=before.size;if(files.length>=LIMITS.files||before.size>LIMITS.fileSize||size>LIMITS.totalSize)R.fail('归档最多 500 个文件，单文件 8 GB，总计 20 GB');
    const sha256=hash?await fileHash(file):undefined,after=await fsp.lstat(file);
    if(!after.isFile()||after.isSymbolicLink()||before.size!==after.size||before.mtimeMs!==after.mtimeMs)R.fail('源文件在核对期间发生变化：'+sub);
    files.push({relativePath:sub,sourcePath:file,size:before.size,mtimeMs:before.mtimeMs,...(sha256?{sha256}:{})});
   }else R.fail('源目录包含不支持的文件类型：'+sub);
  }
 }
 await walk();if(!files.length)R.fail('源目录没有可归档文件');return {files,directories,totalSize:size};
}
function archiveId(plan){return uuid('historical-archive:v1:'+JSON.stringify([plan.taskId,plan.sourceRoot.toLowerCase(),plan.files.map(f=>[f.relativePath,f.kind,f.size,f.sha256])]))}
async function expectedRoots({assetRoot,taskId,product,identification,productPath,code,brand,author,archiveDate,deliveryFolder}){
 if(typeof assetRoot!=='string'||!path.isAbsolute(assetRoot)||typeof taskId!=='string'||!/^[a-f0-9-]{36}$/i.test(taskId))R.fail('资产目录或历史任务编号无效');
 const root=path.resolve(assetRoot);await guarded(root);const stat=await fsp.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())R.fail('资产库不是有效目录');
 validDate(archiveDate);const person=R.PEOPLE.find(p=>p.id===author),batch=archiveDate.slice(5,7)+archiveDate.slice(8,10)+'-'+person?.name+'-包装设计';
 if(!person||deliveryFolder!==batch)R.fail('历史包装交付批次不一致');
 if(identification==='pending-code'){
  const expectedProduct=await guarded(root,PENDING,'包装设计',folderName(product));
  if(productPath&&path.resolve(productPath)!==expectedProduct)R.fail('待定位产品目录不一致');
  return {productPath:expectedProduct,path:await guarded(root,PENDING,'包装设计',folderName(product),batch)};
 }
 if(identification!=='barcode-verified'||!R.validCode(code)||typeof productPath!=='string'||!path.isAbsolute(productPath)||!path.basename(productPath).endsWith('-'+code))R.fail('正式归档需要真实69码及已核对产品目录');
 const resolved=await guarded(root,path.relative(root,path.resolve(productPath))),pstat=await fsp.lstat(resolved);
 if(!pstat.isDirectory()||pstat.isSymbolicLink()||!isInside(root,resolved)||path.dirname(path.dirname(resolved))!==root||path.basename(path.dirname(resolved))!==brand)R.fail('正式产品目录与品牌或资产库不匹配');
 return {productPath:resolved,path:await guarded(root,path.relative(root,resolved),'07.包装设计',batch)};
}
async function planHistoricalArchive(task,{sourceRoot,assetRoot,archiveDate,productRoot=null,brand=null,code=null}={}){
 if(!isHistoricalTask(task))R.fail('只能为已确认的历史补录记录归档');
 if(typeof sourceRoot!=='string'||!path.isAbsolute(sourceRoot))R.fail('请选择源文件夹的完整路径');
 validDate(archiveDate);const person=R.PEOPLE.find(p=>p.id===task.owner);if(!person)R.fail('设计师资料不完整');
 if(code!==null&&!R.validCode(code)||productRoot&&!R.validCode(code))R.fail('正式归档必须填写真实的13位69码');
 if(code!==null&&!productRoot)R.fail('已提供69码时，请同时选择已核对的真实产品目录');
 const identification=productRoot?'barcode-verified':'pending-code',actualBrand=productRoot?path.basename(path.dirname(path.resolve(productRoot))):(brand||task.brand||null);
 if(productRoot&&brand!==null&&brand!==actualBrand)R.fail('提供的品牌与真实产品目录不一致');
 const deliveryFolder=archiveDate.slice(5,7)+archiveDate.slice(8,10)+'-'+person.name+'-包装设计';
 const base={taskId:task.id,assetRoot:path.resolve(assetRoot),sourceRoot:path.resolve(sourceRoot),product:task.product,identification,code:productRoot?code:null,brand:actualBrand,productPath:productRoot?path.resolve(productRoot):null,author:task.owner,archiveDate,deliveryFolder};
 const roots=await expectedRoots(base);if(isInside(base.sourceRoot,roots.path)||isInside(roots.path,base.sourceRoot))R.fail('源文件夹与归档目标不能相互包含');
 const scanned=await inventory(base.sourceRoot);
 const files=[];
 for(const [index,f] of scanned.files.entries()){
  const kind=IMAGES.has(path.posix.extname(f.relativePath).toLowerCase())?'output':'source',rel=deliveryFolder+'/'+f.relativePath,dest=await guarded(base.assetRoot,path.relative(base.assetRoot,roots.path),kind==='source'?'01.源文件':'02.导出图片',...rel.split('/'));
  files.push({...f,id:String(index),name:path.posix.basename(f.relativePath),kind,relative:rel,path:dest});
 }
 const directories=[];
 for(const dir of scanned.directories){const kinds=new Set(files.filter(f=>f.relativePath.startsWith(dir+'/')).map(f=>f.kind));if(!kinds.size)kinds.add('source');for(const kind of kinds){const rel=deliveryFolder+'/'+dir;directories.push({kind,relative:rel,path:await guarded(base.assetRoot,path.relative(base.assetRoot,roots.path),kind==='source'?'01.源文件':'02.导出图片',...rel.split('/'))})}}
 const plan={...base,...roots,author:task.owner,archiveDate,deliveryFolder,files,directories,originalDirectories:scanned.directories,totalSize:scanned.totalSize,fileCount:files.length,pendingReason:identification==='pending-code'?'尚无真实69码，已独立保存，等待确认后定位正式产品库':null};
 plan.id=archiveId(plan);return plan;
}
const fileIndex=files=>files.map(f=>Object.fromEntries(['id','name','kind','relativePath','relative','size','sha256','path'].map(k=>[k,f[k]])));
function canonical(plan){return {id:plan.id,taskId:plan.taskId,status:'archived',identification:plan.identification,source:SOURCE,sourceRoot:plan.sourceRoot,path:plan.path,productPath:plan.productPath,brand:plan.brand,code:plan.code,product:plan.product,author:plan.author,category:'packaging',archiveDate:plan.archiveDate,deliveryFolder:plan.deliveryFolder,files:fileIndex(plan.files),directories:plan.directories,totalSize:plan.totalSize,fileCount:plan.files.length,pendingReason:plan.pendingReason}}
async function assertInventory(plan){
 const current=await inventory(plan.sourceRoot,{hash:false}),shape=v=>v.map(f=>[f.relativePath,f.size,f.mtimeMs]);
 if(JSON.stringify(shape(current.files))!==JSON.stringify(shape(plan.files))||JSON.stringify(current.directories)!==JSON.stringify(plan.originalDirectories))R.fail('源文件夹在预览后发生变化，请重新核对归档清单');
}
async function verifySource(plan,file){
 const source=await guarded(plan.sourceRoot,...relative(file.relativePath).split('/')),s=await fsp.lstat(source);
 if(!s.isFile()||s.isSymbolicLink()||s.size!==file.size||s.mtimeMs!==file.mtimeMs||await fileHash(source)!==file.sha256)R.fail('源文件在预览后发生变化：'+file.relativePath);
 return source;
}
async function verifyDestination(plan,file){
 const dest=await guarded(plan.assetRoot,path.relative(plan.assetRoot,file.path)),s=await fsp.lstat(dest);
 if(!s.isFile()||s.isSymbolicLink()||s.size!==file.size||await fileHash(dest)!==file.sha256)R.fail('归档目标同名文件内容不同或校验失败，未覆盖：'+file.relativePath);
 return dest;
}
async function immutableJson(file,value,identity){
 try{await fsp.writeFile(file,JSON.stringify(value,null,2),{flag:'wx'});return value}
 catch(e){if(e.code!=='EEXIST')throw e;let saved;try{saved=JSON.parse(await fsp.readFile(file,'utf8'))}catch{R.fail('已有归档清单无法读取，未覆盖')}
  if(JSON.stringify(identity(saved))!==JSON.stringify(identity(value)))R.fail('已有归档清单与本批文件不一致，未覆盖');return saved;
 }
}
async function archiveHistoricalPlan(plan){
 if(!plan||typeof plan!=='object'||!Array.isArray(plan.files)||!plan.files.length||plan.files.length>LIMITS.files||archiveId(plan)!==plan.id)R.fail('归档计划无效或已变化');
 validDate(plan.archiveDate);const roots=await expectedRoots(plan);if(roots.path!==plan.path||roots.productPath!==plan.productPath)R.fail('归档计划的目标路径不一致');
 if(isInside(plan.sourceRoot,plan.path)||isInside(plan.path,plan.sourceRoot))R.fail('源文件夹与归档目标不能相互包含');
 for(const f of plan.files){
  relative(f.relativePath);if(!['source','output'].includes(f.kind)||!/^[a-f0-9]{64}$/.test(f.sha256)||!Number.isSafeInteger(f.size)||f.size<0)R.fail('归档文件信息无效');
  const expected=await guarded(plan.assetRoot,path.relative(plan.assetRoot,plan.path),f.kind==='source'?'01.源文件':'02.导出图片',...relative(plan.deliveryFolder+'/'+f.relativePath).split('/'));
  if(f.path!==expected||f.relative!==plan.deliveryFolder+'/'+f.relativePath)R.fail('归档文件路径超出固定布局');
 }
 for(const d of plan.directories){if(!['source','output'].includes(d.kind))R.fail('归档目录类型无效');const expected=await guarded(plan.assetRoot,path.relative(plan.assetRoot,plan.path),d.kind==='source'?'01.源文件':'02.导出图片',...relative(d.relative).split('/'));if(d.path!==expected)R.fail('归档目录路径不一致')}
 await assertInventory(plan);await fsp.mkdir(plan.path,{recursive:true});const intent={...canonical(plan),status:'planned'},intentPath=await guarded(plan.assetRoot,path.relative(plan.assetRoot,plan.path),'_archive-plan.json'),manifestPath=await guarded(plan.assetRoot,path.relative(plan.assetRoot,plan.path),'_archive-manifest.json');
 await immutableJson(intentPath,intent,v=>v); // A permanent intent prevents a different batch from mixing into this task directory.
 for(const d of plan.directories){await guarded(plan.assetRoot,path.relative(plan.assetRoot,d.path));await fsp.mkdir(d.path,{recursive:true})}
 for(const f of plan.files){
  const source=await verifySource(plan,f),dest=await guarded(plan.assetRoot,path.relative(plan.assetRoot,f.path));await fsp.mkdir(path.dirname(dest),{recursive:true});
  try{await fsp.copyFile(source,dest,fs.constants.COPYFILE_EXCL)}catch(e){if(e.code!=='EEXIST')throw e}
  await verifyDestination(plan,f);await verifySource(plan,f);
 }
 await assertInventory(plan);for(const f of plan.files)await verifyDestination(plan,f);
 const record={...intent,status:'archived',at:Date.now(),manifestPath},withoutTime=value=>{const {at,manifestPath,...rest}=value;return rest};
 return immutableJson(manifestPath,record,withoutTime);
}
module.exports={planHistoricalArchive,archiveHistoricalPlan};
