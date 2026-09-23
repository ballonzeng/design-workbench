'use strict';
const {zipSync,strToU8}=require('fflate');
const R=require('./rules.cjs');

const TZ=8*3600000,DAY=86400000;
const STATE_NAMES=R.STAGES.map(value=>value.replace(/^\d+\./,''));
const EVENT_NAMES={'contribution-calibrated':'负责人校准点数',assign:'分配 / 改派',start:'开始设计',pause:'暂停设计',resume:'继续设计',review:'提交确认',rework:'修改后重做',approve:'运营确认完成',sealed:'完成封存','asset-archived':'上传一类产物','asset-removed':'删除封存产物','requirement-created':'上传需求','imported-existing':'导入原有需求','excel-synced':'Excel 状态同步','contribution-standard-updated':'贡献力标准更新'};

const xml=value=>String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const localParts=timestamp=>{const d=new Date(timestamp+TZ);return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()}};
const ymd=timestamp=>{const p=localParts(timestamp);return p.year+'-'+String(p.month).padStart(2,'0')+'-'+String(p.day).padStart(2,'0')};
const localMidnight=(year,month,day)=>Date.UTC(year,month-1,day)-TZ;
function periodRange(frequency,anchor){
 if(!['week','month'].includes(frequency))R.fail('请选择周报或月报');
 if(typeof anchor!=='string'||!/^(\d{4})-(\d{2})-(\d{2})$/.test(anchor))R.fail('请选择统计周期内的日期');
 const [,ys,ms,ds]=anchor.match(/^(\d{4})-(\d{2})-(\d{2})$/),year=Number(ys),month=Number(ms),day=Number(ds);
 const exact=localMidnight(year,month,day),check=localParts(exact);
 if(check.year!==year||check.month!==month||check.day!==day)R.fail('统计日期无效');
 let start,end,label,capacity;
 if(frequency==='week'){
  const dow=new Date(Date.UTC(year,month-1,day)).getUTCDay(),offset=(dow+6)%7;
  start=exact-offset*DAY;end=start+7*DAY;label=ymd(start)+' 至 '+ymd(end-DAY);capacity=32;
 }else{
  start=localMidnight(year,month,1);end=month===12?localMidnight(year+1,1,1):localMidnight(year,month+1,1);label=year+'年'+month+'月';capacity=139.2;
 }
 return {frequency,start,end,label,capacity,fileKey:frequency==='week'?ymd(start)+'_周报':year+'-'+String(month).padStart(2,'0')+'_月报'};
}
const inRange=(value,range)=>Number.isFinite(value)&&value>=range.start&&value<range.end;
const hours=value=>Math.round((Number(value)||0)/360000)/10;
const round=value=>Math.round((Number(value)||0)*100)/100;
const personName=id=>R.PEOPLE.find(person=>person.id===id)?.name||id||'未分配';
const categoryName=id=>R.CATEGORIES.find(category=>category.id===id)?.name||id||'未设置';
const total=task=>{if((task.items||[]).every(i=>Number.isFinite(i.points)))return round(task.items.reduce((sum,item)=>sum+item.points,0));try{return R.total(task)}catch{return round((task.items||[]).reduce((sum,item)=>sum+(Number(item.points)||0),0))}};
const duration=(from,to)=>Number.isFinite(from)&&Number.isFinite(to)&&to>=from?round((to-from)/3600000):null;
const dateCell=value=>Number.isFinite(value)?{v:(value+TZ-Date.UTC(1899,11,30))/DAY,s:2}:'';
const dateOnlyCell=value=>Number.isFinite(value)?{v:(value+TZ-Date.UTC(1899,11,30))/DAY,s:5}:'';
const numberCell=value=>Number.isFinite(value)?{v:round(value),s:3}:'';
const percentCell=value=>Number.isFinite(value)?{v:value,s:4}:'';
const textCell=value=>({text:String(value??''),s:6});

function createReport(tasks,events,{frequency,anchor,generatedAt=Date.now(),unavailable=[]}={}){
 const range=periodRange(frequency,anchor),eventRows=events.filter(event=>inRange(event.at,range)),eventTaskIds=new Set(eventRows.map(event=>event.taskId).filter(Boolean));
 const milestones=task=>[task.requestedAt,task.createdAt,task.assignedAt,task.startedAt,task.reviewAt,task.completedAt,task.sealedAt];
 const selected=tasks.filter(task=>eventTaskIds.has(task.id)||milestones(task).some(value=>inRange(value,range))||(Number.isFinite(task.createdAt)&&task.createdAt<range.end&&(!Number.isFinite(task.completedAt)||task.completedAt>=range.start)));
 const taskById=new Map(tasks.map(task=>[task.id,task])),cutoff=Math.min(generatedAt,range.end-1);
 const completeTiming=task=>!task.importedTiming&&!task.externalTiming;
 const confirmedInRange=task=>!task.completionFromFolder&&inRange(task.completedAt,range);
 const timingQuality=task=>completeTiming(task)?'软件记录（任务历时，可重叠）':'记录不完整，不用于人员工时与效率';
 const confirmationSource=task=>task.completionTimeSource==='file-estimate'?'文件时间推定':task.completionFromFolder?'历史推定，未核实':task.completedAt?'已记录确认':'尚未确认';
 const taskRows=selected.map(task=>[
  task.id,STATE_NAMES[task.state]||'未知',task.sealed?'是':'否',dateCell(task.requestedAt),dateCell(task.createdAt),dateCell(task.assignedAt),dateCell(task.startedAt),dateCell(task.reviewAt),dateCell(task.completedAt),dateCell(task.sealedAt),
  task.brand||'',task.product||'',textCell(task.code),task.title||task.product||'',task.operator||'',personName(task.owner),(task.items||[]).length,numberCell(total(task)),numberCell(completeTiming(task)?hours(R.elapsed(task,cutoff)):null),numberCell(completeTiming(task)&&R.elapsed(task,cutoff)>0?total(task)/(R.elapsed(task,cutoff)/3600000):null),
  numberCell(duration(task.requestedAt,task.completedAt)),numberCell(duration(task.assignedAt,task.startedAt)),numberCell(duration(task.startedAt,task.completedAt)),confirmedInRange(task)?'是':'否',inRange(task.sealedAt,range)?'是':'否',task.filename||'',timingQuality(task),confirmationSource(task),dateCell(task.reportSnapshotAt),dateCell(task.reportCalibrationAt)
 ]);
 const itemRows=[];
 for(const task of selected)for(const item of task.items||[]){const rate=R.RATES.find(candidate=>candidate.id===item.type);itemRows.push([task.id,task.title||task.product||'',personName(task.owner),STATE_NAMES[task.state]||'未知',task.brand||'',task.product||'',textCell(task.code),item.typeName||rate?.name||item.type||'',categoryName(item.category),item.qty||0,rate?.unit||'项',numberCell(Number.isFinite(item.points)&&item.qty?item.points/item.qty:rate?.points),numberCell(item.points??(rate?R.itemPoints(item):0)),item.note||'',confirmedInRange(task)?'是':'否']);}
 const peopleRows=R.PEOPLE.filter(person=>person.title==='设计师').map(person=>{
  const mine=selected.filter(task=>task.owner===person.id),completed=mine.filter(task=>confirmedInRange(task)),sealed=mine.filter(task=>inRange(task.sealedAt,range));
  const completedPoints=round(completed.reduce((sum,task)=>sum+total(task),0)),actualHours=completed.every(completeTiming)?round(completed.reduce((sum,task)=>sum+hours(task.elapsedMs||0),0)):null;
  const activeAtEnd=tasks.filter(task=>task.owner===person.id&&Number.isFinite(task.assignedAt)&&task.assignedAt<range.end&&(!Number.isFinite(task.completedAt)||task.completedAt>=range.end));
  return [person.id,person.name,mine.length,mine.filter(task=>inRange(task.assignedAt,range)).length,mine.filter(task=>inRange(task.startedAt,range)).length,completed.length,sealed.length,numberCell(completedPoints),numberCell(actualHours),numberCell(completed.length?completedPoints/completed.length:null),numberCell(actualHours?completedPoints/actualHours:null),numberCell(range.capacity),percentCell(range.capacity?completedPoints/range.capacity:null),activeAtEnd.length,numberCell(activeAtEnd.reduce((sum,task)=>sum+total(task),0))];
 });
 const products=new Map();
 for(const task of selected){const key=[task.brand,task.product,task.code].join('\u0000'),record=products.get(key)||{brand:task.brand||'',product:task.product||'',code:String(task.code||''),tasks:[],types:new Set(),designers:new Set()};record.tasks.push(task);if(task.owner)record.designers.add(personName(task.owner));for(const item of task.items||[])record.types.add(item.typeName||item.type);products.set(key,record)}
 const productRows=[...products.values()].map(record=>{const completed=record.tasks.filter(task=>confirmedInRange(task));return [record.brand,record.product,textCell(record.code),record.tasks.length,completed.length,numberCell(record.tasks.reduce((sum,task)=>sum+total(task),0)),numberCell(completed.reduce((sum,task)=>sum+total(task),0)),[...record.types].join('、'),[...record.designers].join('、')]}).sort((a,b)=>(b[3]||0)-(a[3]||0));
 const flowRows=eventRows.sort((a,b)=>a.at-b.at).map(event=>{const task=taskById.get(event.taskId),body=event.body||{};return [dateCell(event.at),EVENT_NAMES[event.kind]||event.kind,personName(event.actor),task?.title||task?.product||'',task?.brand||'',task?.product||'',textCell(task?.code),Number.isInteger(body.from)?STATE_NAMES[body.from]:'',Number.isInteger(body.to)?STATE_NAMES[body.to]:'',body.reason||'',event.taskId||'']});
 const days=[];
 for(let at=range.start;at<range.end;at+=DAY){const completed=selected.filter(task=>!task.completionFromFolder&&ymd(task.completedAt)===ymd(at));days.push([dateOnlyCell(at),selected.filter(task=>ymd(task.requestedAt)===ymd(at)).length,selected.filter(task=>ymd(task.assignedAt)===ymd(at)).length,selected.filter(task=>ymd(task.startedAt)===ymd(at)).length,selected.filter(task=>ymd(task.reviewAt)===ymd(at)).length,completed.length,selected.filter(task=>ymd(task.sealedAt)===ymd(at)).length,numberCell(completed.reduce((sum,task)=>sum+total(task),0))]);}
 const infoRows=[
  ['类别','字段 / 工作表','说明'],['报告信息','统计周期',range.label],['报告信息','周期类型',frequency==='week'?'周报（周一至周日）':'月报（自然月）'],['报告信息','生成时间',dateCell(generatedAt)],['报告信息','周期标准容量',range.capacity+' 点 / 人'],
  ['口径','任务范围','包含周期内发生流转的任务，以及在该周期内仍处于进行状态的任务'],['口径','完成贡献力','只统计运营确认完成时间落在本周期内的任务贡献力'],['口径','记录的任务计时','使用软件已记录的设计计时；历史导入任务可能没有完整计时'],['口径','完成点数/参考容量','周期内完成贡献力 ÷ 周期标准容量；周容量 32 点，月容量 139.2 点'],
  ['工作表','任务明细','一行一个任务，含状态、里程碑时间、贡献力和各阶段耗时'],['工作表','事项明细','一行一个事项，适合分析任务类型、数量和贡献力结构'],['工作表','人员汇总','按截止时设计师归属汇总完成点数、记录计时、容量参考与在手任务；多人协作请结合流转事件'],['工作表','产品维度','按品牌 + 产品名 + 69码汇总需求；同名不同69码分开呈现'],['工作表','状态流转','周期内的原始操作事件，可追溯状态变化'],['工作表','每日趋势','按自然日统计新需求、开始、完成、封存和完成贡献力'],
  ['AI 提示词','人员负荷','先查看数据质量，再比较完成点数和在手点数；计时可能重叠，不据此判定人员真实工时、忙闲或绩效'],['AI 提示词','流程瓶颈','使用任务明细的各阶段耗时与状态流转，找出等待时间最长的阶段、任务类型和人员'],['AI 提示词','需求结构','使用事项明细与产品维度，分析高频产品、事项类型、重复需求以及贡献力构成']
 ];
 infoRows.push(['口径','历史状态','按周期结束或导出时刻（取较早者）保存的版本还原；负责人对同一完结记录校准的事项与点数应用最新校准，并单列校准时间；升级前无法还原的任务单列在数据质量，不混入汇总'],['口径','统计截止',dateCell(cutoff)],['口径','确认时间推定','设计完成或文件修改时间推定的完结记录不计入正式周期完成点数；请先核实'],['口径','计时边界','计时为任务运行历时，可能重叠或跨休息时间，不代表人员实际投入；历史导入/外部编辑计时不完整时留空'],['口径','容量参考','139.2 点/月、32 点/周为排期参考，完成点数/容量是产出比，不是忙闲或绩效结论']);
 const qualityRows=[['任务ID','需求表文件名','问题','处理'],...unavailable.map(t=>[t.id,t.filename,t.reason,'未混入历史汇总，请核对原始记录']),...selected.filter(t=>!completeTiming(t)||t.completionFromFolder).map(t=>[t.id,t.filename,[!completeTiming(t)?'计时不完整':'',t.completionFromFolder?'确认时间为推定':''].filter(Boolean).join('；'),'计时缺失留空；推定确认不计入周期完成点数'])];
 const sheets=[
  {name:'AI使用说明',rows:infoRows,filter:false},
  {name:'任务明细',rows:[['任务ID','截止时状态','是否封存','需求时间','导入时间','分配时间','开始设计','提交确认','运营确认','封存时间','品牌','产品名','产品69码','任务名','运营','设计师','事项数','标准贡献力（点）','累计记录计时（小时）','点数/记录计时（非人员效率）','需求至确认（小时）','分配至开始（小时）','开始至确认（小时）','本周期完成','本周期封存','需求表文件名','计时完整性','确认时间来源','版本记录时间','点数校准时间'],...taskRows]},
  {name:'事项明细',rows:[['任务ID','任务名','设计师','截止时状态','品牌','产品名','产品69码','事项类型','资产类别','数量','单位','单个贡献力（点）','事项贡献力（点）','事项说明','本周期完成'],...itemRows]},
  {name:'人员汇总',rows:[['人员ID','设计师','周期涉及任务','周期分配任务','周期开工任务','周期完成任务','周期封存任务','完成贡献力（点）','已完成任务累计记录计时（小时）','平均每项贡献力（点）','点数/记录计时（非人员效率）','周期标准容量（点）','完成点数/参考容量','期末在手任务','期末在手贡献力（点）'],...peopleRows]},
  {name:'产品维度',rows:[['品牌','产品名','产品69码','周期涉及任务','周期完成任务','涉及贡献力（点）','完成贡献力（点）','事项类型','设计师'],...productRows]},
  {name:'状态流转',rows:[['发生时间','事件','操作人','任务名','品牌','产品名','产品69码','原状态','新状态','原因','任务ID'],...flowRows]},
  {name:'数据质量',rows:qualityRows},
  {name:'每日趋势',rows:[['日期','新需求','完成分配','开始设计','提交确认','运营确认完成','完成封存','完成贡献力（点）'],...days]}
 ];
 return {bytes:workbook(sheets,generatedAt),range,counts:{tasks:selected.length,items:itemRows.length,events:eventRows.length}};
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
 const body=rows.map((row,index)=>'<row r="'+(index+1)+'"'+(index===0?' ht="30" customHeight="1"':'')+'>'+row.map((value,column)=>{const cell=cellXml(value,index+1,column);return index===0?cell.replace('<c ','<c s="1" '):cell}).join('')+'</row>').join('');
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
 files['xl/styles.xml']=strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="4"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="165" formatCode="0.00"/><numFmt numFmtId="166" formatCode="0.0%"/><numFmt numFmtId="167" formatCode="yyyy-mm-dd"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/><family val="2"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Microsoft YaHei"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF2563D9"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><left style="thin"><color rgb="FFD9E2F2"/></left><right style="thin"><color rgb="FFD9E2F2"/></right><top style="thin"><color rgb="FFD9E2F2"/></top><bottom style="thin"><color rgb="FFD9E2F2"/></bottom></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
 sheets.forEach((sheet,index)=>files['xl/worksheets/sheet'+(index+1)+'.xml']=strToU8(sheetXml(sheet)));
 return Buffer.from(zipSync(files,{level:6}));
}

module.exports={createReport,periodRange,ymd};
