'use strict';
const R=require('./rules.cjs');
const {workbook,ymd}=require('./report.cjs');

const DAY=86400000,TZ=8*3600000;
const dateOnlyCell=value=>({v:Math.floor((value+TZ-Date.UTC(1899,11,30))/DAY),s:5});
// Keep literal text (including formula-like input) and discard characters invalid in XML.
const text=value=>String(value??'').replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu,'');
const textCell=value=>({text:text(value),s:6});
const inRange=(value,range)=>Number.isFinite(value)&&value>=range.start&&value<range.end;

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

function itemDetail(item){
 const rate=R.RATES.find(rate=>rate.id===item.type)||R.RATES.find(rate=>R.normalize(rate.name)===R.normalize(item.typeName||item.type));
 const typeName=item.typeName||rate?.name||item.type||'';
 const unit=typeof item.unit==='string'&&item.unit.trim()?item.unit.trim():rate?.unit||'';
 const parsedQuantity=typeof item.qty==='number'?item.qty:typeof item.qty==='string'&&item.qty.trim()?Number(item.qty):NaN;
 const quantity=Number.isFinite(parsedQuantity)&&parsedQuantity>=0?parsedQuantity:'';
 return [text(typeName+(item.note?'（'+item.note+'）':'')),quantity===''?'':unit&&unit!=='张'?text(quantity+unit):quantity];
}

function createPersonalReport(tasks,{personId,personName,frequency,anchor,startDate,endDate,generatedAt=Date.now()}={}){
 if(typeof personId!=='string'||!personId.trim())R.fail('缺少导出人员身份');
 if(!Number.isFinite(generatedAt)||!Number.isFinite(new Date(generatedAt).getTime()))R.fail('导出时间无效');
 const range=personalRange({frequency,anchor,startDate,endDate}),cutoff=Math.min(generatedAt,range.end-1),effectiveRange={start:range.start,end:cutoff+1};
 const name=personName||R.PEOPLE.find(person=>person.id===personId)?.name||personId;
 const selected=tasks.filter(task=>task.owner===personId&&task.state===4&&inRange(task.completedAt,effectiveRange)&&!task.completionFromFolder&&!/estimate/i.test(task.completionTimeSource||''));
 selected.sort((a,b)=>a.completedAt-b.completedAt||String(a.id).localeCompare(String(b.id)));
 const rows=[['日期','69码','对接运营','设计者','任务名','事项','张数']];
 let items=0;
 for(const task of selected){
  const taskItems=Array.isArray(task.items)?task.items:[];items+=taskItems.length;
  const taskColumns=[dateOnlyCell(task.completedAt),textCell(task.code),text(task.operator),text(name),text(task.title||task.product||task.filename||task.id)];
  if(!taskItems.length)rows.push([...taskColumns,'','']);
  else for(const item of taskItems)rows.push([...taskColumns,...itemDetail(item)]);
 }
 const sheets=[{name:'任务明细',rows}],counts={tasks:selected.length,items};
 return {bytes:workbook(sheets,generatedAt),range,counts,sheets};
}

module.exports={personalRange,createPersonalReport};
