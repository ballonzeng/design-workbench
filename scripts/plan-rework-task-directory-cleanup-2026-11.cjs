'use strict';
// Read-only planner for the one reviewed two-category, round-1 rework task.
// Missing round-0 bytes remain missing; no current file may stand in for them.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {unpack,mergedValue}=require('../core/workbook.cjs');
const {patchWorkbookStable}=require('./task-cleanup-workbook.cjs');
const TASK_ID='13ad2d49-1ff4-4402-8d57-33ee23931cf9';
const PRODUCT='北京同仁堂-足道二十四味泡脚粉碎型 900克(30克／包×30包／袋)-6976575152038';
const IDS={currentMain:'643617e8-b163-49c2-a452-109b0655724b',historicalMain:'9113013e-4719-4421-8a66-2050a7de1c1a',currentSku:'b6db073d-a390-4747-92df-73bafa2793e2'};
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const fail=m=>{throw Error('Rework directory plan: '+m)};
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const inside=(root,p)=>{const r=path.relative(path.resolve(root),path.resolve(p));return r===''||!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep)};
async function stat(p){try{return await fsp.lstat(p)}catch(e){if(e.code==='ENOENT')return null;throw e}}
function relativeParts(value){if(typeof value!=='string'||!value||path.isAbsolute(value))fail('Invalid relative file path');const p=value.split(/[\\/]/);if(p.some(x=>!x||x==='.'||x==='..'))fail('Unsafe relative file path');return p}
function timeSuffix(at){if(!Number.isSafeInteger(at))fail('Missing original delivery time');const d=new Date(at+8*3600000);return [d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds()].map(x=>String(x).padStart(2,'0')).join('')}
function manifest(u){return sha(JSON.stringify({files:u.files,delivery:u.delivery}))}
function pathRefs(v,roots,p=''){let out=[];if(typeof v==='string'&&path.isAbsolute(v)&&roots.some(r=>inside(r,v)))out.push({pointer:p,value:v});else if(v&&typeof v==='object')for(const [k,x]of Object.entries(v))out.push(...pathRefs(x,roots,p+'/'+k.replace(/~/g,'~0').replace(/\//g,'~1')));return out}
function replaceAddresses(value,replacements){let result=value;for(const {from,to}of replacements){const pattern=new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?=$|[\\\\/\\r\\n;；])','gi');result=result.replace(pattern,()=>to)}return result}
const deterministicWorkbookPatch=patchWorkbookStable;

async function buildPlans(ctx){
 if(!ctx?.snapshot?.records||!Array.isArray(ctx.snapshot.records)||typeof ctx.guarded!=='function'||typeof ctx.fileHash!=='function')fail('A read-only snapshot and path/hash helpers are required');
 const {assetRoot,taskRoot}=ctx;if(!path.isAbsolute(assetRoot)||!path.isAbsolute(taskRoot))fail('Absolute configured roots are required');
 const rows=ctx.snapshot.records,index=new Map(rows.map(r=>[r.kind+'\0'+r.id,r]));
 const get=(kind,id)=>{const row=index.get(kind+'\0'+id);if(!row||typeof row.body!=='string')fail('Missing '+kind+'/'+id);const value=JSON.parse(row.body);if(value.id!==id)fail('Record identity differs: '+kind+'/'+id);return {row,value}};
 const {row:taskRow,value:task}=get('task',TASK_ID);
 if(task.state!==4||task.owner!=='chang'||task.sealed!==false||task.archiveRound!==1||task.runningSince||task.blocked||!task.filename)fail('Task is not the reviewed completed, unsealed round-1 task');
 const productRoot=path.join(assetRoot,'同仁堂',PRODUCT),categories=[path.join(productRoot,'02.主图'),path.join(productRoot,'03.SKU')];
 const oldRoots=categories.map(p=>path.join(p,'任务-'+TASK_ID));
 for(const source of oldRoots){await ctx.guarded(assetRoot,path.relative(assetRoot,source));const s=await stat(source);if(!s?.isDirectory()||s.isSymbolicLink())fail('Reviewed directory is missing or is a link: '+source)}
 for(const row of rows){
  if(row.kind==='job'){const j=JSON.parse(row.body);if(!['done','rolled-back'].includes(j.status)&&(j.next?.id===TASK_ID||pathRefs(j,oldRoots).length))fail('An unfinished transaction can replay this task')}
  if(row.kind==='upload'){const u=JSON.parse(row.body);if(u.taskId===TASK_ID&&!Object.values(IDS).includes(row.id))fail('An unreviewed upload belongs to this task');if(['uploading','publishing'].includes(u.status)&&pathRefs(u,oldRoots).length)fail('An upload is active under the reviewed roots')}
  if(row.kind==='asset'&&JSON.parse(row.body).taskId===TASK_ID&&!Object.values(IDS).includes(row.id))fail('An unreviewed asset belongs to this task');
 }
 const specs=[{id:IDS.currentMain,category:0,round:1,count:3},{id:IDS.historicalMain,category:0,round:0,count:2},{id:IDS.currentSku,category:1,round:1,count:6}];
 const changes=new Map(),knownFiles=new Map(),transfers=[],missing=[];
 for(const spec of specs){
  const {row:ur,value:u}=get('upload',spec.id),{row:ar,value:a}=get('asset',spec.id),oldRoot=oldRoots[spec.category],category=categories[spec.category];
  const oldCategory=spec.round?path.join(oldRoot,'返工-'+spec.round):oldRoot,newCategory=spec.round?path.join(category,'返工-'+spec.round):category;
  if(u.taskId!==TASK_ID||a.taskId!==TASK_ID||u.status!=='done'||u.storageLayout!==2||(u.archiveRound||0)!==spec.round||u.maintenanceError||u.spec?.folderUploadVersion!==2||!Array.isArray(u.files)||u.files.length!==spec.count||a.files?.length!==spec.count||Object.keys(u.published||{}).length!==spec.count)fail('Upload/asset shape changed: '+spec.id);
  if(!same(u.category?.path,oldCategory)||!same(u.category?.source,path.join(oldCategory,'01.源文件'))||!same(u.category?.output,path.join(oldCategory,'02.导出图片'))||!same(a.path,oldCategory)||manifest(u)!==u.manifestHash||JSON.stringify(a.delivery)!==JSON.stringify(u.delivery))fail('Category or manifest changed: '+spec.id);
  const nextU=structuredClone(u),nextA=structuredClone(a),base=u.spec.base;
  if(typeof base!=='string'||!base||u.delivery?.folder!==base)fail('Missing original delivery folder');
  const historicalBatch=spec.round===0?base+'-'+timeSuffix(a.at)+'-历史':null;
  const fileIds=new Set();
  for(let i=0;i<u.files.length;i++){
   const f=u.files[i],af=a.files.find(x=>x.id===f.id);if(fileIds.has(f.id))fail('Duplicate file ID');fileIds.add(f.id);
   if(!af||!['source','output'].includes(f.kind)||!Number.isSafeInteger(f.size)||f.size<0||!/^[a-f0-9]{64}$/i.test(f.sha256)||af.name!==f.name||af.kind!==f.kind||af.size!==f.size||af.sha256!==f.sha256||af.relative!==f.relative)fail('Asset/upload file mismatch');
   const parts=relativeParts(f.relative),split=f.kind==='source'?'01.源文件':'02.导出图片';
   const source=path.join(oldCategory,split,...parts);if(!same(af.path,source)||!same(u.published[f.id],source)||!inside(oldRoot,source))fail('Unreviewed original file path');
   let relative=f.relative;
   if(historicalBatch){if(f.kind==='source'){if(parts.length!==1||parts[0]!==f.name)fail('Unexpected historical source structure');relative=path.join(historicalBatch,f.name)}else{if(parts[0]!==base||parts.length<2)fail('Unexpected historical output structure');relative=path.join(historicalBatch,...parts.slice(1))}}
   const target=path.join(newCategory,split,...relativeParts(relative));await ctx.guarded(assetRoot,path.relative(assetRoot,target));if(await stat(target))fail('Destination already exists: '+target);
   const actual=await stat(source);
   if(spec.round===0){if(actual)fail('Previously missing historical bytes reappeared; review before migrating');missing.push({oldPath:source,target,expectedSize:f.size,sha256:f.sha256,assetId:spec.id,uploadId:spec.id,archiveRound:0,preExisting:true,reason:'原始轮次文件在迁移前已缺失；只迁移历史逻辑路径，不恢复或替代内容'})}
   else{if(!actual?.isFile()||actual.isSymbolicLink()||actual.size!==f.size||await ctx.fileHash(source)!==f.sha256)fail('Current archive bytes differ: '+source);const transfer={source,target,size:f.size,sha256:f.sha256};transfers.push(transfer);knownFiles.set(path.resolve(source).toLowerCase(),transfer)}
   nextU.files[i].relative=relative;nextU.published[f.id]=target;const nextFile=nextA.files.find(x=>x.id===f.id);nextFile.relative=relative;nextFile.path=target;
  }
  if(historicalBatch){
   if(!Array.isArray(u.delivery.directories))fail('Missing historical directory manifest');
   nextU.delivery.directories=u.delivery.directories.map(d=>{const p=relativeParts(d.relative);if(d.kind!=='output'||p[0]!==base)fail('Unexpected historical directory manifest');return {...d,relative:path.join(historicalBatch,...p.slice(1))}});
   nextU.delivery.directories.push({kind:'source',relative:historicalBatch});nextA.delivery=structuredClone(nextU.delivery);
  }
  nextU.storageLayout=3;nextU.category={...nextU.category,path:newCategory,source:path.join(newCategory,'01.源文件'),output:path.join(newCategory,'02.导出图片')};nextU.manifestHash=manifest(nextU);nextA.path=newCategory;
  if(pathRefs(nextU,oldRoots).length||pathRefs(nextA,oldRoots).length)fail('Unmapped upload/asset path remains');
  changes.set('asset\0'+spec.id,{kind:'asset',id:spec.id,originalBody:ar.body,nextBody:JSON.stringify(nextA)});
  changes.set('upload\0'+spec.id,{kind:'upload',id:spec.id,originalBody:ur.body,nextBody:JSON.stringify(nextU)});
 }
 const nextTask=structuredClone(task),currentIds=[IDS.currentMain,IDS.currentSku];
 if(task.deliveries?.length!==2||new Set(task.deliveries.map(d=>d.id)).size!==2||task.deliveries.some(d=>!currentIds.includes(d.id)))fail('Current delivery identity changed');
 for(const delivery of nextTask.deliveries){const category=delivery.id===IDS.currentMain?0:1;if(!same(delivery.path,path.join(oldRoots[category],'返工-1')))fail('Current delivery path changed');delivery.path=path.join(categories[category],'返工-1')}
 let historicalReferences=0;
 for(const history of nextTask.deliveryHistory||[])for(const delivery of history.deliveries||[]){if(delivery.id===IDS.historicalMain){if(!same(delivery.path,oldRoots[0]))fail('Historical delivery path changed');delivery.path=categories[0];historicalReferences++}else if(pathRefs(delivery,oldRoots).length)fail('Unreviewed historical delivery')}
 if(historicalReferences!==1||pathRefs(nextTask,oldRoots).length)fail('Historical delivery relationship changed or an unmapped task path remains');
 const roots=[];
 for(const source of oldRoots){
  const directories=[''],files=[];
  async function visit(p){for(const ent of (await fsp.readdir(p,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){const q=path.join(p,ent.name);await ctx.guarded(assetRoot,path.relative(assetRoot,q));if(ent.isSymbolicLink())fail('A link exists in the source tree');if(ent.isDirectory()){directories.push(path.relative(source,q));await visit(q)}else if(ent.isFile()){const f=knownFiles.get(path.resolve(q).toLowerCase()),s=await fsp.lstat(q);if(f){files.push({source:q,size:f.size,sha256:f.sha256,disposition:'copy'})}else if(ent.name.toLowerCase()==='thumbs.db'){files.push({source:q,size:s.size,sha256:await ctx.fileHash(q),disposition:'cache'})}else fail('An unreviewed file exists: '+q)}else fail('Unsupported directory entry')}}
  await visit(source);directories.sort();files.sort((a,b)=>a.source<b.source?-1:a.source>b.source?1:0);roots.push({source,files,directories});
 }
 if(roots.reduce((n,r)=>n+r.files.filter(f=>f.disposition==='copy').length,0)!==9||transfers.length!==9||missing.length!==2)fail('Reviewed file counts changed');
 const workbook=await ctx.guarded(taskRoot,'5.已完结',task.filename),bytes=await fsp.readFile(workbook);if(sha(bytes)!==task.workbookHash)fail('Original workbook hash changed');
 const replacements=oldRoots.map((from,i)=>({from,to:categories[i]})),l4=String(mergedValue(unpack(bytes).status,'L4')??''),updated=replaceAddresses(l4,replacements);
 if(updated===l4||oldRoots.some(p=>updated.toLowerCase().includes(p.toLowerCase())))fail('Original workbook archive address is not the reviewed two-root layout');
 const patched=deterministicWorkbookPatch(bytes,{L4:updated});if(String(mergedValue(unpack(patched).status,'L4')??'')!==updated)fail('Workbook L4 patch did not preserve its requested value');
 nextTask.workbookHash=sha(patched);changes.set('task\0'+TASK_ID,{kind:'task',id:TASK_ID,originalBody:taskRow.body,nextBody:JSON.stringify(nextTask)});
 // Historical jobs, request caches, events and task_versions are evidence, not
 // live lookup paths. Only the task and these three asset/upload pairs change.
 for(const row of rows.filter(r=>['task','asset','upload'].includes(r.kind))){if(changes.has(row.kind+'\0'+row.id))continue;if(pathRefs(JSON.parse(row.body),oldRoots).length)fail('Another live record references a reviewed directory')}
 const records=[...changes.values()].sort((a,b)=>(a.kind+'\0'+a.id)<(b.kind+'\0'+b.id)?-1:1);transfers.sort((a,b)=>a.source<b.source?-1:1);missing.sort((a,b)=>a.oldPath<b.oldPath?-1:1);
 return {planner:'rework-task-directory-cleanup-2026-11',jobs:[{id:'rework-'+TASK_ID,roots,transfers,missing,records,workbooks:[{path:workbook,sha256:sha(bytes),replacements}],sidecars:[]}]};
}
module.exports={buildPlans,deterministicWorkbookPatch,TASK_ID,PRODUCT,IDS};
