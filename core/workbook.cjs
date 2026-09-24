'use strict';
// Targeted OOXML adapter: retain every original entry, image, style and protection.
// Only the template's explicitly unlocked workflow cells may be updated.
const {unzipSync,zipSync,strFromU8,strToU8}=require('fflate');
const {XMLParser}=require('fast-xml-parser');
const crypto=require('node:crypto');const path=require('node:path');
const {fail,PEOPLE,rateFor,itemPoints,safeName,validCode,inferredCategory,stamp,normalize}=require('./rules.cjs');
const parser=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',parseTagValue:false,processEntities:true});
const list=v=>v==null?[]:Array.isArray(v)?v:[v];
function decodeEntities(value){return String(value??'').replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)))}
function textValue(v){if(v==null)return '';if(typeof v!=='object')return decodeEntities(v);if(v.t!==undefined)return textValue(v.t);if(v['#text']!==undefined)return decodeEntities(v['#text']);if(v.r!==undefined)return list(v.r).map(textValue).join('');return ''}
function cellText(value){return decodeEntities(value).replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim()}
function compactText(value){return decodeEntities(value).replace(/\s+/g,'')}
const WORKFLOW_FIELDS=['E4','F4','G4','H4','I4','J4','K4','M4','N4'];
const TASK_ID_NAME='_DW_TASK_ID',UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function workbookTaskId(bytes){
 const wb=Buffer.isBuffer(bytes)||bytes instanceof Uint8Array?unpack(bytes):bytes;
 const book=parser.parse(strFromU8(wb.entries['xl/workbook.xml'])).workbook;
 const names=list(book.definedNames?.definedName).filter(n=>n['@_name']===TASK_ID_NAME);
 if(!names.length)return null;
 const id=textValue(names[0]).replace(/^"|"$/g,'');
 if(names.length!==1||!UUID.test(id))fail('需求表内部任务编号损坏，请负责人核对原表');return id.toLowerCase();
}
function identifyWorkbook(bytes,id){
 if(!UUID.test(id))fail('任务编号无效');const wb=unpack(bytes),existing=workbookTaskId(wb);
 if(existing===id)return bytes;if(existing)fail('需求表内部编号属于另一任务，未覆盖');
 let xml=strFromU8(wb.entries['xl/workbook.xml']);const entry='<definedName name="'+TASK_ID_NAME+'" hidden="1">&quot;'+id+'&quot;</definedName>';
 if(/<definedNames\b[^>]*\/>/.test(xml))xml=xml.replace(/<definedNames\b[^>]*\/>/,'<definedNames>'+entry+'</definedNames>');
 else if(xml.includes('</definedNames>'))xml=xml.replace('</definedNames>',entry+'</definedNames>');
 else xml=xml.replace(/(?=<(?:calcPr|oleSize|customWorkbookViews|pivotCaches|smartTagPr|smartTagTypes|webPublishing|fileRecoveryPr|webPublishObjects|extLst)\b|<\/workbook>)/,'<definedNames>'+entry+'</definedNames>');
 wb.entries['xl/workbook.xml']=strToU8(xml);return Buffer.from(zipSync(wb.entries,{level:6}));
}
function workflowFields(bytes){const wb=Buffer.isBuffer(bytes)||bytes instanceof Uint8Array?unpack(bytes):bytes;return Object.fromEntries(WORKFLOW_FIELDS.map(a=>[a,cellText(mergedValue(wb.status,a))]))}
function unpack(bytes){
 if(bytes.length>50*1024*1024)fail('需求表不能超过 50 MB');
 let expanded=0,count=0;
 const entries=unzipSync(bytes,{filter:e=>{expanded+=e.originalSize;count++;if(expanded>300*1024*1024||count>6000||e.name.includes('../'))fail('需求表压缩结构异常');return true}});
 const xml=name=>{if(!entries[name])fail('需求表格式不完整');const s=strFromU8(entries[name]);if(/<!DOCTYPE|<!ENTITY/i.test(s))fail('需求表包含不支持的 XML 声明');return s};
 const book=parser.parse(xml('xl/workbook.xml')).workbook;
 if(book.workbookPr?.['@_date1904']==='1')fail('不支持 1904 日期系统，请使用公司需求模板');
 const relationships=list(parser.parse(xml('xl/_rels/workbook.xml.rels')).Relationships.Relationship);
 const strings=entries['xl/sharedStrings.xml']?list(parser.parse(xml('xl/sharedStrings.xml')).sst.si).map(textValue):[];
 const sheets=list(book.sheets.sheet).map(s=>{
  const rel=relationships.find(r=>r['@_Id']===s['@_r:id']);if(!rel||rel['@_TargetMode']==='External')fail('工作表关系异常');
  const target=rel['@_Target'];const file=target.startsWith('/')?target.slice(1):path.posix.normalize('xl/'+target);
  if(!file.startsWith('xl/worksheets/'))fail('工作表路径异常');
  const content=xml(file),tree=parser.parse(content).worksheet,cells={};
  for(const row of list(tree.sheetData?.row))for(const c of list(row.c)){
   const type=c['@_t'];const value=type==='s'?strings[Number(c.v)]:type==='inlineStr'?textValue(c.is):textValue(c.v);
   cells[c['@_r']]={value:value??'',style:Number(c['@_s']||0),formula:c.f!==undefined};
  }
  return {name:s['@_name'],file,content,tree,cells,merges:list(tree.mergeCells?.mergeCell).map(m=>m['@_ref'])};
 });
 const status=sheets.find(s=>normalize(s.name)==='【状态】'||normalize(s.name)==='状态');if(!status)fail('未找到公司模板的【状态】工作表');
 const styles=list(parser.parse(xml('xl/styles.xml')).styleSheet.cellXfs.xf);
 return {entries,sheets,status,styles};
}
function dateTime(value,hour){
 let millis;
 if(/^\d+(?:\.\d+)?$/.test(value)){const days=Number(value);if(days<40000||days>90000)fail('需求日期无效');millis=Date.UTC(1899,11,30)+Math.floor(days)*86400000}
 else {const m=String(value).match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);if(!m)fail('需求日期无效');millis=Date.UTC(+m[1],+m[2]-1,+m[3]);const d=new Date(millis);if(d.getUTCMonth()!==+m[2]-1||d.getUTCDate()!==+m[3])fail('需求日期无效')}
 const h=Number(hour);if(!/^\d{1,2}$/.test(String(hour))||h<0||h>23)fail('需求时段无效');
 return millis+(h-8)*3600000;
}
function mergedValue(sheet,addr){
 if(sheet.cells[addr]?.value!==undefined&&sheet.cells[addr].value!=='')return sheet.cells[addr].value;
 const m=addr.match(/^([A-Z]+)(\d+)$/);
 for(const range of sheet.merges){const [a,b]=range.split(':');if(!b)continue;const ma=a.match(/^([A-Z]+)(\d+)$/),mb=b.match(/^([A-Z]+)(\d+)$/);if(ma[1]===m[1]&&mb[1]===m[1]&&+m[2]>=+ma[2]&&+m[2]<=+mb[2])return sheet.cells[a]?.value||''}
 return '';
}
function filenameFailure(reasons){const e=new Error('上传需求失败，文件命名不符合规则。');e.code='INVALID_FILENAME';e.reasons=reasons;throw e}
function parseRequirementFilename(filename,{requestedAt,operator,workbookDesigner}){
 const reasons=[];
 if(!/\.xlsx$/i.test(filename))filenameFailure(['文件扩展名必须是 .xlsx']);
 const base=filename.slice(0,-5),parts=base.split('-');
 if(parts.length!==5){
  reasons.push('文件名应为“年月日时-品牌-任务名-运营-分配情况”共 5 段');
  if(/^20\d{6}(?:-|$)/.test(base))reasons.push('开头用了 8 位年月日 YYYYMMDD，规则需要 8 位年月日时 YYMMDDHH');
  filenameFailure(reasons);
 }
 const [time,brand,title,fileOperator,assignment]=parts.map(value=>value.normalize('NFKC').trim());
 for(const [label,value] of [['品牌',brand],['任务名',title],['运营',fileOperator],['分配情况',assignment]]){
  if(!value)reasons.push(label+'不能为空');
  if(/[<>:"/\\|?*\x00-\x1f]/.test(value))reasons.push(label+'包含文件名不允许的符号');
 }
 const tm=time.match(/^(\d{2})(\d{2})(\d{2})(\d{2})$/);
 if(/^20\d{6}$/.test(time))reasons.push('年月日时开头使用了 YYYYMMDD，缺少小时；应使用 8 位 YYMMDDHH');
 else if(!tm)reasons.push('年月日时必须是 8 位 YYMMDDHH，例如 26083114');
 else{
  const d=new Date(Date.UTC(2000+Number(tm[1]),Number(tm[2])-1,Number(tm[3]),Number(tm[4])));
  if(Number(tm[2])<1||Number(tm[2])>12||Number(tm[3])<1||Number(tm[3])>31||Number(tm[4])>23||d.getUTCMonth()!==Number(tm[2])-1||d.getUTCDate()!==Number(tm[3]))reasons.push('年月日时不是有效的日期小时：'+time);
  else if(time!==stamp(requestedAt))reasons.push('文件名年月日时应与 Excel 需求日期、需求时间一致：应为 '+stamp(requestedAt));
 }
 const titleLength=[...title].length;if(titleLength>10)reasons.push('任务名最多 10 个字，当前为 '+titleLength+' 个字');
 if(fileOperator!==operator)reasons.push('文件名运营应与 Excel 需求运营一致：应为 '+operator);
 const people=PEOPLE.map(p=>p.name);
 if(assignment==='待分配')reasons.push('未分配任务的最后一段应写“未分配”');
 else if(assignment!=='未分配'&&!people.includes(assignment))reasons.push('分配情况应为“未分配”或设计师完整姓名');
 if(workbookDesigner){if(assignment!==workbookDesigner)reasons.push('文件名设计师与 Excel 分配设计不一致：应为 '+workbookDesigner)}
 else if(assignment!=='未分配')reasons.push('Excel 分配设计为空时，文件名最后一段应为“未分配”');
 if(reasons.length)filenameFailure([...new Set(reasons)]);
 return {time,brand,title,operator:fileOperator,assignment};
}
function barcodeFromCell(value){
 const raw=compactText(value),numbers=raw.match(/\d{10,14}/g)||[],codes=numbers.filter(n=>validCode(n));
 if(numbers.length>1||codes.length>1)fail('Excel 的 69码板块填写了多个产品69码，请将不同产品拆分提交');
 if(codes.length!==1||!validCode(codes[0]))fail('Excel 的 69码板块缺少有效的 13 位产品69码');
 return codes[0];
}
function parseRequirement(bytes,filename,{categories={},extras={}}={}){
 const wb=unpack(bytes),s=wb.status,v=a=>mergedValue(s,a);
 if(normalize(v('B3'))!=='需求日期'||normalize(v('G3'))!=='分配设计'||normalize(v('L3'))!=='文件位置')fail('模板字段与当前适配版本不一致');
 const requestedAt=dateTime(compactText(v('B4')),compactText(v('C4'))),operator=safeName(cellText(v('D4')),'运营姓名'),workbookDesigner=cellText(v('G4'));
 if(workbookDesigner&&!PEOPLE.some(p=>p.name===workbookDesigner))fail('需求表中的设计师不在人员名单中');
 const filenameParts=parseRequirementFilename(filename,{requestedAt,operator,workbookDesigner});safeName(filename,'文件名');const designer=filenameParts.assignment;
 const codeColumn=Array.from({length:26},(_,i)=>String.fromCharCode(65+i)).find(column=>/^(产品)?69(条)?码$/.test(normalize(v(column+'5'))));
 if(!codeColumn)fail('Excel 中未找到“69码”板块');
 const populated=wb.sheets.filter(x=>!['【状态】','状态','参数选项','Sheet1'].includes(x.name)&&Object.values(x.cells).some(c=>c.value!=='')).map(x=>x.name==='创图'?'创意图':x.name==='视频'?'创意视频':x.name);
 const items=[];
 for(let row=6;row<=200;row++){
  const type=cellText(v('F'+row));if(!type)continue;
  const qty=Number(cellText(v('G'+row)));if(qty===0)continue;
  const rate=rateFor(type),workbookBrand=cellText(v('B'+row)),product=cellText(v('C'+row)),code=barcodeFromCell(v(codeColumn+row));
  if(!workbookBrand)fail('Excel 的品牌板块不能为空');if(!product)fail('Excel 的产品名板块不能为空');
  const category=categories[row]||inferredCategory(type,populated);
  const item={id:'row-'+row,row,type:rate.id,typeName:rate.name,qty,extra:Number(extras[row]||0),brand:filenameParts.brand,workbookBrand,product,code,linkId:cellText(v('E'+row)),note:cellText(v('H'+row)),category,sealed:false};
  item.points=itemPoints(item);items.push(item);
 }
 if(!items.length)fail('需求表未填写有效事项');
 const first=items[0];if(items.some(i=>i.code!==first.code||i.brand!==first.brand||i.product!==first.product))fail('一份需求表需要对应一个产品69码，请将不同产品拆分提交');
 const optionalDate=(a,b)=>{const date=compactText(v(a)),hour=compactText(v(b));if(!date||!hour)return null;try{return dateTime(date,hour)}catch{return null}};
 const ratings=cellText(v('J5'))==='质量打分'&&cellText(v('K5'))==='时效打分'?{quality:items.map(i=>({row:i.row,value:[60,80,100].includes(Number(cellText(v('J'+i.row))))?Number(cellText(v('J'+i.row))):null})),timeliness:['满意','不满'].includes(cellText(v('K6')))?cellText(v('K6')):null}:null;
 return {id:crypto.randomUUID(),workbookTaskId:workbookTaskId(wb),filename,title:filenameParts.title,brand:first.brand,workbookBrand:first.workbookBrand,product:first.product,code:first.code,operator,requestedAt,requestedDesigner:designer,items,ratings,templateTimes:{assignedAt:optionalDate('E4','F4'),startedAt:optionalDate('H4','I4'),reviewAt:optionalDate('J4','K4'),completedAt:optionalDate('M4','N4')},sourceHash:crypto.createHash('sha256').update(bytes).digest('hex')};
}
const ALLOWED=new Set(['E4','F4','G4','H4','I4','J4','K4','L4','M4','N4']);
const escapeXml=v=>String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
function patchWorkbook(bytes,patch,{resetRatingsFor=null}={}){
 const wb=unpack(bytes),s=wb.status;let xml=s.content;const allowed=new Set(ALLOWED);patch={...patch};
 if(resetRatingsFor){
  const quality=cellText(s.cells.J5?.value)==='质量打分',timeliness=cellText(s.cells.K5?.value)==='时效打分';
  if(quality!==timeliness)fail('评分栏与标准模板不一致，未回退原表');
  if(quality&&timeliness){for(const addr of ['K6',...resetRatingsFor.map(i=>'J'+i.row)]){if(!/^[JK][1-9][0-9]*$/.test(addr))fail('评分行无效');if(s.cells[addr]&&s.cells[addr].value!==''){allowed.add(addr);patch[addr]=''}}}
 }

 for(const [addr,value] of Object.entries(patch)){
  if(!allowed.has(addr))fail('禁止写入此模板字段：'+addr,403);
  const cell=s.cells[addr];if(!cell||cell.formula)fail('模板字段缺失或包含公式：'+addr);
  if(s.tree.sheetProtection&&wb.styles[cell.style]?.protection?.['@_locked']!=='0')fail('模板字段受保护，无法自动回填：'+addr);
  const re=new RegExp('<c\\b(?=[^>]*\\br="'+addr+'")[^>]*?(?:\\/>|>[\\s\\S]*?<\\/c>)');
  const match=xml.match(re);if(!match)fail('找不到模板字段：'+addr);
  let opening=match[0].match(/^<c\b[^>]*>/)[0].replace(/\/>$/, '>').replace(/\s+t="[^"]*"/,'');
  let replacement;
  if(typeof value==='number'&&Number.isFinite(value))replacement=opening+'<v>'+value+'</v></c>';
  else replacement=opening.replace(/>$/,' t="inlineStr">')+'<is><t xml:space="preserve">'+escapeXml(value)+'</t></is></c>';
  xml=xml.replace(re,()=>replacement);
 }
 wb.entries[s.file]=strToU8(xml);
 return Buffer.from(zipSync(wb.entries,{level:6}));
}
module.exports={unpack,parseRequirement,parseRequirementFilename,patchWorkbook,dateTime,mergedValue,cellText,compactText,barcodeFromCell,workflowFields,workbookTaskId,identifyWorkbook};
