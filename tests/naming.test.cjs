'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {nameDelivery,inferCategory}=require('../core/naming.cjs'),{classifyDelivery}=require('../core/delivery.cjs');
const spec={base:'0907-吕慧芸-主图',category:'main',product:'西红花'},entry=relativePath=>({relativePath,size:100});
const plan=(files,dirs=[],s=spec)=>nameDelivery(s,classifyDelivery(s,s.base,files.map(entry),dirs));
test('formal naming preserves artboard image names and pairs their folder with the source',()=>{
 const result=plan(['终稿.psd','主图01.png','主图02.jpg']);assert.deepEqual(result.files.map(f=>f.relative),['0907-吕慧芸-主图.psd','0907-吕慧芸-主图/主图01.png','0907-吕慧芸-主图/主图02.jpg']);
 assert.throws(()=>plan(['终稿.psd','图片.png']),/画板规则/);assert.throws(()=>plan(['终稿.psd','另一个.psd','主图01.png']),/重名/);
 const detail=plan(['设计.psd','西红花-详情01.png'],[],{...spec,base:'0907-吕慧芸-详情页',category:'detail'});assert.ok(detail.files[1].relative.endsWith('/西红花-详情01.png'));
});
test('engineering folders rename only their wrapper and keep referenced children intact',()=>{
 const r=plan(['工程包/模型.c4d','工程包/tex/原始贴图.jpg','主图01.png'],['工程包','工程包/tex','工程包/cache']);
 assert.equal(r.files[0].relative,'0907-吕慧芸-c4d/模型.c4d');assert.equal(r.files[1].relative,'0907-吕慧芸-c4d/tex/原始贴图.jpg');assert.ok(r.directories.some(d=>d.relative==='0907-吕慧芸-c4d/cache'));
 assert.throws(()=>plan(['A/a.c4d','B/b.c4d','主图01.png'],['A','B']),/多个工程/);
});
test('keyword classification asks for a choice when ambiguous and accepts explicit category',()=>{
 assert.equal(inferCategory('最终SKU文件夹'),'sku');assert.throws(()=>inferCategory('主图与详情页'),/多个/);assert.equal(inferCategory('主图与详情页','main'),'main');assert.throws(()=>inferCategory('未命名'),/未识别/);
});
