'use strict';
const {zipSync,strToU8}=require('fflate');
const R=require('./rules.cjs');
const W=require('./work-calendar.cjs');
const {taskDuration}=require('./task-duration.cjs');

const TZ=8*3600000,DAY=86400000;
const STATE_NAMES=R.STAGES.map(value=>value.replace(/^\d+\./,''));
const EVENT_NAMES={'contribution-calibrated':'负责人校准点数',assign:'分配 / 改派',start:'开始设计',pause:'暂停设计',resume:'继续设计',review:'提交确认',rework:'修改后重做',approve:'运营确认完成',sealed:'完成封存','asset-archived':'上传一类产物','asset-removed':'删除封存产物','requirement-created':'上传需求','imported-existing':'导入原有需求','excel-synced':'Excel 状态同步','contribution-standard-updated':'贡献力标准更新'};

const xml=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const localParts=timestamp=>{const d=new Date(timestamp+TZ);return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()}};
const ymd=timestamp=>{const p=localParts(timestamp);return p.year+'-'+String(p.month).padStart(2,'0')+'-'+String(p.day).padStart(2,'0')};
const localMidnight=(year,month,day)=>Date.UTC(year,month-1,day)-TZ;
function periodRange(frequency,anchor,workPolicies={}){
 if(!['week','month'].includes(frequency))R.fail('请选择周报或月报');
 if(typeof anchor!=='string'||!/^(\d{4})-(\d{2})-(\d{2})$/.test(anchor))R.fail('请选择统计周期内的日期');
 const [,ys,ms,ds]=anchor.match(/^(\d{4})-(\d{2})-(\d{2})$/),year=Number(ys),month=Number(ms),day=Number(ds);
 const exact=localMidnight(year,month,day),check=localParts(exact);
 if(check.year!==year||check.month!==month||check.day!==day)R.fail('统计日期无效');
 let start,end,label,capacity;
 if(frequency==='week'){
  const dow=new Date(Date.UTC(year,month-1,day)).getUTCDay(),offset=(dow+6)%7;
  start=exact-offset*DAY;end=start+7*DAY;label=ymd(start)+' 至 '+ymd(end-DAY);capacity=0;
 }else{
  start=localMidnight(year,month,1);end=month===12?localMidnight(year+1,1,1):localMidnight(year,month+1,1);label=year+'年'+month+'月';capacity=0;
 }
 capacity=W.capacity(start,end,workPolicies).points;
 return {frequency,start,end,label,capacity,fileKey:frequency==='week'?ymd(start)+'_周报':year+'-'+String(month).padStart(2,'0')+'_月报'};
}
const inRange=(value,range)=>Number.isFinite(value)&&value>=range.start&&value<range.end;
const hours=value=>Math.round((Number(value)||0)/360000)/10;
const round=value=>Math.round((Number(value)||0)*100)/100;
const personName=id=>R.PEOPLE.find(person=>person.id===id)?.name||id||'未分配';
const categoryName=id=>R.CATEGORIES.find(category=>category.id===id)?.name||id||'未设置';
const total=task=>{if((task.items||[]).every(i=>Number.isFinite(i.points)))return round(task.items.reduce((sum,item)=>sum+item.points,0));try{return R.total(task)}catch{return round((task.items||[]).reduce((sum,item)=>sum+(Number(item.points)||0),0))}};
const duration=(from,to,policies)=>Number.isFinite(from)&&Number.isFinite(to)&&to>=from?round(W.actualWorkingMs(from,to,policies)/3600000):null;
const dateCell=value=>Number.isFinite(value)?{v:(value+TZ-Date.UTC(1899,11,30))/DAY,s:2}:'';
const dateOnlyCell=value=>Number.isFinite(value)?{v:(value+TZ-Date.UTC(1899,11,30))/DAY,s:5}:'';
const numberCell=value=>Number.isFinite(value)?{v:round(value),s:3}:'';
const percentCell=value=>Number.isFinite(value)?{v:value,s:4}:'';
const textCell=value=>({text:String(value??''),s:6});
const historicalArchive=task=>{const archive=task.historicalArchive;return task.recordOnly&&archive?.status==='archived'&&Number.isFinite(archive.at)&&typeof archive.path==='string'&&archive.path&&Array.isArray(archive.files)&&archive.files.length?archive:null};

function createReport(tasks,events,{frequency,anchor,generatedAt=Date.now(),unavailable=[],workPolicies={},removedPeople=[]}={}){
 const range=periodRange(frequency,anchor,workPolicies),cutoff=Math.min(generatedAt,range.end-1),calendar=W.capacity(range.start,range.end,workPolicies,cutoff),effectiveRange={start:range.start,end:Math.min(range.end,cutoff+1)},eventRows=events.filter(event=>inRange(event.at,effectiveRange)),eventTaskIds=new Set(eventRows.map(event=>event.taskId).filter(Boolean));
 const archiveAtCutoff=task=>{const archive=historicalArchive(task);return archive&&archive.at<=cutoff?archive:null};
 const sealedAt=task=>task.recordOnly?archiveAtCutoff(task)?.at??null:task.sealedAt;
 const sealedInRange=task=>inRange(sealedAt(task),effectiveRange);
 const milestones=task=>[task.requestedAt,task.createdAt,task.assignedAt,task.startedAt,task.reviewAt,task.completedAt,task.sealedAt];
 const selected=tasks.filter(task=>range.start<=cutoff&&(task.recordOnly?task.state===4&&(inRange(task.completedAt,effectiveRange)||sealedInRange(task))&&(!Number.isFinite(task.createdAt)||task.createdAt<=generatedAt):eventTaskIds.has(task.id)||milestones(task).some(value=>inRange(value,effectiveRange))||(Number.isFinite(task.createdAt)&&task.createdAt<=cutoff&&(!Number.isFinite(task.completedAt)||task.completedAt>=range.start))));
 const taskById=new Map(tasks.map(task=>[task.id,task]));
 const durationCache=new Map(),lifeTiming=task=>{if(!durationCache.has(task.id))durationCache.set(task.id,taskDuration(task,{to:cutoff,policies:workPolicies}));return durationCache.get(task.id)};
 const completeTiming=task=>lifeTiming(task).complete;
 const confirmedInRange=task=>!task.completionFromFolder&&task.state===4&&inRange(task.completedAt,effectiveRange);
 const timingQuality=task=>task.recordOnly?'人工补录，未记录工时，不用于时长或效率':completeTiming(task)?'完整有效计时，已排除周六周日及休息时段':lifeTiming(task).label+'；不用于完整人员工时与效率';
 const confirmationSource=task=>task.completionTimeSource==='user-confirmed-date'?'人工补录（完成日期，未记录时刻）':task.completionTimeSource==='file-estimate'?'文件时间推定':task.completionFromFolder?'历史推定，未核实':task.completedAt?'已记录确认':'尚未确认';
 const effectiveTiming=task=>{const t=taskDuration(task,{from:range.start,to:cutoff,policies:workPolicies});return {hours:Number.isFinite(t.recordedMs)?round(t.recordedMs/3600000):null,complete:t.complete,intervals:t.intervals}};
 const supplementedAt=task=>task.reportSupplementedAt??(task.recordOnly?task.createdAt:null);
 const lateSupplement=task=>task.recordOnly&&Number.isFinite(supplementedAt(task))&&supplementedAt(task)>cutoff;
 const taskRows=selected.map(task=>[
  task.id,STATE_NAMES[task.state]||'未知',task.recordOnly?archiveAtCutoff(task)?archiveAtCutoff(task).identification==='pending-code'?'已封存（待69码定位）':'已封存':'未记录':task.sealed?'是':'否',dateCell(task.requestedAt),dateCell(task.createdAt),dateCell(task.assignedAt),dateCell(task.startedAt),dateCell(task.reviewAt),(task.completedTimePrecision==='day'?dateOnlyCell:dateCell)(task.completedAt),dateCell(sealedAt(task)),
  task.brand||'',task.product||'',textCell(task.code),task.title||task.product||'',task.operator||'',personName(task.owner),(task.items||[]).length,numberCell(total(task)),numberCell(completeTiming(task)?lifeTiming(task).ms/3600000:null),numberCell(completeTiming(task)&&lifeTiming(task).ms>0?total(task)/(lifeTiming(task).ms/3600000):null),
  numberCell(task.recordOnly?null:duration(task.requestedAt,task.completedAt,workPolicies)),numberCell(task.recordOnly?null:duration(task.assignedAt,task.startedAt,workPolicies)),numberCell(task.recordOnly?null:duration(task.startedAt,task.completedAt,workPolicies)),confirmedInRange(task)?'是':'否',sealedInRange(task)?'是':'否',task.filename||'',timingQuality(task),confirmationSource(task),dateCell(task.reportSnapshotAt),dateCell(task.reportCalibrationAt),numberCell(effectiveTiming(task).hours),task.recordOnly?'人工补录，未记录区间':effectiveTiming(task).complete?'完整':'仅已记录区间，历史可能缺失',numberCell(!task.recordOnly&&Number.isFinite(task.assignedAt)&&Number.isFinite(task.startedAt)?W.actualWorkingMs(task.assignedAt,task.startedAt,workPolicies)/3600000:null),numberCell(!task.recordOnly&&Number.isFinite(task.reviewAt)&&Number.isFinite(task.completedAt)?W.actualWorkingMs(task.reviewAt,task.completedAt,workPolicies)/3600000:null),task.state===4?task.ratings?.timeliness||'':'',task.recordOnly?'历史任务人工补录':'原需求任务',task.completedTimePrecision==='day'?'日期（未记录时刻）':Number.isFinite(task.completedAt)?'日期和时刻':'未记录',dateCell(supplementedAt(task)),lateSupplement(task)?'周期后补录，非原始截止快照':task.recordOnly?'人工补录记录，非原始需求快照':'周期截止快照',archiveAtCutoff(task)?.productPath||archiveAtCutoff(task)?.path||'',archiveAtCutoff(task)?.identification==='pending-code'?'待69码定位':archiveAtCutoff(task)?'已定位':task.recordOnly?'封存未记录':''
 ]);
 const itemRows=[];
 for(const task of selected)for(const item of task.items||[]){const rate=R.RATES.find(candidate=>candidate.id===item.type);itemRows.push([task.id,task.title||task.product||'',personName(task.owner),STATE_NAMES[task.state]||'未知',task.brand||'',task.product||'',textCell(task.code),item.typeName||rate?.name||item.type||'',categoryName(item.category),item.qty||0,rate?.unit||'项',numberCell(Number.isFinite(item.points)&&item.qty?item.points/item.qty:rate?.points),numberCell(item.points??(rate?R.itemPoints(item):0)),item.note||'',confirmedInRange(task)?'是':'否',numberCell(task.state===4?task.ratings?.quality?.find(r=>r.row===item.row)?.value:null)]);}
 const effectiveIntervals=selected.flatMap(t=>effectiveTiming(t).intervals),personIds=new Set([...selected.map(t=>t.owner||'_unassigned'),...effectiveIntervals.map(s=>s.owner||'_unassigned')]);
 const reportPeople=R.PEOPLE.filter(person=>person.title==='设计师'||personIds.has(person.id));for(const id of personIds)if(!reportPeople.some(p=>p.id===id))reportPeople.push({id,name:id==='_unassigned'?'未分配':personName(id)});
 const peopleRows=reportPeople.map(person=>{
  const mine=selected.filter(task=>(task.owner||'_unassigned')===person.id),completed=mine.filter(task=>confirmedInRange(task)),sealed=mine.filter(sealedInRange);
  const completedPoints=round(completed.reduce((sum,task)=>sum+total(task),0)),actualHours=completed.every(completeTiming)&&(completed.length||!mine.some(task=>task.recordOnly))?round(completed.reduce((sum,task)=>sum+lifeTiming(task).ms/3600000,0)):null;
  const personIntervals=effectiveIntervals.filter(i=>(i.owner||'_unassigned')===person.id),effectiveHours=W.unionHours(personIntervals),involved=selected.filter(t=>mine.includes(t)||personIntervals.some(i=>i.taskId===t.id));
  const activeAtEnd=tasks.filter(task=>task.owner===person.id&&Number.isFinite(task.assignedAt)&&task.assignedAt<=cutoff&&task.state>0&&task.state<4);
  return [person.id,person.name,involved.length,mine.filter(task=>inRange(task.assignedAt,range)).length,mine.filter(task=>inRange(task.startedAt,range)).length,completed.length,sealed.length,numberCell(completedPoints),numberCell(actualHours),numberCell(completed.length?completedPoints/completed.length:null),numberCell(actualHours?completedPoints/actualHours:null),numberCell(range.capacity),percentCell(range.capacity?completedPoints/range.capacity:null),activeAtEnd.length,numberCell(activeAtEnd.reduce((sum,task)=>sum+total(task),0)),numberCell(calendar.elapsedPoints),percentCell(calendar.elapsedPoints?completedPoints/calendar.elapsedPoints:null),numberCell(involved.length&&involved.every(t=>t.recordOnly)?null:effectiveHours),involved.length&&involved.every(t=>effectiveTiming(t).complete)?'完整':involved.some(t=>t.recordOnly)?'含人工补录；仅已有真实计时区间':'仅已记录区间',removedPeople.some(p=>(p.personId===person.id||p.id===person.id)&&(!Number.isFinite(p.at)||p.at<=cutoff))?'已移出，任职目标未折算':'任职与请假未折算'];
 });
 const products=new Map();
 for(const task of selected){const key=[task.brand,task.product,task.code].join('\u0000'),record=products.get(key)||{brand:task.brand||'',product:task.product||'',code:String(task.code||''),tasks:[],types:new Set(),designers:new Set()};record.tasks.push(task);if(task.owner)record.designers.add(personName(task.owner));for(const item of task.items||[])record.types.add(item.typeName||item.type);products.set(key,record)}
 const productRows=[...products.values()].map(record=>{const completed=record.tasks.filter(task=>confirmedInRange(task));return [record.brand,record.product,textCell(record.code),record.tasks.length,completed.length,numberCell(record.tasks.reduce((sum,task)=>sum+total(task),0)),numberCell(completed.reduce((sum,task)=>sum+total(task),0)),[...record.types].join('、'),[...record.designers].join('、')]}).sort((a,b)=>(b[3]||0)-(a[3]||0));
 const flowRows=eventRows.sort((a,b)=>a.at-b.at).map(event=>{const task=taskById.get(event.taskId),body=event.body||{};return [dateCell(event.at),EVENT_NAMES[event.kind]||event.kind,personName(event.actor),task?.title||task?.product||'',task?.brand||'',task?.product||'',textCell(task?.code),Number.isInteger(body.from)?STATE_NAMES[body.from]:'',Number.isInteger(body.to)?STATE_NAMES[body.to]:'',body.reason||'',event.taskId||'']});
 const days=[];
 for(let at=range.start;at<range.end&&at<=cutoff;at+=DAY){const completed=selected.filter(task=>confirmedInRange(task)&&ymd(task.completedAt)===ymd(at));days.push([dateOnlyCell(at),selected.filter(task=>Number.isFinite(task.requestedAt)&&ymd(task.requestedAt)===ymd(at)).length,selected.filter(task=>Number.isFinite(task.assignedAt)&&ymd(task.assignedAt)===ymd(at)).length,selected.filter(task=>Number.isFinite(task.startedAt)&&ymd(task.startedAt)===ymd(at)).length,selected.filter(task=>Number.isFinite(task.reviewAt)&&ymd(task.reviewAt)===ymd(at)).length,completed.length,selected.filter(task=>sealedInRange(task)&&ymd(sealedAt(task))===ymd(at)).length,numberCell(completed.reduce((sum,task)=>sum+total(task),0))]);}
 const infoRows=[
  ['类别','字段 / 工作表','说明'],['报告信息','统计周期',range.label],['报告信息','周期类型',frequency==='week'?'周报（周一至周日）':'月报（自然月）'],['报告信息','生成时间',dateCell(generatedAt)],['报告信息','周期标准容量',range.capacity+' 点 / 人'],
  ['口径','任务范围','包含周期内发生流转的任务，以及在该周期内仍处于进行状态的任务'],['口径','完成贡献力','只统计运营确认完成时间落在本周期内的任务贡献力'],['口径','记录的任务计时','使用软件已记录的设计计时；历史导入任务可能没有完整计时'],['口径','完成点数/参考容量','周期内完成贡献力 ÷ 周期标准容量；容量按工作日及保存的工作时段计算；2026 年含法定放假和调休'],
  ['工作表','任务明细','一行一个任务，含状态、里程碑时间、贡献力和各阶段耗时'],['工作表','事项明细','一行一个事项，适合分析任务类型、数量和贡献力结构'],['工作表','人员汇总','按截止时设计师归属汇总完成点数、记录计时、容量参考与在手任务；多人协作请结合流转事件'],['工作表','产品维度','按品牌 + 产品名 + 69码汇总需求；同名不同69码分开呈现'],['工作表','状态流转','周期内的原始操作事件，可追溯状态变化'],['工作表','每日趋势','按自然日统计新需求、开始、完成、封存和完成贡献力'],
  ['AI 提示词','人员负荷','先查看数据质量，再比较完成点数和在手点数；计时可能重叠，不据此判定人员真实工时、忙闲或绩效'],['AI 提示词','流程瓶颈','使用任务明细的各阶段耗时与状态流转，找出等待时间最长的阶段、任务类型和人员'],['AI 提示词','需求结构','使用事项明细与产品维度，分析高频产品、事项类型、重复需求以及贡献力构成']
 ];
 infoRows.push(['口径','历史状态','原需求任务按周期结束或导出时刻（取较早者）保存的版本还原；负责人对同一完结记录校准的事项与点数应用最新校准，并单列校准时间；升级前无法还原的原需求任务单列在数据质量。人工补录按负责人确认的完成日期另行计入，并非原始截止快照，单列来源、精度与补录时间'],['口径','统计截止',dateCell(cutoff)],['口径','确认时间推定','设计完成或文件修改时间推定的完结记录不计入正式周期完成点数；请先核实'],['口径','计时边界','计时为任务运行历时，可能重叠或跨休息时间，不代表人员实际投入；历史导入/外部编辑计时不完整时留空'],['口径','人工历史补录','只计负责人确认的完成日期和事项点数；仅日期不代表午夜完成。未提供的需求表、69码、运营、流转时间、工时和封存状态均不推造；周期后补录单独标注'],['口径','容量参考','工作日×每日目标点数为排期参考，默认6.4点/天（原32点/周÷5）；未到月末请对照截至当前目标。无任职/请假数据，不作绩效定论']);
 const qualityRows=[['任务ID','需求表文件名','问题','处理'],...unavailable.map(t=>[t.id,t.filename,t.reason,'未混入历史汇总，请核对原始记录']),...selected.filter(t=>!completeTiming(t)||t.completionFromFolder).map(t=>[t.id,t.filename,[!completeTiming(t)?'计时不完整':'',t.completionFromFolder?'确认时间为推定':''].filter(Boolean).join('；'),'计时缺失留空；推定确认不计入周期完成点数'])];
 const sheets=[
  {name:'AI使用说明',rows:infoRows,filter:false},
  {name:'任务明细',rows:[['任务ID','截止时状态','是否封存','需求时间','导入时间','分配时间','开始设计','提交确认','运营确认','封存时间','品牌','产品名','产品69码','任务名','运营','设计师','事项数','标准贡献力（点）','累计记录计时（小时）','点数/记录计时（非人员效率）','需求至确认（小时）','分配至开始（小时）','开始至确认（小时）','本周期完成','本周期封存','需求表文件名','计时完整性','确认时间来源','版本记录时间','点数校准时间','本期有效设计记录（小时）','有效计时覆盖','分配至开始有效等待（小时）','提交至确认有效等待（小时）','运营时效满意度','记录来源','完成时间精度','补录时间','历史口径','封存产品目录','封存定位状态'],...taskRows]},
  {name:'事项明细',rows:[['任务ID','任务名','设计师','截止时状态','品牌','产品名','产品69码','事项类型','资产类别','数量','单位','单个贡献力（点）','事项贡献力（点）','事项说明','本周期完成','运营质量评分（0至100）'],...itemRows]},
  {name:'人员汇总',rows:[['人员ID','设计师','周期涉及任务','周期分配任务','周期开工任务','周期完成任务','周期封存任务','完成贡献力（点）','已完成任务累计记录计时（小时）','平均每项贡献力（点）','点数/记录计时（非人员效率）','周期标准容量（点）','完成点数/参考容量','截止时在手任务','截止时在手贡献力（点）','截至当前目标（点）','完成点数/截至当前目标','本期去重有效记录（小时）','有效记录覆盖','任职口径'],...peopleRows]},
  {name:'产品维度',rows:[['品牌','产品名','产品69码','周期涉及任务','周期完成任务','涉及贡献力（点）','完成贡献力（点）','事项类型','设计师'],...productRows]},
  {name:'状态流转',rows:[['发生时间','事件','操作人','任务名','品牌','产品名','产品69码','原状态','新状态','原因','任务ID'],...flowRows]},
  {name:'数据质量',rows:qualityRows},
  {name:'每日趋势',rows:[['日期','新需求','完成分配','开始设计','提交确认','运营确认完成','完成封存','完成贡献力（点）'],...days]}
 ];
 const effectiveComplete=selected.filter(t=>effectiveTiming(t).complete).length;
 const completed=selected.filter(confirmedInRange),completedPoints=round(completed.reduce((n,t)=>n+total(t),0)),qualityRated=completed.flatMap(t=>(t.items||[]).map(i=>t.ratings?.quality?.find(r=>r.row===i.row)?.value)).filter(Number.isFinite),qualityTotal=completed.reduce((n,t)=>n+t.items.length,0);
 const waiting=selected.filter(t=>t.state>0&&t.state<4).map(t=>({id:t.id,name:t.title||t.product,owner:personName(t.owner),state:STATE_NAMES[t.state],from:t.state===1?t.assignedAt:t.state===3?t.reviewAt:t.startedAt})).filter(t=>Number.isFinite(t.from)&&t.from<=cutoff).map(t=>({...t,hours:round(W.actualWorkingMs(t.from,cutoff,workPolicies)/3600000)})).sort((a,b)=>b.hours-a.hours);
 infoRows.push(['口径','有效时长','按已记录的起止区间与工作时段取交集，始终排除周六、周日，并排除午休、夜间和休假；人员有效记录对同一人并行任务取时间并集。它仍不是考勤或实际专注时间。'],['口径','历史缺失','旧版本仅有累计时长时不推算有效工时，部分区间列示已知值并标明缺失。'],['口径','历史产物封存','人工补录可关联独立的实物封存记录；完成计入原完成日期，封存计入实际封存日期。只使用统计截止前已发生的封存，周期后的封存不倒灌旧月；待69码定位单独标明，不等于已有正式69码'],['口径','自然跨度与有效历时','任务阶段小时数按有效工作时段计算，排除全部周末；起止跨度可能含暂停与等待，不是实际投入。原始累计时间保留在数据库，不再作为实际耗时展示'],['口径','工作日规则','完整规则快照见分析包 data.json 的 metadata.workPolicies 与 defaultPolicy；工作日历页列出每日结果'],['来源','2026法定假日',W.SOURCE],['数据质量','日历核实',calendar.verified?'已核实':'存在未覆盖年度，容量及有效时间为暂估'],['口径','运营评分','只汇总已确认事项的实际评分；缺失留空。质量均分按已评分事项等权，不与任务点数相乘。时效满意度单独列示。']);
 for(const t of selected){
  if(t.recordOnly){
   const archive=archiveAtCutoff(t),missing=[!t.filename?'原需求表缺失':'',!t.code?'产品69码未提供':'',!t.brand?'品牌未提供':'',!t.operator?'运营未提供':'','仅有完成日期，未记录完成时刻','未记录设计工时与流转时间',archive?archive.identification==='pending-code'?'产物已实物封存，待69码定位':'产物已实物封存':'封存状态未记录'].filter(Boolean);
   qualityRows.push([t.id,t.filename||'',missing.join('；'),'负责人确认的历史完成日期和事项点数计入完成汇总；其他未知字段留空，不用于时长或效率分析']);
   if(lateSupplement(t))qualityRows.push([t.id,t.filename||'','周期后人工补录，非原始截止快照','补录时间 '+new Date(supplementedAt(t)).toISOString()+'；作为有来源说明的历史补充计入原完成日期，不伪造原表或当时版本']);
  }else if(!effectiveTiming(t).complete)qualityRows.push([t.id,t.filename,'有效计时区间不完整','仅列已知区间，不用于完整工时比较']);
 }
 sheets.push({name:'工作日历',rows:[['日期','是否工作日','依据','有效小时','日目标点数','截至当前有效小时','截至当前目标点数','日历已核实'],...calendar.days.map(d=>[d.date,d.working?'是':'否',d.reason,numberCell(d.hours),numberCell(d.points),numberCell(d.elapsedHours),numberCell(d.elapsedPoints),d.verified?'是':'否'])]});
 sheets.push({name:'计时区间',rows:[['任务ID','人员ID','设计师','记录起点','记录终点','本期交集起点','本期交集终点','本期有效小时','记录说明'],...selected.filter(t=>!t.recordOnly).flatMap(t=>W.trackedIntervals(t,cutoff).filter(s=>s.end>range.start&&s.start<cutoff).map(s=>[t.id,s.owner||'',personName(s.owner),dateCell(s.start),dateCell(s.end),dateCell(Math.max(range.start,s.start)),dateCell(Math.min(cutoff,s.end)),numberCell(W.actualWorkingMs(Math.max(range.start,s.start),Math.min(cutoff,s.end),workPolicies)/3600000),'程序记录的运行区间；人员统计取并集，非考勤']))]});
 const metrics={completedTasks:completed.length,completedPoints,sealedTasks:selected.filter(sealedInRange).length,selectedTasks:selected.length,effectiveCompleteTasks:effectiveComplete,unavailableTasks:unavailable.length,historicalSupplementTasks:selected.filter(t=>t.recordOnly).length,historicalBackfillTasks:selected.filter(lateSupplement).length,qualityRatedItems:qualityRated.length,qualityTotalItems:qualityTotal,qualityMean:qualityRated.length?round(qualityRated.reduce((n,v)=>n+v,0)/qualityRated.length):null};
 sheets.push({name:'管理摘要',rows:[['指标','数值','口径'],['本期确认任务',completed.length,'运营确认时间或负责人确认的历史完成日期在本周期；人工补录单列来源，不表示原始截止快照'],['本期完成点数',numberCell(completedPoints),'可与人员、产品、事项明细对账'],['每人整期目标',numberCell(calendar.points),'自然月/周内实际工作日'],['每人截至当前目标',numberCell(calendar.elapsedPoints),'仅计算已过去的有效时段'],['有效计时完整任务',effectiveComplete,selected.length+' 个周期涉及任务'],['无法还原历史任务',unavailable.length,'排除于各汇总'],['人工历史补录任务',metrics.historicalSupplementTasks,'按负责人确认的完成日期计入，未记录的时刻、工时与封存状态留空'],['其中周期后补录',metrics.historicalBackfillTasks,'不属于原始截止快照，详见任务明细补录时间与数据质量'],['已评分事项',qualityRated.length,qualityTotal+' 个本期完成事项'],['运营质量均分',numberCell(metrics.qualityMean),'仅已评分事项，缺失不填0'],['日历状态',calendar.verified?'已核实':'暂估','未来未发布/未内置年度不可视为正式目标']]});
 sheets.push({name:'待处理环节',rows:[['任务ID','任务名','负责人','截止时状态','进入阶段时间','阶段有效历时（小时）','说明'],...waiting.map(t=>[t.id,t.name,t.owner,t.state,dateCell(t.from),numberCell(t.hours),t.state==='设计中'?'含暂停，不能当作实际设计投入':'工作日有效等待；先核实原因再处理'])]});
 const report={bytes:workbook(sheets,generatedAt),range,counts:{tasks:selected.length,items:itemRows.length,events:eventRows.length},sheets,calendar,cutoff,generatedAt,metrics,workPolicies};
 return {...report,...require('./report-analysis.cjs').analysisBundle(report)};
}

function columnName(index){let value='';for(let n=index+1;n;n=Math.floor((n-1)/26))value=String.fromCharCode(65+(n-1)%26)+value;return value}
function cellXml(value,row,column){
 const ref=columnName(column)+row;
 if(value&&typeof value==='object'&&Object.hasOwn(value,'v'))return '<c r="'+ref+'" s="'+(value.s||0)+'"><v>'+value.v+'</v></c>';
 if(value&&typeof value==='object'&&Object.hasOwn(value,'text'))return '<c r="'+ref+'" s="'+(value.s||0)+'" t="inlineStr"><is><t>'+xml(value.text)+'</t></is></c>';
 if(typeof value==='number'&&Number.isFinite(value))return '<c r="'+ref+'"><v>'+value+'</v></c>';
 const text=String(value??'');return '<c r="'+ref+'" t="inlineStr"><is><t'+(/^\s|\s$|\n/.test(text)?' xml:space="preserve"':'')+'>'+xml(text)+'</t></is></c>';
}
function sheetXml(sheet){
 const rows=sheet.rows.length?sheet.rows:[['暂无数据']],columns=Math.max(...rows.map(row=>row.length)),last=columnName(columns-1),widths=[];
 for(let column=0;column<columns;column++){let width=8;for(const row of rows.slice(0,250)){const value=row[column],text=value&&typeof value==='object'?'2026-09-04 12:00':String(value??'');width=Math.max(width,Math.min(42,[...text].reduce((n,char)=>n+(char.charCodeAt(0)>255?2:1),0)+2))}widths.push(width)}
 const body=rows.map((row,index)=>{let lines=1;for(let c=0;c<row.length;c++){const v=row[c],text=v&&typeof v==='object'?(v.text??(v.s===2?'2026-09-04 12:00':v.v??'')):String(v??'');const length=[...String(text)].reduce((n,ch)=>n+(ch.charCodeAt(0)>255?2:1),0);lines=Math.max(lines,Math.ceil(length/Math.max(8,widths[c]-3)))}const height=Math.min(409,Math.max(index===0?38:24,lines*17+8));return '<row r="'+(index+1)+'" ht="'+height+'" customHeight="1">'+row.map((value,column)=>{const cell=cellXml(value,index+1,column);return index===0?cell.replace('<c ','<c s="1" '):cell}).join('')+'</row>'}).join('');
 const filter=sheet.filter===false?'':'<autoFilter ref="A1:'+last+rows.length+'"/>';
 return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="21"/><cols>'+widths.map((width,index)=>'<col min="'+(index+1)+'" max="'+(index+1)+'" width="'+width+'" customWidth="1"/>').join('')+'</cols><sheetData>'+body+'</sheetData>'+filter+'<pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>';
}
function workbook(sheets,createdAt){
 const files={};
 const types=sheets.map((_,index)=>'<Override PartName="/xl/worksheets/sheet'+(index+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('');
 files['[Content_Types].xml']=strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'+types+'</Types>');
 files['_rels/.rels']=strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>');
 files['docProps/core.xml']=strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>设计协作多维数据分析</dc:title><dc:creator>Design by Mason Zeng</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">'+new Date(createdAt).toISOString()+'</dcterms:created></cp:coreProperties>');
 files['xl/workbook.xml']=strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>'+sheets.map((sheet,index)=>'<sheet name="'+xml(sheet.name)+'" sheetId="'+(index+1)+'" r:id="rId'+(index+1)+'"/>').join('')+'</sheets><calcPr calcId="191029"/></workbook>');
 files['xl/_rels/workbook.xml.rels']=strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+sheets.map((_,index)=>'<Relationship Id="rId'+(index+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'+(index+1)+'.xml"/>').join('')+'<Relationship Id="rId'+(sheets.length+1)+'" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
 files['xl/styles.xml']=strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="4"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="165" formatCode="0.00"/><numFmt numFmtId="166" formatCode="0.0%"/><numFmt numFmtId="167" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/><family val="2"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Microsoft YaHei"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2563D9"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFD9E2F2"/></left><right style="thin"><color rgb="FFD9E2F2"/></right><top style="thin"><color rgb="FFD9E2F2"/></top><bottom style="thin"><color rgb="FFD9E2F2"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
 sheets.forEach((sheet,index)=>files['xl/worksheets/sheet'+(index+1)+'.xml']=strToU8(sheetXml(sheet)));
 return Buffer.from(zipSync(files,{level:6}));
}

module.exports={createReport,periodRange,ymd};
