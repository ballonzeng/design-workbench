'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');const source=fs.readFileSync(require('node:path').join(__dirname,'../desktop/main.cjs'),'utf8');
test('batch uploads serialize and partial failure stops later types without retrying completed ones',async()=>{
 for(const fail of [false,true]){const visited=[],chosen=new Map([['pick',{batch:[{folder:'主图',spec:{categoryName:'主图'}},{folder:'SKU',spec:{categoryName:'SKU'}},{folder:'详情',spec:{categoryName:'详情'}}]}]]);let id=0;const context=vm.createContext({chosen,crypto:{randomUUID:()=>String(++id)},uploading:false,uploadBatchActive:false,uploadBatchProgress:null,uploadOne:async payload=>{const selection=chosen.get(payload.selectionId);visited.push(selection.folder);if(fail&&selection.folder==='SKU')throw Error('断网')}});const start=source.indexOf('async function upload(payload)'),end=source.indexOf('async function uploadOne(',start);vm.runInContext(source.slice(start,end),context);
 if(fail){await assert.rejects(context.upload({selectionId:'pick',selfChecked:true}),/已归档 1 \/ 3 类/);assert.deepEqual(visited,['主图','SKU'])}else{const result=await context.upload({selectionId:'pick',selfChecked:true});assert.equal(result.completed,3);assert.deepEqual(visited,['主图','SKU','详情']);assert.equal(chosen.has('pick'),false)}
 }
});

test('desktop bridge permits manager duplicate tools and sealed product folder navigation',()=>{
 const commands=source.match(/const COMMANDS=new Set\((\[[^;]+\])\);/);assert.ok(commands);const allowed=vm.runInNewContext(commands[1]);for(const command of ['duplicate-inspect','duplicate-repair','task-asset-location'])assert.ok(allowed.includes(command));
});

test('the desktop owns one upload lock throughout all categories and releases it after failure',async()=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
 const chosen=new Map([['pick',{batch:[{folder:'主图',spec:{categoryName:'主图'}}]}]]);
 const context=vm.createContext({chosen,crypto:{randomUUID:()=> 'child'},uploading:false,uploadBatchActive:false,uploadBatchProgress:null,uploadOne:async()=>{entered();await gate;throw Error('断网')}});
 vm.runInContext(source.slice(source.indexOf('async function upload(payload)'),source.indexOf('async function uploadOne(')),context);
 const first=assert.rejects(context.upload({selectionId:'pick',selfChecked:true}),/断网/);await started;
 const second=context.upload({selectionId:'pick',selfChecked:true});const secondResult=assert.rejects(second,/已有文件正在上传/);
 release();await first;await secondResult;assert.equal(context.uploading,false);assert.equal(context.uploadBatchProgress,null);
});

test('a pending category stops the desktop batch and clears temporary selections and locks',async()=>{
 const chosen=new Map([['pick',{batch:[{folder:'主图',spec:{categoryName:'主图'}},{folder:'SKU',spec:{categoryName:'SKU'}}]}]]);let calls=0;
 const context=vm.createContext({chosen,crypto:{randomUUID:()=> 'child'},uploading:false,uploadBatchActive:false,uploadBatchProgress:null,uploadOne:async()=>{calls++;return {pending:true,uploadId:'server-batch'}}});
 vm.runInContext(source.slice(source.indexOf('async function upload(payload)'),source.indexOf('async function uploadOne(')),context);
 const result=await context.upload({selectionId:'pick',selfChecked:true});assert.equal(result.pending,true);assert.equal(result.completed,0);assert.equal(result.total,2);assert.equal(calls,1);
 assert.equal(context.uploading,false);assert.equal(context.uploadBatchProgress,null);assert.equal(chosen.size,0);
});
