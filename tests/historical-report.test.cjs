'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const {unzipSync,strFromU8}=require('fflate');
const {createReport}=require('../core/report.cjs'),{queryTaskReview}=require('../core/task-review.cjs'),R=require('../core/rules.cjs');
const at=value=>Date.parse(value+'+08:00'),createdAt=at('2026-11-03T10:00:00');
function supplements(){return Array.from({length:6},(_,i)=>{
 const completedDate='2026-10-'+String(20+i).padStart(2,'0');
 return {id:'history-'+i,recordOnly:true,source:'historical-supplement',state:4,sealed:false,archiveStatus:'not-recorded',completionTimeSource:'user-confirmed-date',completedDate,completedAt:at(completedDate+'T00:00:00'),completedTimePrecision:'day',createdAt,updatedAt:createdAt,requestedAt:null,assignedAt:null,startedAt:null,reviewAt:null,sealedAt:null,owner:['hong','lv','chang'][i%3],title:'历史包装设计'+i,product:'包装产品'+i,brand:'',code:'',operator:'',filename:'',items:[{id:'history-item-'+i,row:6,type:'packaging-design',typeName:'包装设计',qty:2,points:8,category:'packaging'}],reportHistoricalBackfill:true,reportSupplementedAt:createdAt};
})}
const options={frequency:'month',anchor:'2026-10-01',generatedAt:createdAt+3600000};
const numeric=(rows,key)=>Math.round(rows.reduce((n,row)=>n+(row[key]||0),0)*100)/100;

test('late date-only historical completion contributes 6 tasks / 12 packaging sets / 48 points to October without fake timing or archiving',()=>{
 const tasks=supplements(),report=createReport(tasks,[],options),data=report.analysisData;
 assert.equal(report.metrics.completedTasks,6);assert.equal(report.metrics.completedPoints,48);assert.equal(report.metrics.effectiveCompleteTasks,0);
 assert.equal(report.metrics.historicalSupplementTasks,6);assert.equal(report.metrics.historicalBackfillTasks,6);
 assert.equal(data.tables['任务明细'].length,6);assert.equal(numeric(data.tables['事项明细'],'数量'),12);
 for(const [table,key] of [['任务明细','标准贡献力（点）'],['事项明细','事项贡献力（点）'],['人员汇总','完成贡献力（点）'],['产品维度','完成贡献力（点）'],['每日趋势','完成贡献力（点）']])assert.equal(numeric(data.tables[table],key),48,table+' points must reconcile');
 for(const row of data.tables['任务明细']){
  assert.equal(row['是否封存'],'未记录');assert.equal(row['本周期封存'],'否');assert.equal(row['本周期完成'],'是');
  assert.equal(row['确认时间来源'],'人工补录（完成日期，未记录时刻）');
  assert.equal(row['完成时间精度'],'日期（未记录时刻）');assert.match(row['记录来源'],/人工补录/);assert.match(row['历史口径'],/非原始截止快照/);
  assert.equal(row['补录时间'],new Date(createdAt).toISOString());assert.equal(row['版本记录时间'],null);
  for(const name of ['需求时间','分配时间','开始设计','提交确认','封存时间','累计记录计时（小时）','点数/记录计时（非人员效率）','需求至确认（小时）','分配至开始（小时）','开始至确认（小时）','本期有效设计记录（小时）','分配至开始有效等待（小时）','提交至确认有效等待（小时）'])assert.equal(row[name],null,name+' must stay unknown, not zero');
  assert(!row['产品69码']);assert(!row['需求表文件名']);assert(!row['运营']);assert.match(row['有效计时覆盖'],/未记录/);
 }
 for(const row of data.tables['人员汇总'].filter(row=>row['周期完成任务'])){
  assert.equal(row['周期完成任务'],2);assert.equal(row['完成贡献力（点）'],16);assert.equal(row['周期封存任务'],0);
  assert.equal(row['已完成任务累计记录计时（小时）'],null);assert.equal(row['点数/记录计时（非人员效率）'],null);assert.equal(row['本期去重有效记录（小时）'],null);assert.match(row['有效记录覆盖'],/人工补录/);
 }
 assert.equal(data.tables['计时区间'].length,0);assert.equal(data.tables['状态流转'].length,0);assert.equal(data.tables['待处理环节'].length,0);
 assert.equal(numeric(data.tables['每日趋势'],'新需求'),0);assert.equal(numeric(data.tables['每日趋势'],'完成分配'),0);assert.equal(numeric(data.tables['每日趋势'],'开始设计'),0);assert.equal(numeric(data.tables['每日趋势'],'提交确认'),0);assert.equal(numeric(data.tables['每日趋势'],'完成封存'),0);
 assert.equal(numeric(data.tables['每日趋势'],'运营确认完成'),6);
 const quality=JSON.stringify(data.tables['数据质量']);assert.match(quality,/原需求表缺失/);assert.match(quality,/69码未提供/);assert.match(quality,/未记录完成时刻/);assert.match(quality,/周期后人工补录/);assert.match(quality,/非原始截止快照/);
 const rows=report.sheets.find(sheet=>sheet.name==='任务明细').rows;for(const row of rows.slice(1))assert.equal(row[8].s,5,'completion cells must use date-only XLSX style');
 const zip=unzipSync(report.bytes);assert.match(strFromU8(zip['xl/worksheets/sheet2.xml']),/r="I2" s="5"/);
});

test('supplement creation in November does not manufacture November completion or task activity',()=>{
 const report=createReport(supplements(),[],{frequency:'month',anchor:'2026-11-01',generatedAt:createdAt+3600000});
 assert.equal(report.counts.tasks,0);assert.equal(report.metrics.completedPoints,0);assert.equal(report.metrics.historicalSupplementTasks,0);
});

test('a supplement created before the report cutoff remains identified as manual evidence without claiming a late entry',()=>{
 const tasks=supplements().map(task=>({...task,createdAt:at('2026-10-28T10:00:00'),reportSupplementedAt:at('2026-10-28T10:00:00')}));
 const report=createReport(tasks,[],options);assert.equal(report.metrics.completedPoints,48);assert.equal(report.metrics.historicalSupplementTasks,6);assert.equal(report.metrics.historicalBackfillTasks,0);
 assert(report.analysisData.tables['任务明细'].every(row=>row['历史口径']==='人工补录记录，非原始需求快照'));
});

test('review includes user-confirmed completion dates in points, but record-only archive state stays unknown',()=>{
 const tasks=supplements(),query={frequency:'month',anchor:'2026-10-01',basis:'completed'},review=queryTaskReview(tasks,R.PEOPLE,query,createdAt);
 assert.equal(review.tasks.length,6);assert.equal(review.summary.totalPoints,48);assert.equal(review.summary.completedPoints,48);assert.equal(review.summary.completedCount,6);assert.equal(review.summary.historicalSupplementCount,6);
 assert.equal(review.summary.pendingArchiveCount,0);assert.equal(review.summary.sealedCount,0);assert.equal(review.quality.estimatedTimestampCount,0);
 assert.equal(queryTaskReview(tasks,R.PEOPLE,{...query,state:'unsealed'},createdAt).tasks.length,0);assert.equal(queryTaskReview(tasks,R.PEOPLE,{...query,state:'sealed'},createdAt).tasks.length,0);
 assert.equal(queryTaskReview(tasks,R.PEOPLE,{...query,state:4},createdAt).tasks.length,6);
 for(const basis of ['requested','assigned','sealed']){const result=queryTaskReview(tasks,R.PEOPLE,{...query,basis},createdAt);assert.equal(result.tasks.length,0);assert.equal(result.quality.missingTimestampCount,6)}
});

test('mixed genuine and supplemented work keeps known effective intervals without inventing missing completed-task efficiency',()=>{
 const genuine={id:'real',state:4,sealed:true,owner:'hong',product:'真实需求产品',title:'真实需求',brand:'品牌',code:'6970855224163',createdAt:at('2026-10-19T10:00:00'),requestedAt:at('2026-10-19T10:00:00'),assignedAt:at('2026-10-20T09:00:00'),startedAt:at('2026-10-20T09:00:00'),reviewAt:at('2026-10-20T11:00:00'),completedAt:at('2026-10-20T11:00:00'),sealedAt:at('2026-10-20T12:00:00'),elapsedMs:7200000,timingTracked:true,workIntervals:[{owner:'hong',start:at('2026-10-20T09:00:00'),end:at('2026-10-20T11:00:00')}],items:[{row:6,type:'basic',qty:2,points:1.6}]};
 const report=createReport([...supplements(),genuine],[],options),people=report.analysisData.tables['人员汇总'].find(row=>row['人员ID']==='hong');
 assert.equal(report.metrics.completedPoints,49.6);assert.equal(people['本期去重有效记录（小时）'],2);assert.equal(people['已完成任务累计记录计时（小时）'],null);assert.equal(people['点数/记录计时（非人员效率）'],null);assert.match(people['有效记录覆盖'],/人工补录/);
 assert.equal(report.analysisData.tables['计时区间'].length,1);assert.equal(report.metrics.effectiveCompleteTasks,1);
 const query=queryTaskReview([...supplements(),genuine],R.PEOPLE,{frequency:'month',anchor:'2026-10-01'},createdAt);assert.equal(query.summary.sealedCount,1);assert.equal(query.summary.pendingArchiveCount,0);
});

test('historical supplement ZIP analysis package passes the shipped cross-dimension and SHA256 verifier',()=>{
 const report=createReport(supplements(),[],options),dir=fs.mkdtempSync(path.join(os.tmpdir(),'historical-report-'));
 try{
  for(const [name,bytes] of Object.entries(unzipSync(report.bundleBytes)))fs.writeFileSync(path.join(dir,name),bytes);
  const result=cp.spawnSync(process.execPath,[path.join(dir,'verify-analysis.cjs')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr||result.stdout);
 }finally{assert(dir.startsWith(path.join(os.tmpdir(),'historical-report-')));fs.rmSync(dir,{recursive:true,force:true})}
});

function archivedSupplements(archivedAt=at('2026-11-03T11:00:00')){
 return supplements().map(task=>({...task,historicalArchive:{id:'archive-'+task.id,status:'archived',identification:'pending-code',path:'C:\\fixture\\pending-code\\'+task.id+'\\包装设计',productPath:'C:\\fixture\\pending-code\\'+task.id,at:archivedAt,files:[{name:'包装设计.psd',size:128,sha256:'a'.repeat(64)}]}}));
}

test('physical historical archives count in current review and the actual archive date without changing original completion or raw sealed fields',()=>{
 const tasks=archivedSupplements(),before=structuredClone(tasks),now=at('2026-11-03T12:00:00'),october={frequency:'month',anchor:'2026-10-01',basis:'completed'};
 const review=queryTaskReview(tasks,R.PEOPLE,october,now);assert.equal(review.tasks.length,6);assert.equal(review.summary.totalPoints,48);assert.equal(review.summary.completedPoints,48);assert.equal(review.summary.sealedCount,6);assert.equal(review.summary.pendingArchiveCount,0);
 assert.equal(queryTaskReview(tasks,R.PEOPLE,{...october,state:'sealed'},now).tasks.length,6);
 assert.equal(queryTaskReview(tasks,R.PEOPLE,{...october,state:'unsealed'},now).tasks.length,0);
 const november=queryTaskReview(tasks,R.PEOPLE,{frequency:'month',anchor:'2026-11-01',basis:'sealed'},now);assert.equal(november.tasks.length,6);assert.equal(november.summary.sealedCount,6);assert.equal(november.quality.missingTimestampCount,0);assert(november.tasks.every(task=>task.matchedAt===at('2026-11-03T11:00:00')));
 assert.equal(queryTaskReview(tasks,R.PEOPLE,{...october,basis:'sealed'},now).tasks.length,0);
 assert.deepEqual(tasks,before);assert(tasks.every(task=>task.sealed===false&&task.sealedAt===null));
});

test('a November physical archive does not backdate October sealing and contributes six November seals without new completed points or hours',()=>{
 const tasks=archivedSupplements(),generatedAt=at('2026-11-03T12:00:00'),october=createReport(tasks,[],{frequency:'month',anchor:'2026-10-01',generatedAt});
 assert.equal(october.metrics.completedPoints,48);assert.equal(october.metrics.completedTasks,6);assert.equal(october.metrics.sealedTasks,0);
 assert.equal(numeric(october.analysisData.tables['每日趋势'],'完成封存'),0);assert.equal(numeric(october.analysisData.tables['人员汇总'],'周期封存任务'),0);
 for(const task of october.analysisData.tables['任务明细']){assert.equal(task['是否封存'],'未记录');assert.equal(task['封存时间'],null);assert.equal(task['本周期封存'],'否');assert.equal(task['封存产品目录'],null);assert.equal(task['封存定位状态'],'封存未记录')}
 const november=createReport(tasks,[],{frequency:'month',anchor:'2026-11-01',generatedAt}),data=november.analysisData;
 assert.equal(november.counts.tasks,6);assert.equal(november.metrics.completedTasks,0);assert.equal(november.metrics.completedPoints,0);assert.equal(november.metrics.sealedTasks,6);assert.equal(november.metrics.effectiveCompleteTasks,0);
 assert.equal(numeric(data.tables['人员汇总'],'周期封存任务'),6);assert.equal(numeric(data.tables['每日趋势'],'完成封存'),6);assert.equal(numeric(data.tables['每日趋势'],'运营确认完成'),0);assert.equal(numeric(data.tables['每日趋势'],'完成贡献力（点）'),0);
 assert.equal(data.tables['每日趋势'].find(row=>row['日期']==='2026-11-03')['完成封存'],6);
 for(const task of data.tables['任务明细']){
  assert.equal(task['本周期完成'],'否');assert.equal(task['本周期封存'],'是');assert.equal(task['是否封存'],'已封存（待69码定位）');assert.equal(task['封存时间'],new Date(at('2026-11-03T11:00:00')).toISOString());assert.equal(task['封存定位状态'],'待69码定位');assert.match(task['封存产品目录'],/pending-code/);assert.equal(task['累计记录计时（小时）'],null);assert.equal(task['本期有效设计记录（小时）'],null);assert.equal(task['点数/记录计时（非人员效率）'],null);assert.match(task['运营确认'],/^2026-10-/);
 }
 for(const person of data.tables['人员汇总'].filter(row=>row['周期涉及任务'])){assert.equal(person['周期完成任务'],0);assert.equal(person['周期封存任务'],2);assert.equal(person['已完成任务累计记录计时（小时）'],null);assert.equal(person['本期去重有效记录（小时）'],null)}
 assert.match(JSON.stringify(data.tables['数据质量']),/产物已实物封存，待69码定位/);
});

test('uncommitted or missing-file historical archive metadata never creates a seal, and real archive timestamps honor the exact report cutoff',()=>{
 const now=at('2026-11-03T12:00:00'),tasks=archivedSupplements();
 tasks[0].historicalArchive.status='pending';tasks[1].historicalArchive.files=[];tasks[2].historicalArchive.at=null;tasks[3].historicalArchive.path='';
 const review=queryTaskReview(tasks,R.PEOPLE,{frequency:'month',anchor:'2026-10',state:'sealed'},now);assert.equal(review.tasks.length,2);assert.equal(review.summary.sealedCount,2);
 const archiveTime=at('2026-11-03T11:00:00');assert.equal(createReport(archivedSupplements(),[],{frequency:'month',anchor:'2026-11-01',generatedAt:archiveTime-1}).counts.tasks,0);
 assert.equal(createReport(archivedSupplements(),[],{frequency:'month',anchor:'2026-11-01',generatedAt:archiveTime}).metrics.sealedTasks,6);
 const octoberEnd=at('2026-11-01T00:00:00')-1,closed=createReport(archivedSupplements(octoberEnd),[],{frequency:'month',anchor:'2026-10-01',generatedAt:now});assert.equal(closed.metrics.sealedTasks,6);assert.equal(closed.metrics.completedPoints,48);
});

test('analysis bundles with verified archive activity in a separate month continue to pass shipped point reconciliation',()=>{
 const tasks=archivedSupplements(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'historical-archive-report-'));
 try{
  for(const anchor of ['2026-10-01','2026-11-01']){
   const report=createReport(tasks,[],{frequency:'month',anchor,generatedAt:at('2026-11-03T12:00:00')});
   for(const [name,bytes]of Object.entries(unzipSync(report.bundleBytes)))fs.writeFileSync(path.join(dir,name),bytes);
   const result=cp.spawnSync(process.execPath,[path.join(dir,'verify-analysis.cjs')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr||result.stdout);
  }
 }finally{assert(dir.startsWith(path.join(os.tmpdir(),'historical-archive-report-')));fs.rmSync(dir,{recursive:true,force:true})}
});
