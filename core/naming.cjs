'use strict';
const path=require('node:path');
const {fail,CATEGORIES,safeName}=require('./rules.cjs');
function inferCategory(text,selected){
 if(selected){if(!CATEGORIES.some(c=>c.id===selected))fail('请选择有效产物类型');return selected}
 const patterns={main:/主图/,sku:/sku/i,detail:/详情/,six:/六面|正面|背面|左侧|右侧|顶面|底面/,creative:/创意图/,video:/视频|\.mp4/i,project:/c4d|刀版|工程/i};
 const found=Object.entries(patterns).filter(([,re])=>re.test(text)).map(([id])=>id);
 if(found.length!==1)fail(found.length?'识别到多个产物类型，请选择本次上传类型，或分成不同文件夹上传':'未识别产物类型，请选择主图、详情页、SKU 等类型后重试');return found[0];
}
function nameDelivery(spec,classified,{repair=false}={}){
 const prefix=spec.base.slice(0,spec.base.lastIndexOf('-')+1),roots=new Set(classified.projectFolders),projectExt=/\.(c4d|blend|max|ma|mb|aep|prproj|uproject|unity)$/i;
 const rootProject=classified.files.find(f=>!f.relativePath.includes('/')&&projectExt.test(f.relativePath));
 const rootName=rootProject?prefix+path.posix.extname(rootProject.relativePath).slice(1).toLowerCase():null;
 const mappedRoot=root=>{const engine=classified.files.find(f=>f.relativePath.startsWith(root+'/')&&projectExt.test(f.relativePath));return prefix+(engine?path.posix.extname(engine.relativePath).slice(1).toLowerCase():root.startsWith(prefix)?root.slice(prefix.length):root)};
 const rootNames=new Map([...roots].map(root=>[root,mappedRoot(root)]));
 if(!rootName&&new Set(rootNames.values()).size!==roots.size){
  if(!repair)fail('多个工程文件夹规范命名后重名，请分别上传，避免工程引用混用');
  const groups=new Map();for(const [root,name]of rootNames){if(!groups.has(name))groups.set(name,[]);groups.get(name).push(root)}
  for(const [name,list]of groups)if(list.length>1)list.sort().forEach((root,i)=>rootNames.set(root,name+'-'+String(i+1).padStart(2,'0')));
 }
 const seen=new Set();
 const files=classified.files.map(f=>{
  const ext=path.posix.extname(f.relativePath),stem=path.posix.basename(f.relativePath,ext),first=f.relativePath.split('/')[0];let relative;
  if(f.kind==='output'){
   if(spec.category==='video')relative=spec.base+ext;
   else{
    const patterns={main:/^主图\d{2}$/,sku:/^SKU\d{2}$/,creative:/^创意图\d{2}$/,six:/^(正面|背面|左侧|右侧|顶面|底面)$/};
    const valid=spec.category==='six'||(spec.category==='detail'?stem.startsWith(spec.product+'-详情')&&/^\d{2}$/.test(stem.slice((spec.product+'-详情').length)):patterns[spec.category]?.test(stem));
    if(!valid)fail('图片名不符合画板规则：'+f.relativePath+'。请从源文件按正确画板名重新导出，程序不会二次重命名图片');
    relative=spec.base+'/'+path.posix.basename(f.relativePath);
   }
  }else if(rootName)relative=rootName+'/'+f.relativePath;
  else if(f.relativePath.includes('/')&&roots.has(first))relative=rootNames.get(first)+f.relativePath.slice(first.length);
  else relative=prefix+(/\.ai$/i.test(ext)&&/刀版/.test(stem)?'刀版':spec.base.slice(prefix.length))+ext;
  for(const part of relative.split('/'))safeName(part,'目标名称');
  const key=relative.toLowerCase();if(!repair&&seen.has(key))fail('规范命名后重名：'+relative+'。请拆分不同版本或类型后上传');seen.add(key);
  return {...f,name:path.posix.basename(relative),relative};
 });
 if(repair){
  const groups=new Map();for(const f of files){const key=f.relative.toLowerCase();if(!groups.has(key))groups.set(key,[]);groups.get(key).push(f)}
  for(const list of groups.values())if(list.length>1){
   // Rename standalone sources only; referenced engine children keep their names.
   if(list.some(f=>f.kind!=='source'||rootName||(f.relativePath.includes('/')&&roots.has(f.relativePath.split('/')[0]))))fail('工程内部文件命名冲突，请检查原文件：'+list[0].relative);
   list.sort((a,b)=>a.relativePath<b.relativePath?-1:a.relativePath>b.relativePath?1:0).forEach((f,i)=>{const ext=path.posix.extname(f.relative);f.relative=f.relative.slice(0,ext?-ext.length:undefined)+'-'+String(i+1).padStart(2,'0')+ext;f.name=path.posix.basename(f.relative)});
  }
  seen.clear();for(const f of files){for(const part of f.relative.split('/'))safeName(part,'目标名称');const key=f.relative.toLowerCase();if(seen.has(key))fail('规范命名后重名：'+f.relative);seen.add(key)}
 }
 const dirs=new Map();
 for(const f of files){const parts=f.relative.split('/');parts.pop();while(parts.length){const relative=parts.join('/');dirs.set(relative.toLowerCase(),{kind:f.kind,relative});parts.pop()}}
 for(const d of classified.directories||[]){const raw=d.relative.slice(spec.base.length+1),first=raw.split('/')[0];if(rootName||roots.has(first)){const relative=rootName?rootName+'/'+raw:rootNames.get(first)+raw.slice(first.length);dirs.set(relative.toLowerCase(),{kind:'source',relative})}}
 for(const key of dirs.keys())if(seen.has(key))fail('规范命名后文件与文件夹重名，请调整后重新上传');
 return {files,directories:[...dirs.values()]};
}
module.exports={inferCategory,nameDelivery};
