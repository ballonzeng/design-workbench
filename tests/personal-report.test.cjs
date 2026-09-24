'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {unzipSync,strFromU8}=require('fflate');
const {XMLValidator,XMLParser}=require('fast-xml-parser');
const {personalRange,createPersonalReport}=require('../core/personal-report.cjs');
const at=value=>Date.parse(value+'+08:00');
const options={personId:'lv',personName:'吕慧芸',frequency:'week',anchor:'2026-09-24',generatedAt:at('2026-09-28T12:00:00')};
const task=(id='mine',change={})=>({id,owner:'lv',state:4,title:'需求表任务',filename:'测试需求.xlsx',brand:'品牌',product:'产品',code:'0000691234567890',reviewAt:at('2026-09-23T12:00:00'),completedAt:at('2026-09-24T16:00:00'),completionTimeSource:'app-confirmed',items:[{id:'row-6',row:6,type:'sku-full',typeName:'完整SKU精做',qty:3,points:1.5}],...change});
const sheet=(report,name)=>report.sheets.find(sheet=>sheet.name===name).rows;
const value=cell=>cell&&typeof cell==='object'?(cell.v??cell.text):cell;
const records=(report,name)=>{const [head,...rows]=sheet(report,name);return rows.map(row=>Object.fromEntries(head.map((key,index)=>[key,value(row[index])])))};

test('personal periods use Shanghai boundaries, Monday weeks, and inclusive custom end dates',()=>{
 const week=personalRange({frequency:'week',anchor:'2026-09-27'});
 assert.equal(week.start,at('2026-09-21T00:00:00'));assert.equal(week.end,at('2026-09-28T00:00:00'));
 assert.equal(week.startDate,'2026-09-21');assert.equal(week.endDate,'2026-09-27');
 const month=personalRange({frequency:'month',anchor:'2024-02-29'});
 assert.equal(month.start,at('2024-02-01T00:00:00'));assert.equal(month.end,at('2024-03-01T00:00:00'));
 const day=personalRange({frequency:'custom',startDate:'2026-09-24',endDate:'2026-09-24'});
 assert.equal(day.end-day.start,86400000);
 const leap=personalRange({frequency:'custom',startDate:'2024-01-01',endDate:'2024-12-31'});
 assert.equal((leap.end-leap.start)/86400000,366);
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
 assert.deepEqual({...report.counts,warnings:undefined},{tasks:2,items:2,points:3,excluded:5,warnings:undefined});
 assert.deepEqual(records(report,'任务明细').map(row=>row['任务ID']),['at-start','at-end-minus-one']);
 assert.doesNotMatch(JSON.stringify(report.sheets),/PRIVATE-OTHER-TASK|PRIVATE-UNASSIGNED/);
 const early=createPersonalReport([task('later-today'),task('already-done',{completedAt:at('2026-09-24T10:00:00')})],{...options,generatedAt:at('2026-09-24T12:00:00')});
 assert.deepEqual(records(early,'任务明细').map(row=>row['任务ID']),['already-done']);
});

test('quantity aggregation preserves screens, saved points, and generic original types instead of guessing asset categories',()=>{
 const completed=task('quantities',{reportSnapshotAt:at('2026-09-24T17:00:00'),reportCalibrationAt:at('2026-10-02T14:00:00'),items:[
  {row:6,type:'sku-full',qty:3,points:9.5},
  {row:7,type:'sku-set',qty:2,points:.5},
  {row:8,type:'main-full',qty:2,points:1.6},
  {row:9,type:'detail-full',qty:4,points:6},
  {row:10,type:'detail-adjust',qty:5,points:1.25},
  {row:11,type:'basic',category:'main',qty:7,points:5.6},
  {row:12,type:'video-basic',qty:2,points:2.2}
 ]});
 const report=createPersonalReport([completed],options),row=records(report,'任务明细')[0];
 assert.equal(report.counts.points,26.65);assert.equal(row['任务点数'],26.65);
 assert.equal(row['SKU（张）'],5);assert.equal(row['主图（张）'],2);assert.equal(row['详情页（屏）'],4);assert.equal(row['详情页（张）'],5);
 assert.equal(row['单图任务（基础元素替换）（张）'],7);assert.equal(row['创意视频（条）'],2);
 assert.match(row['内容数量明细'],/详情页 4 屏/);assert.match(row['内容数量明细'],/单图任务（基础元素替换） 7 张/);
 assert.ok(row['点数校准时间']>row['完成时间（运营确认）']);assert.ok(row['提交确认时间']<row['完成时间（运营确认）']);
 const itemRows=records(report,'事项明细');assert.equal(itemRows[0]['事项点数'],9.5);assert.equal(itemRows[3]['单位'],'屏');assert.equal(itemRows[5]['分类依据'],'原事项类型（类别未明确）');
 const summary=records(report,'个人汇总')[0];assert.equal(summary['完成点数'],26.65);assert.equal(summary['SKU（张）'],5);
});

test('missing points are disclosed and known historical points survive unknown or invalid source fields',()=>{
 const report=createPersonalReport([task('quality',{items:[
  {row:6,type:'sku-full',qty:2},
  {row:7,type:'legacy-special',typeName:'旧版独立事项',qty:4,unit:'组',points:8},
  {row:8,type:'unknown',typeName:'未匹配事项',qty:3},
  {row:9,type:'detail-full',qty:-1,points:2}
 ]})],options);
 assert.equal(report.counts.points,11);
 const rows=records(report,'事项明细');assert.equal(rows[0]['事项点数'],1);assert.equal(rows[0]['点数来源'],'按当前标准补算');
 assert.equal(rows[1]['单位'],'组');assert.equal(rows[1]['事项点数'],8);assert.equal(rows[2]['事项点数'],'');assert.equal(rows[2]['单位'],'未记录单位');
 assert.equal(rows[3]['数量'],'');assert.equal(rows[3]['事项点数'],2);
 assert.equal(records(report,'任务明细')[0]['点数口径'],'仅已知点数');assert.match(records(report,'个人汇总')[0]['点数完整性'],/存在缺失/);
 assert.match(JSON.stringify(sheet(report,'数据问题')),/按当前标准补算|没有可确认的数量单位|数量无效/);
});

test('workload follows the cutoff owner and current completion round, independent of archive date',()=>{
 const report=createPersonalReport([
  task('unsealed',{sealed:false,archiveRound:2,items:[{type:'main-full',qty:2,points:1.6}],workIntervals:[{owner:'hong',start:at('2026-09-22T10:00:00'),end:at('2026-09-22T11:00:00')}]}),
  task('later-archive',{sealed:true,sealedAt:at('2026-10-01T10:00:00')}),
  task('earlier-completion',{completedAt:at('2026-09-20T15:00:00'),sealedAt:at('2026-09-24T18:00:00')}),
  task('current-rework',{state:2,completedAt:null,archiveRound:3}),
  task('other-finisher',{owner:'hong',workIntervals:[{owner:'lv',start:at('2026-09-22T10:00:00'),end:at('2026-09-22T11:00:00')}]})
 ],options);
 assert.equal(report.counts.tasks,2);assert.equal(report.counts.points,3.1);
 assert.deepEqual(records(report,'任务明细').map(row=>row['任务ID']).sort(),['later-archive','unsealed']);
 const info=JSON.stringify(sheet(report,'统计说明'));assert.match(info,/重复提交不重复计数/);assert.match(info,/不自动按参与人数或接力时长拆分/);assert.match(info,/封存时间不影响完成归期/);
});

test('anonymous historical gaps reveal no task metadata and do not become a personal excluded count',()=>{
 const report=createPersonalReport([],{...options,unavailable:[{id:'secret-id',filename:'同事秘密需求.xlsx',reason:'private-owner'}]});
 assert.equal(report.counts.excluded,0);assert.equal(report.counts.warnings,1);
 assert.doesNotMatch(JSON.stringify(report.sheets),/secret-id|同事秘密需求|private-owner/);
 assert.match(JSON.stringify(sheet(report,'数据问题')),/无法还原当时归属/);
});

test('empty periods remain downloadable with zero totals and all worksheet headers',()=>{
 const report=createPersonalReport([],options);assert.deepEqual(report.counts,{tasks:0,items:0,points:0,excluded:0,warnings:0});
 assert.equal(sheet(report,'任务明细').length,1);assert.equal(sheet(report,'事项明细').length,1);assert.equal(sheet(report,'数据问题').length,1);
 const row=records(report,'个人汇总')[0];assert.equal(row['完成任务数'],0);assert.equal(row['完成点数'],0);assert.equal(row['详情页（屏）'],0);
 assert.ok(report.bytes.length>1000);
});

test('xlsx uses native numbers and dates, literal formula-like text, leading-zero codes, filters and frozen headers',()=>{
 const report=createPersonalReport([task('xml',{title:'=HYPERLINK("x") & <测试>',items:[{row:6,type:'sku-full',qty:3,points:1.5,note:'=2+2',linkId:'0000123'}]})],options);
 const zip=unzipSync(report.bytes),parser=new XMLParser({ignoreAttributes:false});
 for(const [path,bytes] of Object.entries(zip))if(path.endsWith('.xml')||path.endsWith('.rels'))assert.equal(XMLValidator.validate(strFromU8(bytes)),true,path);
 const tasksXml=strFromU8(zip['xl/worksheets/sheet2.xml']),itemsXml=strFromU8(zip['xl/worksheets/sheet3.xml']);
 assert.doesNotMatch(tasksXml+itemsXml,/<f[ >]/);assert.match(tasksXml,/=HYPERLINK\(&quot;x&quot;\) &amp; &lt;测试&gt;/);
 assert.match(tasksXml,/0000691234567890/);assert.match(itemsXml,/0000123/);assert.match(itemsXml,/=2\+2/);
 assert.match(tasksXml,/state="frozen"/);assert.match(tasksXml,/<autoFilter ref="A1:/);
 const document=parser.parse(tasksXml),cells=document.worksheet.sheetData.row[1].c;
 const headers=sheet(report,'任务明细')[0],cellFor=header=>cells[headers.indexOf(header)];
 assert.equal(cellFor('任务点数').v,1.5);assert.equal(cellFor('任务点数')['@_s'],'3');
 assert.equal(cellFor('完成时间（运营确认）')['@_s'],'2');assert.ok(Number.isFinite(cellFor('完成时间（运营确认）').v));
 assert.equal(cellFor('产品69码')['@_t'],'inlineStr');assert.equal(cellFor('产品69码')['@_s'],'6');
});
