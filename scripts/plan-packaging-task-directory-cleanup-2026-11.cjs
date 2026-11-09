'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),crypto=require('node:crypto');
const {guarded,fileHash,isInside}=require('../core/nas.cjs');
const IDS=['70bb503d-6fc2-59f1-818e-412a3065d18c','40a9f794-77c4-5942-bcc0-ac6ea9aefc85','ab0f3b5f-ed81-5140-91ef-6226ca972157','930c2b21-9c79-5822-82d6-a4790ba49ef3','24f838da-01ac-5a90-bae0-ff9f84a4730c','db62bd23-151e-588d-a83b-e4cc9a376874'];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex'),fail=s=>{throw Error(s)};
const same=(a,b)=>path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
function remap(value,oldRoot,newRoot){if(typeof value==='string'&&path.isAbsolute(value)&&isInside(oldRoot,value))return path.join(newRoot,path.relative(oldRoot,value));if(Array.isArray(value))return value.map(v=>remap(v,oldRoot,newRoot));if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v,oldRoot,newRoot)]));return value}
async function buildPlans(ctx){
 const records=ctx.snapshot.records,roots=[],transfers=[],updates=[],sidecars=[],targetDirectories=[];
 const get=(kind,id)=>{const r=records.find(x=>x.kind===kind&&x.id===id);if(!r)fail('Missing '+kind+'/'+id);return r};
 for(const id of IDS){
  const task=JSON.parse(get('historicalTask',id).body),hr=get('historicalArchive',id),a=JSON.parse(hr.body),ar=get('asset',a.id),asset=JSON.parse(ar.body);
  if(task.owner!==a.author||a.taskId!==id||a.status!=='archived'||a.source!=='historical-supplement-archive'||a.identification!=='pending-code'||a.category!=='packaging'||a.code!==null||a.product!==task.product)fail('Packaging historical identity changed '+id);
  const expectedProduct=path.join(ctx.assetRoot,'_待69码定位','包装设计',a.product),source=await guarded(ctx.assetRoot,path.relative(ctx.assetRoot,path.join(expectedProduct,'任务-'+id)));
  if(!same(a.productPath,expectedProduct)||!same(a.path,source)||!same(asset.path,source)||asset.taskId!==id||asset.author!==task.owner||JSON.stringify(asset.files)!==JSON.stringify(a.files))fail('Packaging live references differ '+id);
  if(!/^1103-(江雨婷|仇宇航|吕慧芸)-包装设计$/.test(a.deliveryFolder))fail('Unexpected packaging batch name');
  const targetRoot=await guarded(ctx.assetRoot,path.relative(ctx.assetRoot,path.join(expectedProduct,a.deliveryFolder)));
  try{await fsp.lstat(targetRoot);fail('Packaging target already exists '+targetRoot)}catch(e){if(e.code!=='ENOENT')throw e}
  const indexed=new Map(a.files.map(f=>[path.resolve(f.path).toLowerCase(),f])),fileList=[],directories=[''];
  async function walk(dir){for(const e of (await fsp.readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){const p=await guarded(source,path.relative(source,path.join(dir,e.name))),s=await fsp.lstat(p);if(s.isSymbolicLink())fail('Link in packaging source');if(s.isDirectory()){directories.push(path.relative(source,p));await walk(p)}else if(s.isFile()){
    const indexedFile=indexed.get(path.resolve(p).toLowerCase()),target=remap(p,source,targetRoot);
    if(indexedFile){if(s.size!==indexedFile.size)fail('Packaging size mismatch');fileList.push({source:p,size:s.size,sha256:indexedFile.sha256,disposition:'copy'});transfers.push({source:p,target,size:s.size,sha256:indexedFile.sha256});indexed.delete(path.resolve(p).toLowerCase())}
    else if(path.dirname(p)===source&&['_archive-plan.json','_archive-manifest.json'].includes(e.name)){
      const bytes=await fsp.readFile(p),json=JSON.parse(bytes.toString('utf8'));
      if(json.id!==a.id||json.taskId!==id||json.author!==a.author||!same(json.path,source)||json.deliveryFolder!==a.deliveryFolder||JSON.stringify(json.files)!==JSON.stringify(a.files))fail('Packaging sidecar does not match live manifest');
      const oldSha=sha(bytes),next=Buffer.from(JSON.stringify(remap(json,source,targetRoot),null,2));
      fileList.push({source:p,size:bytes.length,sha256:oldSha,disposition:'sidecar'});sidecars.push({source:p,path:target,originalSha256:oldSha,nextBytesBase64:next.toString('base64')});
    }else if(e.name.toLowerCase()==='thumbs.db')fileList.push({source:p,size:s.size,sha256:await fileHash(p),disposition:'cache'});
    else fail('Unindexed packaging file '+p);
   }else fail('Unsupported packaging entry '+p)}}
  await walk(source);if(indexed.size)fail('Missing packaging source files');
  if(fileList.filter(x=>x.disposition==='sidecar').length!==2)fail('Missing packaging sidecars');
  roots.push({source,files:fileList,directories:directories.sort()});
  targetDirectories.push(...directories.map(d=>path.join(targetRoot,d)));
  for(const r of [hr,ar])updates.push({kind:r.kind,id:r.id,originalBody:r.body,nextBody:JSON.stringify(remap(JSON.parse(r.body),source,targetRoot))});
 }
 if(transfers.length!==57||transfers.reduce((s,f)=>s+f.size,0)!==685850386||sidecars.length!==12||updates.length!==12)fail('Packaging scope differs from confirmed 6 archives');
 return {planner:'packaging-task-directory-cleanup-v1',jobs:[{id:'six-pending-packaging-archives',roots,transfers,missing:[],records:updates,workbooks:[],sidecars,targetDirectories:targetDirectories.sort()}]};
}
module.exports={buildPlans,remap};
