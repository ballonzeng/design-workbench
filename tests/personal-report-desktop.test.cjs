'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createPersonalReport,personalRange}=require('../core/personal-report.cjs');
const source=fs.readFileSync(path.join(__dirname,'../desktop/main.cjs'),'utf8').replace(/\r\n/g,'\n');
function router({role='designer',version=1,canceled=false,offline=false}={}){
 const calls=[],writes=[],dialogs=[],generatedAt=Date.parse('2026-09-24T12:00:00+08:00');
 const data={personId:'hong',personName:'洪华',generatedAt,unavailable:[],tasks:[{id:'mine',owner:'hong',state:4,title:'需求任务',completedAt:generatedAt-3600000,items:[{type:'sku-full',typeName:'完整SKU精做',qty:4,points:2}]}]};
 const context=vm.createContext({role,createPersonalReport,personalRange,path,
  app:{getPath:()=>path.resolve('test-documents')},win:{},
  invoke:async(command,payload)=>{calls.push({command,payload});if(offline)throw Error('负责人主机离线');return command==='snapshot'?{personalReportVersion:version}:data},
  dialog:{showSaveDialog:async(_win,options)=>{dialogs.push(options);return {canceled,filePath:path.resolve('test-documents','mine.xlsx')}}},
  fsp:{writeFile:async(file,bytes)=>writes.push({file,bytes})}
 });
 const start=source.indexOf('const COMMANDS='),end=source.indexOf('\nasync function finishSmoke(',start);
 assert(start>=0&&end>start);vm.runInContext(source.slice(start,end),context);
 return {handle:(payload)=>context.handle('export-personal-report',payload),calls,writes,dialogs};
}
const options={frequency:'week',anchor:'2026-09-24'};
test('desktop personal export reaches authenticated RPC and saves a real xlsx using server identity',async()=>{
 const r=router(),result=await r.handle({...options,personId:'lv',owner:'lv',personName:'伪造姓名'});
 assert.equal(result.counts.tasks,1);assert.equal(result.counts.points,2);
 assert.deepEqual(r.calls.map(c=>c.command),['snapshot','personal-report-data']);
 assert.equal(r.calls[1].payload.personId,undefined);assert.equal(r.calls[1].payload.owner,undefined);
 assert.match(r.dialogs[0].defaultPath,/洪华/);assert.match(r.dialogs[0].defaultPath,/\.xlsx$/);
 assert.equal(r.writes.length,1);assert.equal(r.writes[0].bytes.subarray(0,2).toString(),'PK');
});
test('canceling the save dialog leaves no exported file',async()=>{
 const r=router({canceled:true});assert.equal(await r.handle(options),null);assert.equal(r.writes.length,0);
});
test('old hosts and disconnected hosts fail before showing save dialog',async()=>{
 for(const config of [{version:0},{offline:true}]){const r=router(config);await assert.rejects(r.handle(options),config.offline?/离线/:/更新负责人主机/);assert.equal(r.dialogs.length,0);assert.equal(r.writes.length,0);assert.equal(r.calls.length,1)}
});
test('manager role and invalid date ranges cannot initiate personal export RPC',async()=>{
 const manager=router({role:'manager'});await assert.rejects(manager.handle(options),/设计端/);assert.equal(manager.calls.length,0);
 const r=router();await assert.rejects(r.handle({frequency:'custom',startDate:'2026-09-24',endDate:'2026-09-01'}));assert.equal(r.calls.length,0);
});
