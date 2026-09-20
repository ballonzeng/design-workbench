'use strict';
const path=require('node:path');const {nameDelivery}=require('./naming.cjs');const {fail,safeName}=require('./rules.cjs');
function sequence(name){
 const stem=path.posix.basename(name,path.posix.extname(name)).normalize('NFKC').replace(/(?:750|800)(?=主图)/g,'').replace(/(?:750|800)\s*[x×*]\s*\d+/gi,'').replace(/(?:750|800)\s*(?:px|像素)/gi,'');const matches=stem.match(/\d+/g);return matches?Number(matches.at(-1)):null;
}
function automaticNames(spec,raw){
 const names=new Map(),outputs=raw.files.filter(f=>f.kind==='output');
 if(['main','sku','creative'].includes(spec.category)){
  const groups=new Map();for(const f of outputs){const prefix=spec.category==='main'?String(f.width)+'主图':spec.category==='sku'?'SKU':'创意图';if(spec.category==='main'&&![750,800].includes(f.width))fail('主图宽度必须为 750 或 800 像素：'+f.relativePath+'（'+f.width+'px）');if(!groups.has(prefix))groups.set(prefix,[]);groups.get(prefix).push(f)}
  for(const [prefix,list]of groups){const nums=list.map(f=>sequence(f.relativePath));if(spec.category!=='sku'&&list.length>1&&(nums.some(n=>n===null)||new Set(nums).size!==nums.length))fail('图片缺少序号或序号重复，请先明确顺序：'+prefix);list.sort((a,b)=>{const an=sequence(a.relativePath),bn=sequence(b.relativePath);if(an!==bn)return an===null?1:bn===null?-1:an-bn;const ax=a.relativePath.normalize('NFKC'),bx=b.relativePath.normalize('NFKC');return ax<bx?-1:ax>bx?1:a.relativePath<b.relativePath?-1:a.relativePath>b.relativePath?1:0});list.forEach((f,i)=>names.set(f.relativePath,spec.category==='sku'?String(i+1).padStart(2,'0')+'-'+path.posix.basename(f.relativePath,path.posix.extname(f.relativePath))+(/sku/i.test(path.posix.basename(f.relativePath,path.posix.extname(f.relativePath)))?'':'-SKU')+path.posix.extname(f.relativePath):prefix+String(i+1).padStart(2,'0')+path.posix.extname(f.relativePath)))}
 }else if(spec.category==='video'&&outputs.length>1){
  const ordered=[...outputs].sort((a,b)=>{const an=sequence(a.relativePath),bn=sequence(b.relativePath);if(an!==bn)return an===null?1:bn===null?-1:an-bn;return a.relativePath<b.relativePath?-1:a.relativePath>b.relativePath?1:0});ordered.forEach((f,i)=>names.set(f.relativePath,spec.base+String(i+1).padStart(2,'0')+path.posix.extname(f.relativePath)));
 }else if(spec.category==='six'){
  for(const f of outputs){const stem=path.posix.basename(f.relativePath,path.posix.extname(f.relativePath));if(!/^(正面|背面|左侧|右侧|顶面|底面)$/.test(stem))fail('六面图请按实际面命名：'+f.relativePath)}
 }
 // Use the existing source/project naming rules; image paths are restored separately.
 const sources=raw.files.filter(f=>f.kind==='source');const mapped=nameDelivery({...spec,category:'project'},{...raw,files:sources});
 const files=raw.files.map(f=>{
  if(f.kind==='source')return {...f,...mapped.files.find(x=>x.relativePath===f.relativePath)};
  const name=names.get(f.relativePath)||path.posix.basename(f.relativePath),relative=spec.category==='video'?(names.get(f.relativePath)||spec.base+path.posix.extname(name)):spec.base+'/'+name;
  return {...f,name:path.posix.basename(relative),relative};
 });
 const seen=new Set(),dirs=new Map(mapped.directories.map(d=>[d.relative.toLowerCase(),d]));
 for(const f of files){for(const part of f.relative.split('/'))safeName(part,'目标名称');const key=f.relative.toLowerCase();if(seen.has(key))fail('命名后重名，请区分文件后上传：'+f.relative);seen.add(key);const parts=f.relative.split('/');parts.pop();while(parts.length){const relative=parts.join('/');dirs.set(relative.toLowerCase(),{kind:f.kind,relative});parts.pop()}}
 for(const key of dirs.keys())if(seen.has(key))fail('文件与文件夹命名冲突');return {...raw,files,directories:[...dirs.values()]};
}
module.exports={automaticNames,sequence};
