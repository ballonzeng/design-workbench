'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {unzipSync,strFromU8}=require('fflate');
const {XMLValidator,XMLParser}=require('fast-xml-parser');
const {personalRange,createPersonalReport}=require('../core/personal-report.cjs');
const R=require('../core/rules.cjs');
const at=value=>Date.parse(value+'+08:00');
const HEADERS=['日期','69码','对接运营','设计者','任务名','事项','张数'];
const options={personId:'lv',personName:'吕慧芸',frequency:'week',anchor:'2026-09-24',generatedAt:at('2026-09-28T12:00:00')};
const task=(id='mine',change={})=>({id,owner:'lv',state:4,title:'需求表任务-'+id,filename:'测试需求.xlsx',brand:'品牌',product:'产品',operator:'王燕',code:'0000691234567890',reviewAt:at('2026-09-23T12:00:00'),completedAt:at('2026-09-24T16:00:00'),completionTimeSource:'app-confirmed',items:[{id:'row-6',row:6,type:'sku-full',typeName:'完整SKU精做',qty:3,points:1.5}],...change});
const value=cell=>cell&&typeof cell==='object'?(cell.v??cell.text):cell;
const records=report=>{const [head,...rows]=report.sheets[0].rows;return rows.map(row=>Object.fromEntries(head.map((key,index)=>[key,value(row[index])])))};

test('personal periods use Shanghai boundaries, Monday weeks, and inclusive custom end dates',()=>{
 const week=personalRange({frequency:'week',anchor:'2026-09-27'});
 assert.equal(week.start,at('2026-09-21T00:00:00'));assert.equal(week.end,at('2026-09-28T00:00:00'));
 assert.equal(week.startDate,'2026-09-21');assert.equal(week.endDate,'2026-09-27');
 const month=personalRange({frequency:'month',anchor:'2024-02-29'});
 assert.equal(month.start,at('2024-02-01T00:00:00'));assert.equal(month.end,at('2024-03-01T00:00:00'));
 const day=personalRange({frequency:'custom',startDate:'2026-09-24',endDate:'2026-09-24'});assert.equal(day.end-day.start,86400000);
 const leap=personalRange({frequency:'custom',startDate:'2024-01-01',endDate:'2024-12-31'});assert.equal((leap.end-leap.start)/86400000,366);
 const acrossYear=personalRange({frequency:'week',anchor:'2027-01-01'});assert.equal(acrossYear.startDate,'2026-12-28');assert.equal(acrossYear.endDate,'2027-01-03');
});

test('personal range rejects invalid dates, reversed ranges, and more than 366 inclusive days',()=>{
 for(const request of [
  {},{frequency:'year',anchor:'2026-01-01'},{frequency:'week',anchor:'2026-02-29'},{frequency:'month',anchor:'2026-9-01'},
  {frequency:'custom',startDate:'2026-09-25',endDate:'2026-09-24'},
  {frequency:'custom',startDate:'2024-01-01',endDate:'2025-01-01'},
  {frequency:'custom',startDate:'2026-09-24',endDate:'2026-13-01'}
 ])assert.throws(()=>personalRange(request),error=>error.status===400);
 assert.throws(()=>createPersonalReport([],{}),/人员身份/);
 assert.throws(()=>createPersonalReport([],{...options,generatedAt:NaN}),/导出时间/);
});

test('only own officially completed tasks count and completion range is start-inclusive and end-exclusive',()=>{
 const tasks=[
  task('at-start',{completedAt:at('2026-09-21T00:00:00')}),task('at-end-minus-one',{completedAt:at('2026-09-28T00:00:00')-1}),
  task('at-end',{completedAt:at('2026-09-28T00:00:00')}),task('before',{completedAt:at('2026-09-21T00:00:00')-1}),
  task('other',{owner:'hong',title:'PRIVATE-OTHER-TASK'}),task('unassigned',{owner:null,title:'PRIVATE-UNASSIGNED'}),
  task('file',{completionTimeSource:'file-estimate'}),task('folder',{completionFromFolder:true}),task('review-estimate',{completionTimeSource:'review-estimate'}),
  task('reopened',{state:3}),task('active',{state:2,completedAt:null}),task('missing-completion',{completedAt:null})
 ];
 const report=createPersonalReport(tasks,options);
 assert.deepEqual(report.counts,{tasks:2,items:2});
 assert.deepEqual(records(report).map(row=>row['任务名']),['需求表任务-at-start','需求表任务-at-end-minus-one']);
 assert.doesNotMatch(JSON.stringify(report.sheets),/PRIVATE-OTHER-TASK|PRIVATE-UNASSIGNED/);
 const early=createPersonalReport([task('later-today'),task('already-done',{completedAt:at('2026-09-24T10:00:00')})],{...options,generatedAt:at('2026-09-24T12:00:00')});
 assert.deepEqual(records(early).map(row=>row['任务名']),['需求表任务-already-done']);
});

test('export is one seven-column sheet with one row per item and quantities separate from item names and notes',t=>{
 t.mock.method(R,'itemPoints',()=>{throw Error('personal export must not calculate points')});
 const report=createPersonalReport([task('details',{items:[
  {type:'sku-full',qty:3},
  {type:'detail-full',qty:4,note:'新增卖点'},
  {type:'detail-adjust',qty:5},
  {type:'basic',category:'main',qty:7},
  {type:'video-basic',qty:2},
  {type:'legacy-special',typeName:'旧版独立事项',qty:4,unit:'组'},
  {type:'sku-full',typeName:'原始SKU事项',qty:2,unit:'套'}
 ]})],options);
 assert.equal(report.sheets.length,1);assert.equal(report.sheets[0].name,'任务明细');
 assert.deepEqual(report.sheets[0].rows[0],HEADERS);assert.ok(report.sheets[0].rows.every(row=>row.length===7));
 assert.equal(report.sheets[0].rows.length,8);
 assert.deepEqual(report.counts,{tasks:1,items:7});
 const rows=records(report);
 for(const row of rows){
  assert.equal(row['日期'],rows[0]['日期']);assert.equal(row['69码'],'0000691234567890');
  assert.equal(row['对接运营'],'王燕');assert.equal(row['设计者'],'吕慧芸');assert.equal(row['任务名'],'需求表任务-details');
 }
 assert.deepEqual(rows.map(row=>row['事项']),['完整SKU精做','完整详情页精做（新增卖点）','详情页套图调整','单图任务（基础元素替换）','基础替换创意视频','旧版独立事项','原始SKU事项']);
 assert.deepEqual(rows.map(row=>row['张数']),[3,'4屏',5,7,'2条','4组','2套']);
 assert.doesNotMatch(JSON.stringify(report.sheets),/点数|版本记录|校准|统计说明|数据问题|个人汇总/);
});

test('missing and invalid quantities stay blank while zero and unitless quantities stay numeric',()=>{
 const report=createPersonalReport([task('quantities',{items:[
  {type:'sku-full',qty:0},{type:'legacy-special',typeName:'未指定单位',qty:2.5},
  {type:'sku-full',qty:'4'},{type:'sku-full',qty:null},{type:'detail-full'},
  {type:'sku-full',qty:-1},{type:'sku-full',qty:NaN},{type:'sku-full',qty:Infinity},
  {type:'sku-full',qty:''},{type:'sku-full',qty:'invalid'}
 ]})],options);
 assert.deepEqual(records(report).map(row=>row['张数']),[0,2.5,4,'','','','','','','']);
 assert.deepEqual(report.counts,{tasks:1,items:10});
});

test('task sorting preserves the original item order and repeats task details on each item row',()=>{
 const report=createPersonalReport([
  task('later',{completedAt:at('2026-09-24T17:00:00'),items:[{type:'sku-full',qty:2},{type:'detail-adjust',qty:4}]}),
  task('same-b',{items:[{type:'basic',qty:1}]}),
  task('same-a',{items:[{type:'detail-adjust',qty:3},{type:'sku-full',qty:5}]})
 ],options);
 const rows=records(report);
 assert.deepEqual(rows.map(row=>row['任务名']),['需求表任务-same-a','需求表任务-same-a','需求表任务-same-b','需求表任务-later','需求表任务-later']);
 assert.deepEqual(rows.map(row=>row['张数']),[3,5,1,2,4]);
 assert.deepEqual(report.counts,{tasks:3,items:5});
});

test('completion follows the cutoff owner and current completion round, independent of archive date',()=>{
 const report=createPersonalReport([
  task('unsealed',{sealed:false,archiveRound:2,workIntervals:[{owner:'hong',start:at('2026-09-22T10:00:00'),end:at('2026-09-22T11:00:00')}]}),
  task('later-archive',{sealed:true,sealedAt:at('2026-10-01T10:00:00')}),
  task('earlier-completion',{completedAt:at('2026-09-20T15:00:00'),sealedAt:at('2026-09-24T18:00:00')}),
  task('current-rework',{state:2,completedAt:null,archiveRound:3}),
  task('other-finisher',{owner:'hong',workIntervals:[{owner:'lv',start:at('2026-09-22T10:00:00'),end:at('2026-09-22T11:00:00')}]})
 ],options);
 assert.deepEqual(report.counts,{tasks:2,items:2});
 assert.deepEqual(records(report).map(row=>row['任务名']).sort(),['需求表任务-later-archive','需求表任务-unsealed']);
});

test('empty periods contain only headers and unavailable history never adds worksheets or disclosure rows',()=>{
 const report=createPersonalReport([],{...options,unavailable:[{id:'secret-id',filename:'同事秘密需求.xlsx',reason:'private-owner'}]});
 assert.deepEqual(report.counts,{tasks:0,items:0});assert.equal(report.sheets.length,1);assert.deepEqual(report.sheets[0].rows,[HEADERS]);
 assert.doesNotMatch(JSON.stringify(report.sheets),/secret-id|同事秘密需求|private-owner/);assert.ok(report.bytes.length>1000);
 const noItems=createPersonalReport([task('empty-items',{items:[]})],options);
 assert.equal(records(noItems).length,1);assert.equal(records(noItems)[0]['事项'],'');assert.equal(records(noItems)[0]['张数'],'');assert.deepEqual(noItems.counts,{tasks:1,items:0});
});

test('xlsx uses Shanghai native date-only values and safe literal text with leading-zero codes',()=>{
 const report=createPersonalReport([task('xml',{completedAt:at('2026-09-24T00:10:00'),title:'=HYPERLINK("x") & <测试>\u0001🙂',items:[{type:'sku-full',qty:3,note:'=2+2 & <文字>'}]})],options);
 const zip=unzipSync(report.bytes),parser=new XMLParser({ignoreAttributes:false});
 for(const [path,bytes] of Object.entries(zip))if(path.endsWith('.xml')||path.endsWith('.rels'))assert.equal(XMLValidator.validate(strFromU8(bytes)),true,path);
 const xml=strFromU8(zip['xl/worksheets/sheet1.xml']);
 assert.equal(Object.keys(zip).filter(path=>/^xl\/worksheets\/sheet\d+\.xml$/.test(path)).length,1);
 assert.doesNotMatch(xml,/<f[ >]|\u0001/);assert.match(xml,/=HYPERLINK\(&quot;x&quot;\) &amp; &lt;测试&gt;🙂/);
 assert.match(xml,/0000691234567890/);assert.match(xml,/=2\+2 &amp; &lt;文字&gt;/);
 assert.match(xml,/state="frozen"/);assert.match(xml,/<autoFilter ref="A1:G2"/);
 const cells=parser.parse(xml).worksheet.sheetData.row[1].c;
 assert.equal(cells[0]['@_s'],'5');assert.equal(cells[0].v,(Date.UTC(2026,8,24)-Date.UTC(1899,11,30))/86400000);assert.ok(Number.isInteger(cells[0].v));
 assert.match(strFromU8(zip['xl/styles.xml']),/formatCode="yyyy-mm-dd"/);
 assert.equal(cells[1]['@_t'],'inlineStr');assert.equal(cells[1]['@_s'],'6');
 assert.equal(cells[4]['@_t'],'inlineStr');assert.equal(cells[5]['@_t'],'inlineStr');
 assert.equal(cells[6]['@_t'],undefined);assert.equal(cells[6].v,3);
});
