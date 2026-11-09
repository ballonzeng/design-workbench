'use strict';
const R=require('./rules.cjs');

const DAY=86400000,TZ=8*3600000;
const BASES={requested:{field:'requestedAt',label:'提出需求时间'},assigned:{field:'assignedAt',label:'分配时间'},completed:{field:'completedAt',label:'运营确认完成时间'},sealed:{field:'sealedAt',label:'完成封存时间'}};
const dayKey=at=>{const d=new Date(at+TZ);return d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0')};
function validDate(value,label='日期'){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))R.fail('请选择有效的'+label);
 const [year,month,day]=value.split('-').map(Number),at=Date.UTC(year,month-1,day)-TZ;
 if(year<1900||!Number.isFinite(at)||dayKey(at)!==value)R.fail(label+'无效');
 return at;
}
function reviewRange(options={},now=Date.now()){
 if(!options||typeof options!=='object'||Array.isArray(options)||!Number.isFinite(now))R.fail('任务回顾筛选条件无效');
 const frequency=options.frequency??'month';
 if(!['month','week','day','custom'].includes(frequency))R.fail('请选择按月、按周、按天或自定义日期');
 let start,end,label,anchor;
 if(frequency==='custom'){
  start=validDate(options.start,'开始日期');end=validDate(options.end,'结束日期')+DAY;
  if(start>=end)R.fail('开始日期不能晚于结束日期');
  label=dayKey(start)+' 至 '+dayKey(end-DAY);anchor=dayKey(start);
 }else{
  let value=options.anchor;
  if(value===undefined||value===''){
   const current=new Date(now+TZ);
   value=frequency==='month'?dayKey(Date.UTC(current.getUTCFullYear(),current.getUTCMonth()-1,1)-TZ):dayKey(now);
  }
  if(frequency==='month'&&typeof value==='string'&&/^\d{4}-\d{2}$/.test(value))value+='-01';
  const at=validDate(value),d=new Date(at+TZ);anchor=dayKey(at);
  if(frequency==='month'){
   start=Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1)-TZ;end=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)-TZ;
   label=d.getUTCFullYear()+' 年 '+(d.getUTCMonth()+1)+' 月';
  }else if(frequency==='week'){
   start=at-((d.getUTCDay()+6)%7)*DAY;end=start+7*DAY;label=dayKey(start)+' 至 '+dayKey(end-DAY);
  }else{start=at;end=at+DAY;label=dayKey(start)}
 }
 return {frequency,start,end,label,anchor,startDate:dayKey(start),endDate:dayKey(end-DAY),timezone:'Asia/Shanghai'};
}
const estimatedCompletion=task=>!!task.completionFromFolder||['file-estimate','review-estimate'].includes(task.completionTimeSource);
function taskPoints(task){
 let value=0,incomplete=false;
 for(const item of task.items||[]){
  if(Number.isFinite(item.points))value+=item.points;
  else try{value+=R.itemPoints(item)}catch{incomplete=true}
 }
 return {value:Math.round(value*100)/100,incomplete};
}
const round=value=>Math.round(value*100)/100;
const historicalArchive=task=>{const archive=task.historicalArchive;return task.recordOnly&&archive?.status==='archived'&&Number.isFinite(archive.at)&&typeof archive.path==='string'&&archive.path&&Array.isArray(archive.files)&&archive.files.length?archive:null};
const archiveTime=task=>task.recordOnly?historicalArchive(task)?.at??null:task.sealedAt;
const isSealed=task=>task.state===4&&(task.recordOnly?!!historicalArchive(task):!!task.sealed);
function summarize(tasks){
 const completed=tasks.filter(t=>t.state===4&&Number.isFinite(t.completedAt)&&!estimatedCompletion(t)),sealed=tasks.filter(isSealed),historicalSupplementCount=tasks.filter(t=>t.recordOnly).length;
 return {taskCount:tasks.length,totalPoints:round(tasks.reduce((sum,t)=>sum+t.totalPoints,0)),completedCount:completed.length,completedPoints:round(completed.reduce((sum,t)=>sum+t.totalPoints,0)),sealedCount:sealed.length,pendingArchiveCount:tasks.filter(t=>!t.recordOnly&&t.state===4&&!t.sealed).length,...(historicalSupplementCount?{historicalSupplementCount}:{})};
}
const reviewExclusionKey=(range,taskId)=>range.startDate+':'+range.endDate+':'+taskId;
function queryTaskReview(tasks=[],people=[],options={},now=Date.now(),exclusions=[]){
 const range=reviewRange(options,now),basis=options.basis??'completed';
 if(typeof basis!=='string'||!Object.hasOwn(BASES,basis))R.fail('请选择提出、分配、完成或封存时间');
 const spec=BASES[basis];
 const selectedTime=task=>basis==='sealed'?archiveTime(task):task[spec.field];
 const state=options.state===undefined||options.state===null||options.state===''?'all':String(options.state);
 if(!['all','0','1','2','3','4','sealed','unsealed'].includes(state))R.fail('任务状态筛选无效');
 const personId=options.personId??'';
 if(typeof personId!=='string'||personId.length>100)R.fail('人员筛选无效');
 const input=options.query??'';
 if(typeof input!=='string'||input.length>300)R.fail('搜索内容最多 300 个字符');
 const query=input.trim().toLocaleLowerCase('zh-CN'),personMap=new Map(people.map(p=>[p.id,p]));
 const visible=task=>!personMap.get(task.owner)?.removed&&!task.deleted&&!(task.state<4&&!task.sealed&&task.workbookSyncIssue?.message==='五个状态文件夹内未找到原需求表，请检查是否被移动或改名');
 const periodExclusions=new Map(exclusions.filter(e=>e.startDate===range.startDate&&e.endDate===range.endDate).map(e=>[e.taskId,e]));
 const enrich=task=>{const points=taskPoints(task),timestamp=selectedTime(task);return {...task,matchedAt:Number.isFinite(timestamp)?timestamp:null,totalPoints:points.value,pointsIncomplete:points.incomplete,timestampEstimated:basis==='completed'&&estimatedCompletion(task)}};
 const excludedTasks=tasks.filter(task=>visible(task)&&periodExclusions.has(task.id)).map(task=>({...enrich(task),exclusion:{...periodExclusions.get(task.id)}})).sort((a,b)=>(b.exclusion.at||0)-(a.exclusion.at||0)||String(a.id).localeCompare(String(b.id)));
 const candidates=tasks.filter(task=>{
  if(!visible(task)||periodExclusions.has(task.id))return false;
  if(personId&&(task.owner||'_unassigned')!==personId)return false;
  if(state==='sealed'&&!isSealed(task)||state==='unsealed'&&(task.recordOnly||!(task.state===4&&!task.sealed)))return false;
  if(/^\d$/.test(state)&&task.state!==Number(state))return false;
  if(query){const text=[task.title,task.product,task.brand,task.code,task.filename,task.operator,personMap.get(task.owner)?.name,task.id].join(' ').toLocaleLowerCase('zh-CN');if(!text.includes(query))return false}
  return true;
 });
 const selected=candidates.filter(t=>Number.isFinite(selectedTime(t))&&selectedTime(t)>=range.start&&selectedTime(t)<range.end).map(enrich).sort((a,b)=>b.matchedAt-a.matchedAt||String(a.id).localeCompare(String(b.id)));
 const personGroups=new Map();for(const task of selected){const id=task.owner||'_unassigned';if(!personGroups.has(id))personGroups.set(id,[]);personGroups.get(id).push(task)}
 return {range,basis,basisLabel:spec.label,generatedAt:now,tasks:selected,excludedTasks,excludedCount:excludedTasks.length,people:[...personGroups].map(([id,mine])=>({id,name:personMap.get(id)?.name||(id==='_unassigned'?'未分配':id),removed:!!personMap.get(id)?.removed,...summarize(mine)})),summary:summarize(selected),quality:{missingTimestampCount:candidates.filter(t=>!Number.isFinite(selectedTime(t))).length,estimatedTimestampCount:selected.filter(t=>t.timestampEstimated).length,missingPointsCount:selected.filter(t=>t.pointsIncomplete).length},definitions:{state:'状态、人员归属、事项及点数为当前保存值，不是所选日期当时的历史快照。',time:'按'+spec.label+'筛选，北京时间；结束日期包含全天。',missingTimestamp:'缺少所选时间戳的数量按当前人员、状态与搜索条件统计，无法确定所属日期，因此不计入日期结果。',completedPoints:'已完结且运营确认时间非推定的任务当前点数合计；推定确认记录仍显示在任务列表并单独提示。',totalPoints:'筛选结果中任务当前事项点数合计，包含已标注的推定确认记录。',archiving:'历史补录只有关联已验证的实物封存记录时计入已封存；待69码定位的封存单独标明。未记录封存状态的历史补录不视为待封存。',exclusions:'手动排除仅作用于完全相同的日期范围，不受人员、状态、关键词或时间依据切换影响；已排除列表保留本期可恢复的任务，不受这些筛选限制。'}};
}
module.exports={queryTaskReview,reviewRange,reviewExclusionKey,BASES};
