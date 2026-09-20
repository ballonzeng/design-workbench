'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {classifyDelivery,LIMITS,normalizeDeliveryFolder,ignoredDeliveryEntry}=require('../core/delivery.cjs');
const {automaticNames}=require('../core/automatic-names.cjs');const {imageWidth}=require('../core/image-metadata.cjs');
const {guarded}=require('../core/nas.cjs');
async function scanDelivery(root,spec,{automatic=false}={}){
 if(typeof root!=='string'||!path.isAbsolute(root))throw Error('请拖入电脑上的一个完整交付文件夹');
 root=path.resolve(root);
 const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('请拖入整个交付文件夹，不要单独拖文件或快捷方式');
 const folder=normalizeDeliveryFolder(path.basename(root));
 // Validate the name before traversing any contents.
 if(folder!==spec.base)throw Error('交付文件夹命名不符合规则：应为「'+spec.base+'」，当前为「'+folder+'」。日期可用实际交付日期（MMDD），不必与运营确认日一致。');
 const entries=[],directories=[];
 async function walk(relative=''){
  const current=await guarded(root,...relative.split('/').filter(Boolean));
  const children=(await fs.readdir(current,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'));
  for(const child of children){
   if(ignoredDeliveryEntry(child.name))continue;
   const rel=relative?relative+'/'+child.name:child.name;
   if(rel.split('/').length>LIMITS.depth)throw Error('文件夹嵌套过深：'+rel);
   const file=await guarded(root,...rel.split('/')),s=await fs.lstat(file);
   if(s.isSymbolicLink())throw Error('工程中不能包含快捷链接：'+rel);
   if(s.isDirectory()){
    directories.push(rel);if(directories.length>LIMITS.directories)throw Error('交付文件夹的子目录数量超过限制');await walk(rel);
   }else if(s.isFile()){
    entries.push({relativePath:rel,file,size:s.size,mtimeMs:s.mtimeMs});
    if(entries.length>LIMITS.files)throw Error('单次最多上传 '+LIMITS.files+' 个文件');
   }else throw Error('无法上传此类型的文件：'+rel);
  }
 }
 await walk();let result=classifyDelivery(spec,folder,entries,directories);
 if(automatic&&[3,4].includes(spec.namingVersion)){for(const f of result.files)if(f.kind==='output'&&spec.category==='main')f.width=await imageWidth(f.file);result=automaticNames(spec,result)}
 return {...result,root,folder,originalDirectories:directories};
}
module.exports={scanDelivery};
