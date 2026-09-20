'use strict';
const fsp=require('node:fs').promises;const path=require('node:path');const crypto=require('node:crypto');
const {fail,safeName,validCode}=require('./rules.cjs');const {exists,guarded,folderName}=require('./nas.cjs');

function normalized(value){
 return String(value??'').normalize('NFKC').toLowerCase().replace(/[\s·•・,，.。:：;；_—–\-\/\\|｜()[\]（）【】{}]+/g,'').replace(/新版|升级版|新包装|经典版|旗舰版/g,'').trim();
}
function splitProductName(value){
 const original=String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();let base=original,spec='';
 const bracket=base.match(/\s*[（(【[]([^）)】\]]{1,30})[）)】\]]\s*$/);
 if(bracket){spec=bracket[1].trim();base=base.slice(0,bracket.index).trim()}
 const suffix=base.match(/(?:\s*[-_/]?\s*)((?:\d+(?:\.\d+)?\s*(?:mg|g|kg|ml|l|克|千克|毫升|升|粒|片|袋|支|瓶|盒|包|贴|对|条|枚|抽|罐|板))(?:\s*[×x*]\s*\d+\s*(?:粒|片|袋|支|瓶|盒|包|贴|对|条|枚|抽|罐|板)?)?)\s*$/i);
 if(suffix&&suffix.index>0){spec=[suffix[1],spec].filter(Boolean).join(' · ');base=base.slice(0,suffix.index).trim()}
 return {original,base:base||original,spec};
}
function dice(a,b){
 a=normalized(a);b=normalized(b);if(a===b)return 1;if(!a||!b)return 0;if(a.includes(b)||b.includes(a))return Math.min(a.length,b.length)>=3?.9:.75;
 const grams=value=>{const out=[];for(let i=0;i<value.length-1;i++)out.push(value.slice(i,i+2));return out},left=grams(a),right=grams(b);if(!left.length||!right.length)return 0;
 const counts=new Map();for(const gram of left)counts.set(gram,(counts.get(gram)||0)+1);let common=0;for(const gram of right)if(counts.get(gram)){common++;counts.set(gram,counts.get(gram)-1)}return 2*common/(left.length+right.length);
}
function cleanAliases(values,canonical){
 const list=Array.isArray(values)?values:String(values??'').split(/[\n,，]/);const seen=new Set([normalized(canonical)]),result=[];
 for(const raw of list){const value=String(raw).normalize('NFKC').replace(/\s+/g,' ').trim();if(!value)continue;safeName(value,'产品别名');const key=normalized(value);if(!key||seen.has(key))continue;seen.add(key);result.push(value)}return result.slice(0,30);
}
const groupView=group=>({...group,variantCount:(group.variants||[]).length,variants:(group.variants||[]).slice().sort((a,b)=>a.code.localeCompare(b.code))});

class Products{
 constructor(store,nas){this.store=store;this.nas=nas}
 all(){return this.store.all('productGroup').map(groupView).sort((a,b)=>a.brand.localeCompare(b.brand,'zh-CN')||a.canonicalName.localeCompare(b.canonicalName,'zh-CN'))}
 group(id){return this.store.get('productGroup',id)}
 create(brand,name,now=Date.now(),preserveFullName=false){
  safeName(brand,'品牌');const split=splitProductName(name),canonicalName=folderName(preserveFullName?split.original:split.base);return {id:crypto.randomUUID(),brand,canonicalName,aliases:[],variants:[],createdAt:now,updatedAt:now};
 }
 findCode(code){return this.all().flatMap(group=>(group.variants||[]).filter(variant=>variant.code===code).map(variant=>({group,variant}))) }
 put(group){group.updatedAt=Date.now();this.store.put('productGroup',group.id,group);return groupView(group)}
 addVariant(group,entry){
  const variants=(group.variants||[]).filter(variant=>variant.code!==entry.code);variants.push({...entry,lastSeenAt:Date.now()});group.variants=variants;return this.put(group);
 }
 async discoveries(){
  const found=[];
  if(this.nas.config?.assetRoot){
   const root=this.nas.config.assetRoot;
   for(const brandEntry of await fsp.readdir(root,{withFileTypes:true})){
    if(!brandEntry.isDirectory()||/^(00\.|99\.|#|_|[.])/.test(brandEntry.name))continue;
    const brandDir=await guarded(root,brandEntry.name);
    for(const productEntry of await fsp.readdir(brandDir,{withFileTypes:true})){
     if(!productEntry.isDirectory())continue;const match=productEntry.name.match(/^(.+)-(69\d{11})$/);if(!match)continue;
     found.push({brand:brandEntry.name,name:match[1],code:match[2],path:path.join(brandDir,productEntry.name),source:'nas'});
    }
   }
  }
  for(const asset of this.store.all('asset')){
   if(!validCode(asset.code)||!asset.brand)continue;let product=String(asset.product||'').replace(new RegExp('-'+asset.code+'$'),'');let productPath=asset.productPath;
   if(!productPath&&asset.path&&this.nas.config?.assetRoot){const relative=path.relative(this.nas.config.assetRoot,asset.path).split(path.sep);if(relative.length>=2)productPath=path.join(this.nas.config.assetRoot,relative[0],relative[1])}
   found.push({brand:asset.brand,name:product||path.basename(productPath||'', '-'+asset.code),code:asset.code,path:productPath||null,source:'record'});
  }
  const unique=new Map();for(const item of found){const key=item.brand.toLowerCase()+'|'+item.code;const previous=unique.get(key);if(!previous||item.source==='nas')unique.set(key,item)}return [...unique.values()];
 }
 indexReady(){return this.store.get('setting','productIndex')?.root===(this.nas.config?.assetRoot||null)}
 async sync({force=false}={}){
  const root=this.nas.config?.assetRoot||null,cached=this.store.get('setting','productIndex');
  if(!force&&cached?.root===root)return this.all();
  const found=await this.discoveries(),groups=this.store.all('productGroup'),byCode=new Map(),byName=new Map(),dirty=new Map();
  const nameKey=(brand,name)=>normalized(brand)+'|'+normalized(name);
  const indexGroup=group=>{for(const name of [group.canonicalName,...(group.aliases||[])]){const key=nameKey(group.brand,name),list=byName.get(key)||[];if(!list.includes(group))list.push(group);byName.set(key,list)}};
  for(const group of groups){indexGroup(group);for(const variant of group.variants||[]){const list=byCode.get(variant.code)||[];list.push({group,variant});byCode.set(variant.code,list)}}
  for(const item of found){
   const exact=byCode.get(item.code)||[];if(exact.length>1)continue;
   let group,variant;
   if(exact.length){({group,variant}=exact[0])}
   else{const same=byName.get(nameKey(item.brand,splitProductName(item.name).base))||[];group=same.length===1?same[0]:this.create(item.brand,splitProductName(item.name).base);if(!groups.includes(group)){groups.push(group);indexGroup(group)}variant={code:item.code};group.variants.push(variant);byCode.set(item.code,[{group,variant}])}
   const next={...variant,name:item.name||variant.name,spec:splitProductName(item.name||variant.name).spec,path:item.path||variant.path||null};
   if(JSON.stringify(next)!==JSON.stringify(variant)){Object.assign(variant,next,{lastSeenAt:Date.now()});dirty.set(group.id,group)}
  }
  this.store.atomic(()=>{for(const group of dirty.values())this.put(group);this.store.put('setting','productIndex',{root,at:Date.now()})});
  this.lastScanAt=Date.now();return this.all();
 }
 async match(item){
  if(!validCode(item.code))fail('产品69码无效');await this.sync();
  const exact=this.findCode(item.code);if(exact.length>1)fail('产品索引中同一69码属于多个产品系列，请负责人先处理');
  if(exact.length===1){const {group,variant}=exact[0];if(variant.path&&await exists(variant.path)){const destination=await guarded(this.nas.config.assetRoot,path.relative(this.nas.config.assetRoot,variant.path));return {status:'exact',decisionRequired:false,groupId:group.id,group:groupView(group),variant,destination,destinationName:path.basename(destination),message:'69码完全一致，已准确定位'}}}
  safeName(item.brand,'品牌');
  const expected=path.join(this.nas.config.assetRoot,item.brand,folderName(item.product)+'-'+item.code),split=splitProductName(item.product);
  if(exact.length===1){const {group,variant}=exact[0],destination=variant.path&&await exists(variant.path)?variant.path:expected;return {status:'exact',decisionRequired:false,groupId:group.id,group:groupView(group),variant,destination,destinationName:path.basename(destination),message:'69码完全一致，已准确定位'}}
  const same=this.all().filter(group=>normalized(group.brand)===normalized(item.brand)&&[group.canonicalName,...(group.aliases||[])].some(name=>normalized(name)===normalized(split.base)));
  if(same.length===1)return {status:'same-series',decisionRequired:true,recommendedGroupId:same[0].id,candidates:[groupView(same[0])],destination:expected,destinationName:path.basename(expected),message:'发现同名产品系列，将作为新的69码规格保存'};
  const fuzzy=this.all().filter(group=>normalized(group.brand)===normalized(item.brand)).map(group=>({group,score:Math.max(...[group.canonicalName,...(group.aliases||[])].map(name=>dice(split.base,name)))})).filter(candidate=>candidate.score>=.86).sort((a,b)=>b.score-a.score).slice(0,3);
  if(fuzzy.length)return {status:'fuzzy',decisionRequired:true,recommendedGroupId:null,candidates:fuzzy.map(candidate=>({...groupView(candidate.group),score:Math.round(candidate.score*100)})),destination:expected,destinationName:path.basename(expected),message:'找到名称相似的产品系列，请确认归组'};
  return {status:'new',decisionRequired:false,groupId:null,candidates:[],destination:expected,destinationName:path.basename(expected),message:'未找到现有产品，将建立新的产品系列和69码目录'};
 }
 async confirm(item,decision){
  const match=await this.match(item);
  if(match.status==='exact')return {mode:'group',groupId:match.groupId,status:match.status,destination:match.destination};
  if(match.status==='new')return {mode:'new',groupId:null,status:match.status,destination:match.destination};
  if(!decision||!['group','new'].includes(decision.mode))fail('请先确认产品系列定位');
  if(decision.mode==='new')return {mode:'new',groupId:null,status:match.status,destination:match.destination};
  const candidate=match.candidates.find(group=>group.id===decision.groupId);if(!candidate)fail('产品系列候选已经变化，请重新选择');
  return {mode:'group',groupId:candidate.id,status:match.status,destination:match.destination};
 }
 recordArchive(item,product,resolution){
  const current=this.findCode(item.code);if(current.length===1){const {group,variant}=current[0];return this.addVariant(group,{...variant,name:item.product,spec:splitProductName(item.product).spec,path:product.path})}
  let group=resolution?.mode==='group'&&resolution.groupId?this.group(resolution.groupId):null;
  if(!group){const explicitSplit=resolution?.mode==='new'&&['same-series','fuzzy'].includes(resolution.status);group=this.create(item.brand,item.product,Date.now(),explicitSplit)}
  if(normalized(group.brand)!==normalized(item.brand))fail('产品系列品牌与需求品牌不一致');
  const result=this.addVariant(group,{code:item.code,name:item.product,spec:splitProductName(item.product).spec,path:product.path});this.store.event('product-group-linked','system',null,{groupId:result.id,code:item.code,product:item.product});return result;
 }
 update(actor,payload){
  const group=this.group(payload.groupId);if(!group)fail('产品系列不存在',404);const name=String(payload.canonicalName??'').normalize('NFKC').replace(/\s+/g,' ').trim();safeName(name,'标准产品名');
  const aliases=cleanAliases(payload.aliases,name),keys=new Set([name,...aliases].map(normalized));for(const other of this.all())if(other.id!==group.id&&normalized(other.brand)===normalized(group.brand)&&[other.canonicalName,...(other.aliases||[])].some(value=>keys.has(normalized(value))))fail('标准产品名或别名已被同品牌的其他产品系列使用');
  group.canonicalName=name;group.aliases=aliases;const result=this.put(group);this.store.event('product-group-updated',actor,null,{groupId:group.id});return result;
 }
 moveVariant(actor,payload){
  const locations=this.findCode(payload.code);if(locations.length!==1)fail('没有找到唯一的69码归组');const source=this.group(locations[0].group.id),variant=locations[0].variant;
  let target=payload.targetGroupId==='new'?this.create(source.brand,variant.name,Date.now(),true):this.group(payload.targetGroupId);if(!target)fail('目标产品系列不存在');if(normalized(target.brand)!==normalized(source.brand))fail('不同品牌不能合并为同一产品系列');if(target.id===source.id)return groupView(source);
  source.variants=source.variants.filter(item=>item.code!==variant.code);this.put(source);this.addVariant(target,variant);if(!source.variants.length)this.store.remove('productGroup',source.id);this.store.event('product-variant-moved',actor,null,{code:variant.code,from:source.id,to:target.id});return this.all();
 }
}

module.exports={Products,normalized,splitProductName,dice};
