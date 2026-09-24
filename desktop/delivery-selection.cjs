'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {scanDelivery}=require('./delivery.cjs');
const {inferCategory}=require('../core/naming.cjs');
const {normalizeDeliveryFolder,ignoredDeliveryEntry}=require('../core/delivery.cjs');
const {CATEGORIES}=require('../core/rules.cjs');
const own=(o,k)=>o&&Object.hasOwn(o,k)?o[k]:undefined;
async function planSelection(root,info,getSpec,naming={repair:true}){
 root=path.resolve(root);const stat=await fs.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('请选择一个真实的交付文件夹');
 const leaf=path.basename(root),children=(await fs.readdir(root,{withFileTypes:true})).filter(x=>!ignoredDeliveryEntry(x.name));
 const categoryFor=(name,selected)=>{try{return inferCategory(name,selected)}catch{return null}};
 const rootOverride=own(naming.folders,''),known=categoryFor(leaf,rootOverride?.category);
 const wrappers=children.some(x=>/^(?:\d+[.．])?(?:源文件|导出图片|图片|sources?|outputs?|images?|psd)$/i.test(x.name));
 const single=known||rootOverride?.category||children.some(x=>!x.isDirectory())||wrappers||!children.length;
 const roots=single?[{key:'',root}]:children.map(x=>({key:x.name,root:path.join(root,x.name)}));
 const folders=[],batch=[],files=[],skipped=[],namingIssues=[],seen=new Set();
 for(const entry of roots){
  const originalFolder=path.basename(entry.root),correction=own(naming.folders,entry.key)||{},category=categoryFor(originalFolder,correction.category),normalized=normalizeDeliveryFolder(originalFolder);
  const date=correction.date??(/^\d{4}-/.test(normalized)?normalized.slice(0,4):info.basePrefix.slice(0,4));
  const row={key:entry.key,originalFolder,category:category||'',date,folder:'',namingIssues:[]};
  const problem=(code,message,relativePath)=>{const issue={folderKey:entry.key,code,message,...(relativePath?{relativePath}: {})};row.namingIssues.push(issue);namingIssues.push(issue)};
  folders.push(row);
  if(!category){problem('category','未能确定产物类型，请在下方选择');continue}
  const cat=CATEGORIES.find(c=>c.id===category);
  row.folder=date+info.basePrefix.slice(4)+cat.output;
  if(!info.categories.some(c=>c.id===category)){row.skipped=true;skipped.push(originalFolder);continue}
  if(seen.has(category)){problem('category','同一批次有重复类型，请调整分类或分别上传');continue}seen.add(category);
  try{
   const spec=await getSpec(row.folder),options={repair:naming.repair!==false,outputNames:correction.outputNames||{}};
   const result=await scanDelivery(entry.root,spec,{automatic:true,naming:options,draft:true});
   for(const issue of result.namingIssues||[])problem(issue.code,issue.message,issue.relativePath);
   row.folder=spec.base;const selection={...result,spec,naming:options};batch.push(selection);
   files.push(...result.files.map(({file,mtimeMs,...f})=>({...f,folderKey:entry.key,category,suggestedName:own(options.outputNames,f.relativePath)||path.posix.basename(f.relative),previewFrom:originalFolder+'/'+f.relativePath,previewTo:spec.categoryName+'/'+(f.kind==='source'?'01.源文件':'02.导出图片')+'/'+f.relative})));
  }catch(e){problem('files',e.message)}
 }

 return {batch,preview:{folder:leaf,folders,namingIssues,skipped,categoryCount:batch.length,files,spec:batch[0]?.spec||{},projectFolders:batch.flatMap(s=>s.projectFolders.map(f=>s.folder+'/'+f)),totalSize:batch.reduce((sum,s)=>sum+s.totalSize,0)}};
}
module.exports={planSelection};
