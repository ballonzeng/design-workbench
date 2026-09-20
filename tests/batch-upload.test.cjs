'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');const source=fs.readFileSync(require('node:path').join(__dirname,'../desktop/main.cjs'),'utf8');
test('batch uploads serialize and partial failure stops later types without retrying completed ones',async()=>{
 for(const fail of [false,true]){const visited=[],chosen=new Map([['pick',{batch:[{folder:'主图',spec:{categoryName:'主图'}},{folder:'SKU',spec:{categoryName:'SKU'}},{folder:'详情',spec:{categoryName:'详情'}}]}]]);let id=0;const context=vm.createContext({chosen,crypto:{randomUUID:()=>String(++id)},uploading:false,uploadBatchProgress:null,uploadOne:async payload=>{const selection=chosen.get(payload.selectionId);visited.push(selection.folder);if(fail&&selection.folder==='SKU')throw Error('断网')}});const start=source.indexOf('async function upload(payload)'),end=source.indexOf('async function uploadOne(',start);vm.runInContext(source.slice(start,end),context);
 if(fail){await assert.rejects(context.upload({selectionId:'pick',selfChecked:true}),/已归档 1 \/ 3 类/);assert.deepEqual(visited,['主图','SKU'])}else{const result=await context.upload({selectionId:'pick',selfChecked:true});assert.equal(result.completed,3);assert.deepEqual(visited,['主图','SKU','详情']);assert.equal(chosen.has('pick'),false)}
 }
});

test('desktop bridge permits manager duplicate tools and sealed product folder navigation',()=>{
 const commands=source.match(/const COMMANDS=new Set\((\[[^;]+\])\);/);assert.ok(commands);const allowed=vm.runInNewContext(commands[1]);for(const command of ['duplicate-inspect','duplicate-repair','task-asset-location'])assert.ok(allowed.includes(command));
});
