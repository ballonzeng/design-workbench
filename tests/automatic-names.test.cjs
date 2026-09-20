'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {automaticNames}=require('../core/automatic-names.cjs');
const spec={base:'0907-吕慧芸-主图',category:'main'};
const source={relativePath:'最终稿.psd',kind:'source',size:100};const image=(name,width)=>({relativePath:name,kind:'output',width,size:100});
const raw=files=>({files:[source,...files],projectFolders:[],directories:[]});
test('main images group by measured width and numeric sequence independently',()=>{
 const r=automaticNames(spec,raw([image('最终10.jpg',750),image('最终2.png',750),image('800主图08.jpg',800),image('800主图03.png',800)]));assert.deepEqual(r.files.map(f=>f.name),['0907-吕慧芸-主图.psd','750主图02.jpg','750主图01.png','800主图02.jpg','800主图01.png']);assert.equal(r.files[1].relativePath,'最终10.jpg');
});
test('missing, repeated sequence and unsupported main width require correction',()=>{
 assert.throws(()=>automaticNames(spec,raw([image('a.jpg',750),image('b.jpg',750)])),/序号/);assert.throws(()=>automaticNames(spec,raw([image('a1.jpg',750),image('b1.jpg',750)])),/序号/);assert.throws(()=>automaticNames(spec,raw([image('a1.jpg',900)])),/宽度/);
});
test('SKU and creative images renumber while details retain originals',()=>{
 for(const [category,label]of [['sku','SKU'],['creative','创意图']]){const r=automaticNames({base:'0907-吕慧芸-'+label,category},raw([image('图10.png'),image('图2.jpg')]));assert.equal(r.files[1].name,category==='sku'?'02-图10-SKU.png':label+'02.png');assert.equal(r.files[2].name,category==='sku'?'01-图2-SKU.jpg':label+'01.jpg')}
 const r=automaticNames({base:'0907-吕慧芸-详情页',category:'detail'},raw([image('产品-详情09.jpg'),image('产品-详情01.png')]));assert.equal(r.files[1].name,'产品-详情09.jpg');assert.equal(r.files[2].name,'产品-详情01.png');
});
test('project texture names and hierarchy survive; duplicate source targets rejected',()=>{
 const r=automaticNames(spec,{projectFolders:['模型'],directories:[],files:[source,{relativePath:'模型/场景.c4d',kind:'source'},{relativePath:'模型/tex/a1.jpg',kind:'source'},image('图1.jpg',750)]});assert.equal(r.files[2].relative,'0907-吕慧芸-c4d/tex/a1.jpg');assert.equal(r.files[2].kind,'source');assert.throws(()=>automaticNames(spec,{...raw([image('a1.jpg',750)]),files:[source,{...source,relativePath:'另一个.psd'},image('a1.jpg',750)]}),/重名/);
});
test('six faces require semantic labels and multiple video target collisions are rejected',()=>{
 assert.throws(()=>automaticNames({base:'0907-吕慧芸-六面图',category:'six'},raw([image('图1.png')])),/实际面/);const videos=automaticNames({base:'0907-吕慧芸-创意视频',category:'video'},raw([image('2.mp4'),image('1.mp4')]));assert.equal(videos.files[1].name,'0907-吕慧芸-创意视频02.mp4');assert.equal(videos.files[2].name,'0907-吕慧芸-创意视频01.mp4');
});

test('unambiguous folder spelling variations normalize without changing date or owner',()=>{
 const {normalizeDeliveryFolder,ignoredDeliveryEntry}=require('../core/delivery.cjs');for(const value of [' 0907 - 吕慧芸 - sku ','０９０７－吕慧芸－ＳＫＵ','0907_吕慧芸_sku图','0907—吕慧芸—Sku'])assert.equal(normalizeDeliveryFolder(value),'0907-吕慧芸-SKU');assert.equal(normalizeDeliveryFolder('0907-吕慧芸-详情'),'0907-吕慧芸-详情页');assert.equal(normalizeDeliveryFolder('0908-其他人-主图'),'0908-其他人-主图');assert.ok(ignoredDeliveryEntry('._主图.psd'));assert.equal(ignoredDeliveryEntry('主图.psd'),false);
});
test('numeric ordering ignores explicit dimensions and handles fullwidth sequence digits',()=>{
 const {sequence}=require('../core/automatic-names.cjs');assert.equal(sequence('主图02-750x1000.jpg'),2);assert.equal(sequence('主图０３-800px.png'),3);assert.equal(sequence('750主图09.jpg'),9);
});

test('SKU missing and duplicate numbers get deterministic names independent of scan order',()=>{
 const s={base:'0910-常慧杰-SKU',category:'sku'},files=[image('水杨酸（红）.jpg'),image('水杨酸（蓝）.jpg'),image('组合2.jpg'),image('套餐2.jpg'),image('图10.png')];
 const mapping=files=>Object.fromEntries(automaticNames(s,raw(files)).files.filter(f=>f.kind==='output').map(f=>[f.relativePath,f.name]));const a=mapping(files),b=mapping([...files].reverse());assert.deepEqual(a,b);assert.equal(new Set(Object.values(a)).size,5);assert.equal(a['图10.png'],'03-图10-SKU.png');assert.match(a['水杨酸（红）.jpg'],/^0[45]-水杨酸（红）-SKU\.jpg$/);
});

test('SKU preserves original names and does not append a second case-insensitive SKU',()=>{
 const s={base:'0910-常慧杰-SKU',category:'sku'};for(const original of ['红色SKU.jpg','蓝色sku.png','组合SkU.gif']){const r=automaticNames(s,raw([image(original)]));assert.equal(r.files[1].name,'01-'+original);assert.equal(r.files[1].relativePath,original);assert.equal(r.files[0].name,s.base+'.psd')}
});
