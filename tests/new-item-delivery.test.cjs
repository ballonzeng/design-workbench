'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const R=require('../core/rules.cjs');
const {archiveSpec,validateManifest,validateTaskManifest}=require('../core/assets.cjs');
const {normalizeDeliveryFolder}=require('../core/delivery.cjs');
const {inferCategory}=require('../core/naming.cjs');

const entry=relativePath=>({relativePath,size:100,sha256:'a'.repeat(64)});
function task(type,qty,category){return {id:'new-delivery',state:4,owner:'lv',version:1,completedAt:Date.UTC(2026,9,19,4),items:[{id:'row-6',row:6,type,qty,category,product:'示例产品',brand:'示例品牌',code:'6970855224163',points:R.itemPoints({type,qty})}]}}
function legacyFile(name,kind,folder){return {name,kind,folder,size:100,sha256:'a'.repeat(64)}}
function modern(t,files,{namingVersion=4,directories=[],naming={repair:true},folder}={}){
 const spec=archiveSpec(t,t.items[0]);
 return validateTaskManifest(t,files.map(entry),{version:1,namingVersion,folder:folder||spec.base,directories,naming});
}

test('storyboard work units accept one finished video in both upload protocols',()=>{
 const t=task('video-storyboard',8,'video'),spec=archiveSpec(t,t.items[0]);
 assert.equal(t.items[0].points,20);assert.equal(spec.expectedCount,null);
 const result=validateManifest(t,t.items[0],[legacyFile(spec.base+'.mp4','output')]);
 assert.equal(result.files.filter(f=>f.kind==='output').length,1);
 for(const namingVersion of [2,4]){
  const next=modern(t,['最终成片.mp4'],{namingVersion,folder:'1019-吕慧芸-产品视频'});
  assert.equal(next.spec.category,'video');assert.equal(next.files[0].relative,'1019-吕慧芸-创意视频.mp4');
 }
 assert.throws(()=>validateManifest(t,t.items[0],[legacyFile(spec.base+'.prproj','source')]),/至少应有 1 个/);
 assert.throws(()=>modern(t,['剪辑.prproj']),/识别到 0/);
});

test('legacy per-video and per-image quantity checks keep their previous units and counts',()=>{
 for(const [type,points]of [['video-image',.3],['video-basic',1.1],['video-zero',2]]){
  assert.equal(R.rateFor(type).unit,'条');assert.equal(R.rateFor(type).points,points);
  const t=task(type,2,'video'),spec=archiveSpec(t,t.items[0]);assert.equal(spec.expectedCount,2);
  assert.throws(()=>validateManifest(t,t.items[0],[legacyFile(spec.base+'.mp4','output')]),/数量应为 2/);
 }
 const t=task('main-full',2,'main'),spec=archiveSpec(t,t.items[0]);assert.equal(spec.expectedCount,2);
 assert.throws(()=>validateManifest(t,t.items[0],[legacyFile(spec.base+'.psd','source'),legacyFile('主图01.png','output',spec.base)]),/数量应为 2/);
 assert.throws(()=>validateManifest(t,t.items[0],[legacyFile(spec.base+'.psd','source'),legacyFile('随意.png','output',spec.base)]),/画板命名/);
});

test('packaging proposals accept arbitrary export counts but still require source and final output',()=>{
 const t=task('packaging-design',2,'packaging'),spec=archiveSpec(t,t.items[0]);
 assert.equal(t.items[0].points,8);assert.equal(spec.expectedCount,null);
 const source=legacyFile(spec.base+'.ai','source');
 for(const names of [['方案效果.jpg'],['展开图.png','包装正面.jpg','盒底 (终稿).png']]){
  const result=validateManifest(t,t.items[0],[source,...names.map(name=>legacyFile(name,'output',spec.base))]);
  assert.deepEqual(result.files.filter(f=>f.kind==='output').map(f=>f.name),names);
 }
 assert.throws(()=>validateManifest(t,t.items[0],[source]),/至少应有 1 个/);
 assert.throws(()=>validateManifest(t,t.items[0],[legacyFile('包装效果.jpg','output',spec.base)]),/可编辑的源文件/);
 assert.throws(()=>modern(t,['方案.ai']),/识别到 0/);
 assert.throws(()=>modern(t,['包装效果.jpg']),/缺少源文件/);
});

test('packaging folder aliases and v2 naming preserve free image names and project references',()=>{
 const t=task('packaging-design',3,'packaging');
 assert.equal(R.itemPoints(t.items[0]),12);
 assert.equal(inferCategory('1019-吕慧芸-包装'),'packaging');
 assert.equal(inferCategory('包装设计最终版'),'packaging');
 assert.equal(normalizeDeliveryFolder('1019-吕慧芸-包装'),'1019-吕慧芸-包装设计');
 const next=modern(t,['方案.ai','整体效果.jpg','工程/scene.c4d','工程/tex/a.jpg'],{namingVersion:2,directories:['工程','工程/tex'],folder:'1019-吕慧芸-包装'});
 assert.equal(next.spec.category,'packaging');
 assert.equal(next.files.find(f=>f.relativePath==='整体效果.jpg').relative,'1019-吕慧芸-包装设计/整体效果.jpg');
 assert.equal(next.files.find(f=>f.relativePath==='方案.ai').relative,'1019-吕慧芸-包装设计.ai');
 assert.equal(next.files.find(f=>f.relativePath==='工程/scene.c4d').relative,'1019-吕慧芸-c4d/scene.c4d');
 assert.equal(next.files.find(f=>f.relativePath==='工程/tex/a.jpg').relative,'1019-吕慧芸-c4d/tex/a.jpg');
 assert.equal(next.files.find(f=>f.relativePath==='工程/tex/a.jpg').kind,'source');
});

test('packaging v4 repairs duplicate export names without altering engine-internal names',()=>{
 const t=task('packaging-design',2,'packaging'),files=['方案.ai','版本A/效果.jpg','版本B/效果.jpg','工程/scene.c4d','工程/tex/a.jpg'];
 const options={directories:['版本A','版本B','工程','工程/tex']},next=modern(t,files,options);
 assert.equal(next.files.filter(f=>f.kind==='output').length,2);
 assert.equal(new Set(next.files.map(f=>f.relative.toLowerCase())).size,files.length);
 assert.deepEqual(next.files.filter(f=>f.kind==='output').map(f=>f.name),['效果.jpg','效果-01.jpg']);
 assert.ok(next.files.find(f=>f.relativePath==='工程/tex/a.jpg').relative.endsWith('/tex/a.jpg'));
 const corrected=modern(t,files,{...options,naming:{repair:true,outputNames:{'版本A/效果.jpg':'设计方案A.jpg'}}});
 assert.equal(corrected.files.find(f=>f.relativePath==='版本A/效果.jpg').name,'设计方案A.jpg');
 for(const bad of ['../逃逸.jpg','更换扩展名.exe'])assert.throws(()=>modern(t,files,{...options,naming:{repair:true,outputNames:{'版本A/效果.jpg':bad}}}),/目标文件名/);
});
