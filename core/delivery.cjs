'use strict';
const path=require('node:path');
const {fail,safeName}=require('./rules.cjs');
const IMAGE_EXT=new Set(['.png','.jpg','.jpeg','.gif']);
const PROJECT_EXT=new Set(['.c4d','.blend','.max','.ma','.mb','.aep','.prproj','.uproject','.unity']);
const LIMITS={files:500,directories:1000,depth:24,fileSize:8*1024**3,totalSize:20*1024**3};
function normalizeDeliveryFolder(value){
 const text=String(value??'').normalize('NFKC').trim().replace(/[‐‑‒–—−_]/g,'-').replace(/\s*-\s*/g,'-');
 const parts=text.split('-');if(parts.length!==3)return text;
 const aliases={sku:'SKU','sku图':'SKU','详情':'详情页','主图':'主图','六面图':'六面图','创意图':'创意图','创意视频':'创意视频','产品视频':'创意视频','包装':'包装设计','包装设计':'包装设计','工程':'工程'};
 parts[2]=aliases[parts[2].toLowerCase()]||parts[2];return parts.join('-');
}
const ignoredDeliveryEntry=name=>['thumbs.db','desktop.ini','.ds_store'].includes(name.toLowerCase())||name.startsWith('._');
function relativePath(value){
 if(typeof value!=='string'||value.includes('\\')||value.split('/').length>LIMITS.depth)fail('交付文件路径无效');
 for(const part of value.split('/'))safeName(part,'文件或子文件夹「'+part+'」');
 return value;
}
// Derive classification on both ends; clients cannot relabel project textures as exports.
function classifyDelivery(spec,folder,entries,directories=[]){
 folder=normalizeDeliveryFolder(folder);
 if(folder!==spec.base)fail('交付文件夹命名不符合规则：应为「'+spec.base+'」，当前为「'+String(folder)+'」。日期可用实际交付日期（MMDD），不必与运营确认日一致。');
 if(!Array.isArray(entries)||!entries.length||entries.length>LIMITS.files)fail('交付文件夹需要包含文件，单次最多 '+LIMITS.files+' 个文件');
 if(!Array.isArray(directories)||directories.length>LIMITS.directories)fail('交付文件夹的子目录数量超过限制');
 const seen=new Set(),dirSet=new Set();
 const register=value=>{relativePath(value);const key=value.toLowerCase();if(seen.has(key))fail('交付文件或目录重名：'+value);seen.add(key)};
 directories.forEach(d=>{register(d);dirSet.add(d)});
 for(const entry of entries){if(!entry)fail('交付文件信息无效');register(entry.relativePath)}
 for(const value of [...directories,...entries.map(f=>f.relativePath)]){
  const parts=value.split('/');parts.pop();while(parts.length){if(!dirSet.has(parts.join('/')))fail('交付文件缺少对应的父目录：'+value);parts.pop()}
 }
 const projectRoots=new Set();
 const rootProject=entries.some(f=>!f.relativePath.includes('/')&&PROJECT_EXT.has(path.posix.extname(f.relativePath).toLowerCase()));
 for(const d of directories){const first=d.split('/')[0];if(rootProject||/^(?:\d+[.．])?(?:源文件|工程|sources?)$/i.test(first))projectRoots.add(first)}
 for(const f of entries)if(f.relativePath.includes('/')&&PROJECT_EXT.has(path.posix.extname(f.relativePath).toLowerCase()))projectRoots.add(f.relativePath.split('/')[0]);
 let total=0;
 const files=entries.map(f=>{
  const name=path.posix.basename(f.relativePath),ext=path.posix.extname(name).toLowerCase();
  const inProject=f.relativePath.includes('/')&&projectRoots.has(f.relativePath.split('/')[0]);
  const output=spec.category!=='project'&&!inProject&&(spec.category==='video'?ext==='.mp4':IMAGE_EXT.has(ext));
  const kind=output?'output':'source';
  if(!Number.isSafeInteger(f.size)||f.size<(output?1:0)||f.size>LIMITS.fileSize)fail('文件大小不符合要求（单个最多 8 GB）：'+f.relativePath);
  total+=f.size;
  return {...f,name,kind,folder,relative:folder+'/'+f.relativePath};
 });
 if(total>LIMITS.totalSize)fail('本次封存总大小不能超过 20 GB，请拆分事项');
 const outputs=files.filter(f=>f.kind==='output'),sources=files.filter(f=>f.kind==='source');
 if(spec.category!=='video'&&!sources.length)fail('交付文件夹中缺少源文件，请一并放入 PSD 或其他源文件');
 if(spec.category!=='project'&&!outputs.length)fail('交付文件夹中没有识别到最终产物（识别到 0 个）。图片识别 PNG / JPG / GIF，创意视频只识别 MP4。工程文件夹内的贴图不计入产物。');
 if(spec.expectedCount!=null&&spec.category!=='project'&&outputs.length!==spec.expectedCount)fail('最终产物数量应为 '+spec.expectedCount+'，识别到 '+outputs.length+'。工程文件夹内的贴图不计入产物。');
 const normalizedDirs=[];
 for(const d of directories){
  const children=files.filter(f=>f.relativePath.startsWith(d+'/')),kinds=new Set(children.map(f=>f.kind));
  if(!kinds.size)kinds.add('source');
  for(const kind of kinds)normalizedDirs.push({kind,relative:folder+'/'+d});
 }
 return {files,directories:normalizedDirs,projectFolders:[...projectRoots].sort(),totalSize:total};
}
module.exports={ignoredDeliveryEntry,normalizeDeliveryFolder,classifyDelivery,relativePath,LIMITS};
