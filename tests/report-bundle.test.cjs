'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const {unzipSync}=require('fflate'),{createReport}=require('../core/report.cjs'),W=require('../core/work-calendar.cjs');
const at=s=>Date.parse(s+'+08:00');
function task(id,owner='hong'){return {id,owner,state:4,createdAt:at('2026-09-21T09:00:00'),assignedAt:at('2026-09-21T09:00:00'),startedAt:at('2026-09-21T11:00:00'),reviewAt:at('2026-09-21T14:00:00'),completedAt:at('2026-09-21T15:00:00'),elapsedMs:3*W.HOUR,code:'6970855224163',brand:'示例品牌',product:'示例产品',title:'示例需求',items:[{row:6,type:'basic',qty:2,points:1.6}],timingTracked:true,workIntervals:[{owner,start:at('2026-09-21T11:00:00'),end:at('2026-09-21T14:00:00')}]}}
test('bundle reconciles complete points across dimensions and keeps missing rating distinct',()=>{
 const tasks=[task('a'),task('b')];tasks[0].ratings={quality:[{row:6,value:80}],timeliness:'满意'};
 const r=createReport(tasks,[],{frequency:'month',anchor:'2026-09-24',generatedAt:at('2026-09-24T12:30:00')}),d=r.analysisData;
 assert.equal(d.metrics.completedPoints,3.2);assert.equal(d.metrics.qualityMean,80);assert.equal(d.metrics.qualityRatedItems,1);assert.equal(d.metrics.qualityTotalItems,2);
 assert.equal(d.tables['人员汇总'].find(p=>p['人员ID']==='hong')['本期去重有效记录（小时）'],2);
 assert.equal(d.tables['事项明细'][1]['运营质量评分（0至100）'],null);assert.equal(d.tables['任务明细'][0]['产品69码'],'6970855224163');
 assert(d.tables['每日趋势'].length===24);assert(r.calendar.elapsedPoints<r.calendar.points);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'report-bundle-'));try{for(const [name,bytes]of Object.entries(unzipSync(r.bundleBytes)))fs.writeFileSync(path.join(dir,name),bytes);const v=cp.spawnSync(process.execPath,[path.join(dir,'verify-analysis.cjs')],{encoding:'utf8'});assert.equal(v.status,0,v.stderr);fs.appendFileSync(path.join(dir,'data.json'),' ');assert.notEqual(cp.spawnSync(process.execPath,[path.join(dir,'verify-analysis.cjs')]).status,0)}finally{fs.rmSync(dir,{recursive:true,force:true})}
});
test('future period does not manufacture ongoing activity, daily zero trends or achieved capacity',()=>{
 const r=createReport([task('a')],[],{frequency:'month',anchor:'2026-10-01',generatedAt:at('2026-09-24T12:00:00')});assert.equal(r.counts.tasks,0);assert.equal(r.analysisData.tables['每日趋势'].length,0);assert.equal(r.calendar.elapsedPoints,0);
});
test('historical cumulative counters remain incomplete and manager-owned tasks reconcile too',()=>{
 const t=task('legacy','zeng');delete t.workIntervals;delete t.timingTracked;
 const r=createReport([t],[],{frequency:'month',anchor:'2026-09-24',generatedAt:at('2026-09-24T12:00:00')});assert.equal(r.metrics.effectiveCompleteTasks,0);assert.match(r.analysisData.tables['任务明细'][0]['有效计时覆盖'],/缺失/);assert.equal(r.analysisData.tables['人员汇总'].find(p=>p['人员ID']==='zeng')['完成贡献力（点）'],1.6);
});
test('reassigned work remains attributed to historical owners and removal follows report cutoff',()=>{
 const t=task('reassigned');t.workIntervals=[{owner:'zeng',start:at('2026-09-21T09:00:00'),end:at('2026-09-21T11:00:00')},{owner:'hong',start:at('2026-09-21T13:00:00'),end:at('2026-09-21T16:00:00')}];
 const r=createReport([t],[],{frequency:'month',anchor:'2026-09-24',generatedAt:at('2026-09-24T12:00:00'),removedPeople:[{personId:'zeng',at:at('2026-09-22T09:00:00')},{personId:'hong',at:at('2026-09-25T09:00:00')}]});
 const rows=r.analysisData.tables['人员汇总'],previous=rows.find(p=>p['人员ID']==='zeng'),current=rows.find(p=>p['人员ID']==='hong');
 assert.equal(previous['本期去重有效记录（小时）'],2);assert.equal(current['本期去重有效记录（小时）'],3);assert.equal(previous['周期涉及任务'],1);assert.equal(previous['有效记录覆盖'],'完整');
 assert.equal(previous['完成贡献力（点）'],0);assert.equal(current['完成贡献力（点）'],1.6);assert.match(previous['任职口径'],/已移出/);assert.doesNotMatch(current['任职口径'],/已移出/);
});
