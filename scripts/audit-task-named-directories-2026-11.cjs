'use strict';
// Read-only whole-library directory inventory. Recovery/staging remain internal
// backups; list their roots separately rather than treating them as live assets.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path');
const ROOT='\\\\Kyuan_NAS\\共享产品主图及详情\\00.设计资产库';
const OUT=path.resolve(__dirname,'../outputs/archive-task-directory-cleanup-2026-11-05');
async function main(){
 const queue=[ROOT],matches=[],files=[],errors=[],links=[],internalRoots=[];let dirs=0,active=0;
 const startedAt=Date.now();await fsp.mkdir(OUT,{recursive:true});
 await new Promise(resolve=>{
  const pump=()=>{while(active<4&&queue.length){const dir=queue.shift();active++;(async()=>{
   try{const entries=await fsp.readdir(dir,{withFileTypes:true});dirs++;
    for(const e of entries){const p=path.join(dir,e.name),relative=path.relative(ROOT,p),top=relative.split(path.sep)[0];
     if(e.isSymbolicLink()){links.push(p);continue}
     if(e.isDirectory()){
      if(dir===ROOT&&/^_workbench-(recovery|staging)$/.test(e.name)){internalRoots.push(p);continue}
      if(e.name.includes('任务'))matches.push({path:p,relative,name:e.name,taskId:/^任务-([a-f0-9-]{36})$/i.exec(e.name)?.[1]||null,scope:top==='_待69码定位'?'pending-code':top==='99.停用产品归档'?'retired-products':top==='00.文件规范与模板'?'templates':'ordinary-library'});
      queue.push(p);
     }else if(e.isFile())files.push(p);else errors.push({path:p,error:'unsupported-entry'});
    }
    if(dirs%500===0)console.log(JSON.stringify({phase:'scanning',directories:dirs,files:files.length,matches:matches.length,queued:queue.length}));
   }catch(e){errors.push({path:dir,error:e.message,code:e.code})}
  })().finally(()=>{active--;if(!active&&!queue.length)resolve();else pump()})} };pump();
 });
 const data={schemaVersion:1,mode:'read-only-inventory',assetRoot:ROOT,startedAt,finishedAt:Date.now(),directoriesScanned:dirs,filesListed:files.length,internalRootsNotTraversed:internalRoots,symbolicLinksNotFollowed:links,errors,matches:matches.sort((a,b)=>a.path.localeCompare(b.path,'zh-CN')),files};
 const output=path.join(OUT,'inventory-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');await fsp.writeFile(output,JSON.stringify(data,null,2),{flag:'wx'});
 console.log(JSON.stringify({phase:'complete',output,directories:dirs,files:files.length,matches:data.matches,errors,links},null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1});
