'use strict';
// Date-only supplements are records of confirmed history, never synthetic workbooks.
const crypto=require('node:crypto'),R=require('./rules.cjs');
const TYPE='packaging-design',SOURCE='historical-supplement',TZ=8*3600000;
const dayKey=at=>new Date(at+TZ).toISOString().slice(0,10);
function dateAnchor(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))R.fail('完成日期须为 YYYY-MM-DD');
 const [year,month,day]=value.split('-').map(Number),at=Date.UTC(year,month-1,day)-TZ;
 if(year<1900||!Number.isFinite(at)||dayKey(at)!==value)R.fail('完成日期无效');
 return at;
}
function optionalText(value,label,max=300){
 if(value===undefined||value===null||value==='')return null;
 if(typeof value!=='string'||value.length>max)R.fail(label+'无效');
 return value.trim()||null;
}
function identity(owner,product,completedDate){return JSON.stringify([owner,product,completedDate,TYPE])}
function historicalId(owner,product,completedDate,qty){
 const bytes=crypto.createHash('sha256').update('design-workbench:historical-supplement:v1:'+identity(owner,product,completedDate)+':'+qty).digest().subarray(0,16);
 bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
 const hex=bytes.toString('hex');return hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
}
function packagingCount(task){
 const rows=(task.items||[]).filter(i=>i.type===TYPE);if(!rows.length||rows.some(i=>!Number.isInteger(i.qty)||i.qty<1))return null;
 return rows.reduce((sum,i)=>sum+i.qty,0);
}
function completionDate(task){
 if(task.completedTimePrecision==='day'&&typeof task.completedDate==='string')return task.completedDate;
 return Number.isFinite(task.completedAt)?dayKey(task.completedAt):null;
}
function isHistoricalTask(task){
 try{
  if(!task||typeof task!=='object'||task.recordOnly!==true||task.source!==SOURCE||task.deleted||task.version!==1||task.state!==4||task.sealed!==false||task.archiveStatus!=='not-recorded')return false;
  if(typeof task.owner!=='string'||!task.owner||typeof task.product!=='string'||!task.product.trim()||typeof task.id!=='string')return false;
  if(task.completedTimePrecision!=='day'||task.completedAt!==dateAnchor(task.completedDate)||task.completedMonth!==task.completedDate.slice(0,7))return false;
  if(task.completionFromFolder!==false||task.completionTimeSource!=='user-confirmed-date')return false;
  if(!Number.isFinite(task.createdAt)||!Number.isFinite(task.supplementedAt)||task.filename!=null||task.elapsedMs!==0||task.runningSince!=null||task.timingIncomplete!==true)return false;
  if(task.createdAt<task.completedAt||typeof task.confirmedBy!=='string'||!task.confirmedBy||task.importedTiming!==true||task.timingTracked!==false||!Array.isArray(task.workIntervals)||task.workIntervals.length)return false;
  if(['requestedAt','assignedAt','startedAt','reviewAt','sealedAt'].some(k=>task[k]!=null))return false;
  if(!Array.isArray(task.items)||task.items.length!==1)return false;
  const item=task.items[0];if(item.type!==TYPE||item.row!==6||item.category!=='packaging'||item.product!==task.product||item.brand!==task.brand||item.code!==task.code||item.points!==R.itemPoints(item))return false;
  if(task.code!==null&&!R.validCode(task.code))return false;
  return task.id===historicalId(task.owner,task.product,task.completedDate,item.qty);
 }catch{return false}
}
function assertNoWorkbookOps(task){if(task?.recordOnly||task?.source===SOURCE)R.fail('这是历史补录记录，没有关联原需求表或封存产物，不能执行需求流转、原表或封存操作',409)}
function prepareHistoricalTasks(rows,{existingTasks=[],existingHistorical=[],people=R.PEOPLE,now=Date.now(),actor='zeng',source='user-confirmed-historical'}={}){
 if(!Array.isArray(rows)||!rows.length||rows.length>1000)R.fail('请提供 1 至 1000 条历史记录');
 if(!Number.isFinite(now)||now<0||!Number.isFinite(new Date(now).getTime())||typeof actor!=='string'||!actor.trim()||typeof source!=='string'||!source.trim())R.fail('补录来源或时间无效');
 const today=dayKey(now),known=new Map(),records=[],skipped=[];
 for(const previous of [...existingTasks,...existingHistorical]){
  if(previous.deleted||previous.state!==4)continue;
  const date=completionDate(previous),qty=packagingCount(previous);if(!date||qty===null)continue;
  const key=identity(previous.owner,previous.product,date);if(!known.has(key))known.set(key,[]);known.get(key).push({id:previous.id,qty});
 }
 rows.forEach((row,index)=>{
  if(!row||typeof row!=='object'||Array.isArray(row))R.fail('第 '+(index+1)+' 条历史记录无效');
  const person=people.find(p=>(p.id===row.owner||p.name===row.owner)&&p.title==='设计师'&&!p.removed);
  if(!person)R.fail('第 '+(index+1)+' 条记录的设计师不存在或已移出组织');
  if(typeof row.product!=='string'||!row.product.trim()||row.product.length>500)R.fail('第 '+(index+1)+' 条记录的产品名无效');
  const completedAt=dateAnchor(row.completedDate);if(row.completedDate>today)R.fail('完成日期不能晚于今天');
  const qty=row.qty,points=R.itemPoints({type:TYPE,qty}),key=identity(person.id,row.product,row.completedDate),matches=known.get(key)||[];
  if(matches.some(p=>p.qty!==qty))R.fail('第 '+(index+1)+' 条记录与现有同人员、产品、完成日期的包装设计数量不同，请先核对，未覆盖原记录',409);
  if(matches.length){skipped.push({index,owner:person.id,product:row.product,completedDate:row.completedDate,qty,id:matches[0].id,reason:'已有相同人员、产品、完成日期和数量的包装设计记录'});return}
  const brand=optionalText(row.brand,'品牌'),code=optionalText(row.code,'69码'),operator=optionalText(row.operator,'运营'),note=optionalText(row.note,'备注',2000),sourceKey=optionalText(row.sourceKey,'来源编号',500);
  if(code!==null&&!R.validCode(code))R.fail('提供的69码须为以69开头的13位数字；未知时请留空');
  const id=historicalId(person.id,row.product,row.completedDate,qty),item={id:'row-6',row:6,type:TYPE,typeName:'包装设计',category:'packaging',qty,extra:0,points,brand,workbookBrand:brand,product:row.product,code,linkId:null,note,sealed:false};
  const record={id,recordOnly:true,source:SOURCE,supplementSource:source,sourceKey,version:1,title:row.product,product:row.product,brand,workbookBrand:brand,code,operator,owner:person.id,requestedDesigner:person.name,items:[item],state:4,sealed:false,archiveStatus:'not-recorded',completedAt,completedDate:row.completedDate,completedTimePrecision:'day',completedMonth:row.completedDate.slice(0,7),completionFromFolder:false,completionTimeSource:'user-confirmed-date',createdAt:now,updatedAt:now,supplementedAt:now,confirmedBy:actor,confirmationMethod:'负责人确认的历史完成日期（仅日期，无具体时刻）',filename:null,requestedAt:null,assignedAt:null,startedAt:null,reviewAt:null,sealedAt:null,assignmentId:null,receivedAt:null,readAt:null,elapsedMs:0,runningSince:null,importedTiming:true,timingIncomplete:true,timingTracked:false,workIntervals:[],ratings:null,note};
  records.push(record);known.set(key,[{id,qty}]);
 });
 return {records,skipped,summary:{inputCount:rows.length,createdCount:records.length,skippedCount:skipped.length,totalQty:records.reduce((sum,t)=>sum+t.items[0].qty,0),totalPoints:records.reduce((sum,t)=>sum+t.items[0].points,0)}};
}
module.exports={prepareHistoricalTasks,isHistoricalTask,assertNoWorkbookOps,historicalId};
