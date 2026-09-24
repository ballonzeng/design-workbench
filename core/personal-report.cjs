'use strict';
const R=require('./rules.cjs');
const {workbook,ymd}=require('./report.cjs');

const DAY=86400000,TZ=8*3600000;
const round=value=>Math.round(value*100)/100;
const numberCell=value=>Number.isFinite(value)?{v:round(value),s:3}:'';
const quantityCell=value=>Number.isFinite(value)?round(value):'';
const dateCell=value=>Number.isFinite(value)?{v:(value+TZ-Date.UTC(1899,11,30))/DAY,s:2}:'';
const dateOnlyCell=value=>Number.isFinite(value)?{v:(value+TZ-Date.UTC(1899,11,30))/DAY,s:5}:'';
// All user-supplied strings use inline text cells, including strings beginning with =.
const textCell=value=>({text:String(value??''),s:6});
const inRange=(value,range)=>Number.isFinite(value)&&value>=range.start&&value<range.end;
const TYPE_CATEGORIES={
 'photo-six':'six','model-six':'six',creative:'creative','creative-adjust':'creative',
 'video-image':'video','video-basic':'video','video-zero':'video',
 'detail-adjust':'detail','detail-full':'detail','main-set':'main','main-full':'main','sku-set':'sku','sku-full':'sku'
};
const categoryName=id=>R.CATEGORIES.find(category=>category.id===id)?.name;
const groupKey=(name,unit)=>JSON.stringify([name,unit]);

function midnight(value,label){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))R.fail('请选择有效的'+label+'（YYYY-MM-DD）');
 const [year,month,day]=value.split('-').map(Number),at=Date.UTC(year,month-1,day)-TZ;
 if(ymd(at)!==value)R.fail(label+'无效');
 return at;
}

function personalRange({frequency,anchor,startDate,endDate}={}){
 if(!['week','month','custom'].includes(frequency))R.fail('请选择周、月或自选日期范围');
 let start,end,label;
 if(frequency==='custom'){
  start=midnight(startDate,'开始日期');end=midnight(endDate,'结束日期')+DAY;
  if(end<=start)R.fail('结束日期不能早于开始日期');
  if((end-start)/DAY>366)R.fail('自选日期范围最多为366天');
 }else{
  const at=midnight(anchor,'统计日期'),date=new Date(at+TZ),year=date.getUTCFullYear(),month=date.getUTCMonth();
  if(frequency==='week'){start=at-((date.getUTCDay()+6)%7)*DAY;end=start+7*DAY}
  else{start=Date.UTC(year,month,1)-TZ;end=Date.UTC(year,month+1,1)-TZ;label=year+'年'+(month+1)+'月'}
 }
 startDate=ymd(start);endDate=ymd(end-DAY);label??=startDate+' 至 '+endDate;
 const fileKey=frequency==='week'?startDate+'_周报':frequency==='month'?startDate.slice(0,7)+'_月报':startDate+'_'+endDate;
 return {frequency,start,end,startDate,endDate,label,fileKey};
}

function createPersonalReport(tasks,{personId,personName,frequency,anchor,startDate,endDate,generatedAt=Date.now(),unavailable=[]}={}){
 if(typeof personId!=='string'||!personId.trim())R.fail('缺少导出人员身份');
 if(!Number.isFinite(generatedAt)||!Number.isFinite(new Date(generatedAt).getTime()))R.fail('导出时间无效');
 const range=personalRange({frequency,anchor,startDate,endDate}),cutoff=Math.min(generatedAt,range.end-1),effectiveRange={start:range.start,end:cutoff+1};
 const name=personName||R.PEOPLE.find(person=>person.id===personId)?.name||personId;
 const issues=[],issue=(task,message,handling,row='')=>issues.push(['数据问题',task?.id||'',task?.filename||'',row,message,handling]);
 const mine=tasks.filter(task=>task.owner===personId),selected=[],excluded=[];
 for(const task of mine){
  const completedHere=inRange(task.completedAt,effectiveRange);
  const estimated=task.completionFromFolder||/estimate/i.test(task.completionTimeSource||'');
  if(completedHere&&task.state===4&&!estimated){selected.push(task);continue}
  if(completedHere){
   excluded.push(task);
   issue(task,estimated?'完成时间为推定，未计入正式完成':'统计截止时任务未完结，未计入正式完成','核实运营确认记录后重新导出');
  }else if(task.state===4&&!Number.isFinite(task.completedAt)&&[task.requestedAt,task.createdAt,task.reviewAt,task.reportSnapshotAt].some(value=>inRange(value,effectiveRange))){
   excluded.push(task);issue(task,'任务已完结但缺少完成时间，无法归入本期','补充真实运营确认时间后重新导出');
  }
 }
 selected.sort((a,b)=>a.completedAt-b.completedAt||String(a.id).localeCompare(String(b.id)));
 // Missing historical ownership cannot safely be attributed to this person.
 // Only disclose an anonymous warning, never raw task names or an inferred count.
 if(unavailable.length)issues.push(['历史记录说明','','','','部分历史记录无法还原当时归属和明细，已排除于本次报表','请核对原始记录；不计作本人排除任务数量']);

 const groups=new Map();
 const addGroup=(name,unit)=>{const key=groupKey(name,unit);if(!groups.has(key))groups.set(key,{key,name,unit});return key};
 for(const [name,unit] of [['SKU','张'],['主图','张'],['详情页','张'],['详情页','屏']])addGroup(name,unit);
 const prepared=selected.map(task=>{
  const taskItems=Array.isArray(task.items)?task.items:[];
  if(!taskItems.length)issue(task,'已完结任务没有事项明细','核对原需求表；数量与点数暂列0');
  const items=taskItems.map((item,index)=>{
   const rate=R.RATES.find(rate=>rate.id===item.type)||R.RATES.find(rate=>R.normalize(rate.name)===R.normalize(item.typeName||item.type));
   const typeName=item.typeName||rate?.name||item.type||'未记录事项类型';
   const category=TYPE_CATEGORIES[rate?.id||item.type],quantityName=categoryName(category)||typeName;
   const unit=typeof item.unit==='string'&&item.unit.trim()?item.unit.trim():rate?.unit||'未记录单位';
   const key=addGroup(quantityName,unit),qty=Number.isFinite(item.qty)&&item.qty>=0?item.qty:null;
   let points=Number.isFinite(item.points)&&item.points>=0?item.points:null,pointSource='保存点数';
   if(points===null){
    try{points=R.itemPoints({...item,type:rate?.id||item.type});pointSource='按当前标准补算'}catch{pointSource='缺少有效点数'}
    issue(task,points===null?'事项缺少有效点数':'事项未保存有效点数，已按当前标准补算',points===null?'汇总仅含已知点数，请核对原需求表':'补算点数可能与历史标准不同，请核对',item.row??index+1);
   }
   if(qty===null)issue(task,'事项数量无效，未计入数量汇总','核对原需求表；已保存的有效点数仍保留',item.row??index+1);
   if(!category)issue(task,'事项未明确对应SKU、主图等类别，按原事项类型列示','未根据上传目录推断工作量类别',item.row??index+1);
   if(unit==='未记录单位')issue(task,'事项没有可确认的数量单位','保留数量并标注未记录单位，不换算成张',item.row??index+1);
   return {item,index,typeName,quantityName,category,unit,key,qty,points,pointSource};
  });
  const quantities=new Map();for(const item of items)if(item.qty!==null)quantities.set(item.key,round((quantities.get(item.key)||0)+item.qty));
  const points=round(items.reduce((sum,item)=>sum+(item.points??0),0));
  return {task,items,quantities,points,pointQuality:!items.length?'无事项明细':items.some(item=>item.points===null)?'仅已知点数':items.some(item=>item.pointSource==='按当前标准补算')?'含按当前标准补算':'保存点数'};
 });
 const columns=[...groups.values()],quantityHeaders=columns.map(group=>group.name+'（'+group.unit+'）');
 const counts={tasks:selected.length,items:prepared.reduce((sum,entry)=>sum+entry.items.length,0),points:round(prepared.reduce((sum,entry)=>sum+entry.points,0)),excluded:excluded.length,warnings:issues.length};
 const summaryQuantities=columns.map(group=>quantityCell(prepared.reduce((sum,entry)=>sum+(entry.quantities.get(group.key)||0),0)));
 const taskRows=prepared.map(({task,items,quantities,points,pointQuality})=>[
  task.title||task.product||task.filename||task.id,
  [...quantities].map(([key,qty])=>{const group=groups.get(key);return group.name+' '+qty+' '+group.unit}).join('；'),
  ...columns.map(group=>quantityCell(quantities.get(group.key)||0)),numberCell(points),dateCell(task.completedAt),dateCell(task.reviewAt),name,
  task.brand||'',task.product||'',textCell(task.code),items.length,task.operator||'',task.id,task.filename||'',
  dateCell(task.reportSnapshotAt),dateCell(task.reportCalibrationAt),pointQuality,task.completionTimeSource==='app-confirmed'?'软件记录运营确认':task.completionTimeSource==='workbook-confirmed'?'需求表确认时间':'已记录确认时间'
 ]);
 const itemRows=prepared.flatMap(({task,items})=>items.map(({item,index,typeName,quantityName,category,unit,qty,points,pointSource})=>[
  task.title||task.product||task.filename||task.id,typeName,quantityName,category?'明确事项类型':'原事项类型（类别未明确）',quantityCell(qty),unit,numberCell(points),pointSource,
  item.note||'',dateCell(task.completedAt),name,item.brand||task.brand||'',item.product||task.product||'',textCell(item.code??task.code),textCell(item.linkId),task.id,item.row??index+1,item.id||'',task.filename||'',dateCell(task.reportCalibrationAt)
 ]));
 const infoRows=[
  ['项目','说明'],['统计人员',name+'（'+personId+'）'],['统计周期',range.label],['日期时区','Asia/Shanghai（北京时间），自选结束日期包含当天'],
  ['生成时间',dateCell(generatedAt)],['统计截止',dateCell(cutoff)],['完成口径','仅统计截止时归属本人、状态为已完结，且真实运营确认完成时间在所选周期内的任务；以完成时间归期'],
  ['提交与完成','提交确认时间表示设计提交，完成时间表示运营确认；待确认或进行中任务不计入完成任务'],
  ['返工轮次','返工任务按统计截止时的当前完成轮次判断，每个任务只列一行；重复提交不重复计数，截止时已回退为未完结的任务不计入完成'],
  ['跨周期返工','同一任务跨周返工后重新确认，可能出现在两个周报中；月报按月末最新完成轮次计一次，因此周报合计未必等于月报；不额外拆算返工量'],
  ['多人接力','任务完成点数按统计截止时的设计师归属汇总，不自动按参与人数或接力时长拆分；历史归属以可追溯快照为准'],
  ['封存时间','是否封存及封存时间不影响完成归期，任务统一按真实运营确认完成时间归期'],
  ['数量口径','数量来自需求表事项工作量，不是上传文件数；同类同单位可相加，不跨张、屏、条等单位换算'],
  ['分类口径','SKU、主图、详情页等根据明确事项类型归类；通用修改、尺寸适配等保留原事项类型，不按归档目录猜测'],
  ['点数口径','优先使用历史快照或负责人校准后保存的事项点数；缺失时按当前标准补算并标注；无法补算时留空，汇总仅含已知点数'],
  ['历史与校准','使用统计截止时的历史快照；对同一完结记录的负责人校准可更新事项和点数，点数校准时间单独列示'],
  ['排除任务数','仅计可确认属于本人的本期异常完成记录；无法还原历史归属的记录仅给匿名说明，不计为本人任务数'],
  ['数据问题数','问题行数量，同一任务可有多条；请结合数据问题页核对'],['空周期','没有符合完成口径的任务时仍输出表头及0汇总'],
  ['工作量含义','点数及需求数量反映已完成需求工作量，不等同于真实投入工时；报表不计算工时效率或绩效']
 ];
 const sheets=[
  {name:'个人汇总',rows:[['设计师','开始日期','结束日期','完成任务数','事项数',...quantityHeaders,'完成点数','排除任务数','数据问题数','点数完整性','生成时间','统计截止'],[name,dateOnlyCell(range.start),dateOnlyCell(range.end-DAY),counts.tasks,counts.items,...summaryQuantities,numberCell(counts.points),counts.excluded,counts.warnings,prepared.some(entry=>entry.pointQuality==='仅已知点数'||entry.pointQuality==='无事项明细')?'存在缺失，仅汇总已知点数':prepared.some(entry=>entry.pointQuality==='含按当前标准补算')?'含按当前标准补算':'完整',dateCell(generatedAt),dateCell(cutoff)]]},
  {name:'任务明细',rows:[['任务名','内容数量明细',...quantityHeaders,'任务点数','完成时间（运营确认）','提交确认时间','设计师','品牌','产品名','产品69码','事项数','运营','任务ID','需求表文件名','版本记录时间','点数校准时间','点数口径','完成时间来源'],...taskRows]},
  {name:'事项明细',rows:[['任务名','原事项类型','数量分类','分类依据','数量','单位','事项点数','点数来源','事项说明','完成时间（运营确认）','设计师','品牌','产品名','产品69码','关联ID','任务ID','需求表行号','事项ID','需求表文件名','点数校准时间'],...itemRows]},
  {name:'统计说明',rows:infoRows,filter:false},
  {name:'数据问题',rows:[['类别','任务ID','需求表文件名','需求表行号','问题','说明 / 处理建议'],...issues]}
 ];
 return {bytes:workbook(sheets,generatedAt),range,counts,sheets};
}

module.exports={personalRange,createPersonalReport};
