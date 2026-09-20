'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const {unzipSync,strFromU8}=require('fflate');
const {createReport,periodRange}=require('../core/report.cjs');

test('weekly and monthly periods use Shanghai calendar boundaries',()=>{
 const week=periodRange('week','2026-09-04');assert.equal(week.label,'2026-08-31 至 2026-09-06');assert.equal(week.capacity,32);
 const month=periodRange('month','2026-09-04');assert.equal(month.label,'2026年9月');assert.equal(month.capacity,139.2);
});

test('analysis workbook contains traceable multi-dimensional sheets',()=>{
 const completed=Date.UTC(2026,8,3,7),task={id:'task-1',state:4,sealed:true,requestedAt:Date.UTC(2026,8,1,1),createdAt:Date.UTC(2026,8,1,2),assignedAt:Date.UTC(2026,8,1,3),startedAt:Date.UTC(2026,8,1,4),reviewAt:Date.UTC(2026,8,3,6),completedAt:completed,sealedAt:completed+3600000,elapsedMs:7200000,brand:'九芝堂',product:'西红花',code:'6970855224163',title:'西红花主图',operator:'王燕',owner:'hong',filename:'需求.xlsx',items:[{id:'row-6',type:'creative',typeName:'创意图',qty:2,points:4,category:'creative',note:''}]};
 const event={seq:1,at:completed,taskId:task.id,actor:'zeng',kind:'approve',body:{from:3,to:4}};
 const result=createReport([task],[event],{frequency:'month',anchor:'2026-09-04',generatedAt:completed+7200000});assert.equal(result.counts.tasks,1);assert.equal(result.counts.items,1);assert.equal(result.counts.events,1);
 const zip=unzipSync(result.bytes),workbook=strFromU8(zip['xl/workbook.xml']);
 for(const sheet of ['AI使用说明','任务明细','事项明细','人员汇总','产品维度','状态流转','每日趋势'])assert.match(workbook,new RegExp('name="'+sheet+'"'));
 const tasks=strFromU8(zip['xl/worksheets/sheet2.xml']);assert.match(tasks,/6970855224163/);assert.match(tasks,/西红花主图/);assert.match(tasks,/标准贡献力（点）/);
});
