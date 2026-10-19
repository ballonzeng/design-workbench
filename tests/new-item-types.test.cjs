'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {zipSync,unzipSync,strToU8,strFromU8}=require('fflate');
const {XMLParser}=require('fast-xml-parser');
const R=require('../core/rules.cjs');
const {parseRequirement,patchWorkbook,unpack}=require('../core/workbook.cjs');
const {workbook}=require('../operator/test-fixture.cjs');
const {Service}=require('../core/service.cjs');
const {OperatorStore}=require('../operator/store.cjs');
const {createReport}=require('../core/report.cjs');

const filename='26090311-测试品牌-包装与视频-测试运营-未分配.xlsx';
const assignedFilename=filename.replace('未分配','洪华');
const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const manager={role:'manager',personId:'zeng'},designer={role:'designer',personId:'hong'};
const escape=value=>String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
function sheet(cells){
 const rows=new Map();
 for(const [address,value] of Object.entries(cells)){
  const row=Number(address.match(/\d+$/)[0]);if(!rows.has(row))rows.set(row,[]);
  rows.get(row).push(typeof value==='number'?'<c r="'+address+'"><v>'+value+'</v></c>':'<c r="'+address+'" t="inlineStr"><is><t>'+escape(value)+'</t></is></c>');
 }
 return '<worksheet xmlns="'+ns+'"><sheetData>'+[...rows].sort((a,b)=>a[0]-b[0]).map(([row,cells])=>'<row r="'+row+'">'+cells.join('')+'</row>').join('')+'</sheetData></worksheet>';
}
// A tiny synthetic v2.3-style workbook; no user workbook or real demand content is bundled.
function newWorkbook({packagingQty=2,storyboards=8}={}){
 const files=unzipSync(workbook());
 files['xl/worksheets/sheet1.xml']=strToU8(sheet({
  A1:'合成测试需求表',A3:'阶段情况',B3:'需求日期',G3:'分配设计',L3:'文件位置',D5:'69码',J5:'质量打分',K5:'时效打分',
  A4:'',B4:46268,C4:11,D4:'测试运营',E4:'',F4:'',G4:'',H4:'',I4:'',J4:'',K4:'',L4:'',M4:'',N4:'',
  B6:'测试品牌',C6:'测试产品',D6:'6999999999999',F6:'包装设计',G6:packagingQty,H6:'两套设计方案',J6:'',K6:'',
  B7:'测试品牌',C7:'测试产品',D7:'6999999999999',F7:'产品视频',G7:storyboards,H7:'按八个分镜计价',J7:''
 }));
 files['xl/worksheets/sheet3.xml']=strToU8('<worksheet xmlns="'+ns+'"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>包装需求内容必须保留</t></is></c></row><row r="63"><c r="D63"><f>\'【状态】\'!G6</f><v>2</v></c></row></sheetData></worksheet>');
 files['xl/worksheets/sheet4.xml']=strToU8(sheet({A1:'视频分镜内容必须保留',A2:'分镜一：合成测试脚本'}));
 files['xl/workbook.xml']=strToU8(strFromU8(files['xl/workbook.xml']).replace('</sheets>','<sheet name="包装" sheetId="3" r:id="rId4"/><sheet name="视频" sheetId="4" r:id="rId5"/></sheets>'));
 files['xl/_rels/workbook.xml.rels']=strToU8(strFromU8(files['xl/_rels/workbook.xml.rels']).replace('</Relationships>','<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/></Relationships>'));
 files['[Content_Types].xml']=strToU8(strFromU8(files['[Content_Types].xml']).replace('</Types>','<Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'));
 return Buffer.from(zipSync(files));
}
function assertNewSheetsPreserved(before,after){
 const initial=unzipSync(before),final=unzipSync(after);
 for(const part of ['xl/worksheets/sheet3.xml','xl/worksheets/sheet4.xml'])assert.deepEqual(final[part],initial[part]);
 const parsed=unpack(after);assert.ok(parsed.sheets.some(s=>s.name==='包装'));assert.ok(parsed.sheets.some(s=>s.name==='视频'));
 assert.equal(parsed.sheets.find(s=>s.name==='包装').cells.D63.formula,true);
}
function assertItems(items){
 assert.deepEqual(items.map(i=>[i.type,i.qty,i.points]),[['packaging-design',2,8],['video-storyboard',8,20]]);
 assert.equal(R.total({items}),28);
}
async function tempRoot(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'new-item-types-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('v2.3 packaging and product-video rows use quantity cells while retaining the two demand sheets',()=>{
 const bytes=newWorkbook(),task=parseRequirement(bytes,filename);assertItems(task.items);
 assert.deepEqual(task.items.map(i=>[i.typeName,i.category]),[['包装设计','packaging'],['产品视频','video']]);
 assert.equal(R.inferredCategory('basic',['包装']),'packaging');assert.equal(R.inferredCategory('basic',['视频']),'video');
 const changed=patchWorkbook(bytes,{G4:'洪华',E4:46268,F4:12});assertNewSheetsPreserved(bytes,changed);
 assertItems(parseRequirement(changed,assignedFilename).items);
});

test('new quantity units have their own rates and preserve the three existing per-video prices',()=>{
 assert.deepEqual(['packaging-design','video-storyboard'].map(id=>[R.rateFor(id).points,R.rateFor(id).unit]),[[4,'套'],[2.5,'分镜']]);
 assert.deepEqual(['video-image','video-basic','video-zero'].map(id=>[R.rateFor(id).points,R.rateFor(id).unit]),[[.3,'条'],[1.1,'条'],[2,'条']]);
 assert.equal(R.itemPoints({type:'video-storyboard',qty:1}),2.5);
 assert.equal(R.itemPoints({type:'packaging-design',qty:1}),4);
});

test('new items reject fractional, negative and excessive counts instead of awarding invalid points',()=>{
 for(const type of ['packaging-design','video-storyboard'])for(const qty of [0,-1,1.5,10001,NaN])assert.throws(()=>R.itemPoints({type,qty}),/数量/);
 for(const options of [{packagingQty:1.5},{packagingQty:-1},{storyboards:'八'},{storyboards:10001}])assert.throws(()=>parseRequirement(newWorkbook(options),filename),/数量/);
 // A zero row is intentionally unused, as with the existing template items.
 assert.equal(parseRequirement(newWorkbook({packagingQty:0}),filename).items[0].type,'video-storyboard');
});

test('manager import, assignment, design, review and approval retain new-item points and both source sheets',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'new-item-workflow-')),taskRoot=path.join(root,'requests'),assetRoot=path.join(root,'assets');await fs.mkdir(taskRoot);await fs.mkdir(assetRoot);
 const service=await new Service(path.join(root,'db'),{host:'127.0.0.1',port:0}).start();t.after(async()=>{await service.stop();await fs.rm(root,{recursive:true,force:true})});
 await service.call(manager,'configure',{taskRoot,assetRoot});await service.requirementsSync.stop();service.requirementsSync.stopped=false;const bytes=newWorkbook();
 const draft=await service.call(manager,'draft',{bytes,filename});assertItems(draft.items);
 let task=await service.call(manager,'import',{draftId:draft.id});assert.equal(task.state,0);assertItems(task.items);
 for(const [actor,action,extra,state] of [[manager,'assign',{owner:'hong'},1],[designer,'start',{},2],[designer,'review',{},3],[manager,'approve',{chatConfirmed:true},4]]){
  task=await service.call(actor,'action',{taskId:task.id,action,version:task.version,...extra});assert.equal(task.state,state);assertItems(task.items);
 }
 assert.equal(task.filename,assignedFilename);assertNewSheetsPreserved(bytes,await fs.readFile(service.nas.taskPath(task)));
});

test('operator submits, scans and scores packaging and storyboard items without changing their demand tabs',async t=>{
 const root=await tempRoot(t),taskRoot=path.join(root,'requests');await fs.mkdir(taskRoot);for(const stage of R.STAGES)await fs.mkdir(path.join(taskRoot,stage));
 const operator=await new OperatorStore(path.join(root,'profile')).init();await operator.configure({name:'测试运营',root:taskRoot});
 const bytes=newWorkbook(),source=path.join(root,filename);await fs.writeFile(source,bytes);
 let result=await operator.submit(source);assert.equal(result.issues.length,0);assert.equal(result.tasks.length,1);assertItems(result.tasks[0].items);
 const pending=path.join(taskRoot,R.STAGES[0],filename),review=path.join(taskRoot,R.STAGES[3],assignedFilename);
 await fs.writeFile(review,patchWorkbook(await fs.readFile(pending),{G4:'洪华',E4:46268,F4:12,H4:46268,I4:13,J4:46268,K4:14}));await fs.unlink(pending);
 result=await operator.scan();assert.equal(result.tasks[0].state,3);assertItems(result.tasks[0].items);
 result=await operator.approve(result.tasks[0].id,'2026-09-04','12:00',{quality:[{row:6,value:100},{row:7,value:80}],timeliness:'满意'});
 assert.equal(result.tasks[0].state,4);assertItems(result.tasks[0].items);
 const finished=await fs.readFile(path.join(taskRoot,R.STAGES[4],assignedFilename));assertNewSheetsPreserved(bytes,finished);
 assert.deepEqual(parseRequirement(finished,assignedFilename).ratings.quality,[{row:6,value:100},{row:7,value:80}]);
});

test('analysis report exports sets and storyboards as distinct units with 8 plus 20 points',()=>{
 const parsed=parseRequirement(newWorkbook(),filename),completed=Date.UTC(2026,8,4,4);
 const task={...parsed,state:4,owner:'hong',createdAt:parsed.requestedAt,assignedAt:parsed.requestedAt,completedAt:completed,sealed:false};
 const report=createReport([task],[],{frequency:'month',anchor:'2026-09-04',generatedAt:completed+3600000});
 assert.equal(report.counts.tasks,1);assert.equal(report.counts.items,2);
 const zip=unzipSync(report.bytes),xmlParser=new XMLParser({ignoreAttributes:false,attributeNamePrefix:'@_',parseTagValue:false});
 const rows=xmlParser.parse(strFromU8(zip['xl/worksheets/sheet3.xml'])).worksheet.sheetData.row.slice(1).map(row=>Object.fromEntries(row.c.map(c=>[c['@_r'].replace(/\d+$/,''),c['@_t']==='inlineStr'?c.is.t:c.v])));
 assert.deepEqual(rows.map(r=>[r.H,r.I,r.J,r.K,r.L,r.M]),[['包装设计','包装设计','2','套','4','8'],['产品视频','创意视频','8','分镜','2.5','20']]);
 const taskXml=strFromU8(zip['xl/worksheets/sheet2.xml']);assert.match(taskXml,/<c r="R2"[^>]*><v>28<\/v><\/c>/);
});
