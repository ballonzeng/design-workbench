'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../ui/app.js'),'utf8').replace(/\r\n/g,'\n');
const helpers=source.slice(source.indexOf('function taskDetailFields('),source.indexOf('async function taskDetail('));
function fixture(){
 const task={id:'task',title:'水杨酸主图详情页图',product:'水杨酸',brand:'AbunGour',code:'6976544574182',state:4,owner:'chang',updatedAt:1};
 const labels=['任务状态','产品名','品牌','产品69码','运营','设计师','提出需求','分配时间','首次开始','提交待确认','确认完成','完成封存','最近更新','有效设计耗时'];
 const values=new Map(labels.map(label=>[label,{textContent:'旧值'}]));
 const labelNodes=labels.map(label=>({textContent:label})),rows=labels.map((label,index)=>({querySelector:selector=>selector==='dt'?labelNodes[index]:values.get(label)}));
 const title={textContent:'旧标题'},sheetBody={scrollTop:265},history={innerHTML:'已加载的历史记录'},timingNote={textContent:'旧说明'};let queried=0;
 const context=vm.createContext({data:{tasks:[task]},reviewResult:null,dialogContext:{kind:'detail',taskId:'task'},states:['待分配','待设计','设计中','待确认','已完结'],manager:()=>true,peopleName:()=> '常慧杰',dateTime:value=>value==null?'—':String(value),reviewDate:value=>value==null?'—':'完整日期:'+value,timeText:String,taskName:t=>t.title,$:selector=>selector==='#sheet-title'?title:selector==='#sheet-body'?sheetBody:selector==='#task-detail-timing-note'?timingNote:history,document:{querySelectorAll:selector=>{assert.equal(selector,'#sheet-body .summary-line');queried++;return rows}}});
 vm.runInContext(helpers,context);
 return {context,task,values,title,sheetBody,history,timingNote,labelNodes,rows,queries:()=>queried};
}
test('an open task detail follows corrected barcode and saved metadata without rebuilding its panel',()=>{
 const f=fixture();f.context.refreshTaskDetail();assert.equal(f.values.get('产品69码').textContent,'6976544574182');
 const row=f.rows[3];f.task.code='6976544574199';f.task.updatedAt=2;f.task.title='已更正的需求';f.task.state=3;f.task.designTiming={label:'估算有效设计耗时',displayMs:3600000,reason:'按工作日历估算'};
 f.context.refreshTaskDetail();
 assert.equal(f.values.get('产品69码').textContent,'6976544574199');assert.equal(f.values.get('最近更新').textContent,'2');assert.equal(f.values.get('任务状态').textContent,'待确认');assert.equal(f.title.textContent,'已更正的需求');
 assert.equal(f.rows[3],row);assert.equal(f.sheetBody.scrollTop,265);assert.equal(f.history.innerHTML,'已加载的历史记录');
 assert.equal(f.labelNodes[13].textContent,'估算有效设计耗时');assert.equal(f.values.get('有效设计耗时').textContent,'3600000');assert.equal(f.timingNote.textContent,'按工作日历估算');
 // Rendering snapshots invokes the same in-place update used by this test.
 assert.match(source.slice(source.indexOf('function render('),source.indexOf('async function navigate(')),/refreshTaskDetail\(\)/);
 assert.match(source.slice(source.indexOf('async function taskDetail('),source.indexOf('async function pairPerson(')),/taskDetailFields\(t,detailDate\)\.map/);
});
test('detail refresh leaves upload, rollback and other editable dialogs untouched',()=>{
 const f=fixture();
 for(const kind of ['archive','rollback','calibration','manager-archive',undefined]){f.context.dialogContext={kind,taskId:'task',selection:{selectionId:'keep'},namingDirty:true};f.context.refreshTaskDetail();assert.equal(f.context.dialogContext.selection.selectionId,'keep');assert.equal(f.context.dialogContext.namingDirty,true)}
 f.context.dialogContext=null;f.context.refreshTaskDetail();f.context.dialogContext={kind:'detail',taskId:'different-task'};f.context.refreshTaskDetail();
 assert.equal(f.queries(),0);assert.equal(f.values.get('产品69码').textContent,'旧值');assert.equal(f.title.textContent,'旧标题');
});
test('opening a designer task uses the snapshot received while its read receipt is pending',async()=>{
 for(const removed of [false,true]){
  let finishRead,opened=null;
  const task={id:'task',title:'旧需求',product:'水杨酸',brand:'AbunGour',code:'6976544574182',state:4,owner:'chang',assignmentId:'assignment',items:[]};
  const context=vm.createContext({data:{tasks:[task],rates:[],person:{name:'常慧杰'}},reviewResult:null,view:'tasks',dialogContext:null,states:['待分配','待设计','设计中','待确认','已完结'],manager:()=>false,peopleName:()=> '常慧杰',dateTime:value=>value==null?'—':String(value),timeText:String,taskName:t=>t.title,points:()=>1.2,fmt:String,esc:String,button:()=>'',icon:()=>'',connected:()=>true,managerCanFinishArchive:()=>false,$:()=>({innerHTML:''}),api:command=>command==='read'?new Promise(resolve=>finishRead=resolve):Promise.resolve([]),openSheet:(title,content,detailContext)=>{opened={title,content};context.dialogContext={...detailContext,kind:'detail'}}});
  vm.runInContext(helpers+source.slice(source.indexOf('async function taskDetail('),source.indexOf('async function pairPerson(')),context);
  const pending=context.taskDetail('task');assert.equal(opened,null);assert.equal(typeof finishRead,'function');
  // A push snapshot replaces task objects before the receipt request finishes.
  context.data.tasks=removed?[]:[{...task,title:'更正后的需求',code:'6976544574199'}];finishRead();await pending;
  if(removed)assert.equal(opened,null);else{assert.equal(opened.title,'更正后的需求');assert.ok(opened.content.includes('6976544574199'));assert.ok(!opened.content.includes('6976544574182'))}
 }
});
test('review task metadata retains full dates and its server-provided effective duration',()=>{
 const f=fixture();f.task.updatedAt=2;f.task.designTiming={label:'有效设计耗时',displayMs:7200000,reason:'来自设计计时区间'};
 f.context.dialogContext.reviewDates=true;f.context.reviewResult={tasks:[f.task]};f.context.data.tasks=[];
 f.context.refreshTaskDetail();assert.equal(f.values.get('最近更新').textContent,'完整日期:2');assert.equal(f.values.get('有效设计耗时').textContent,'7200000');assert.equal(f.timingNote.textContent,'来自设计计时区间');
 // Ordinary snapshot refresh must not turn historical record fields into live-task metadata.
 f.task.recordOnly=true;f.task.code='6976544574199';f.context.refreshTaskDetail();assert.equal(f.values.get('产品69码').textContent,'6976544574182');
});
test('opening a historical review record keeps the upstream archive details and never requests a read receipt',async()=>{
 let opened,requested=false;
 const task={id:'historical',recordOnly:true,title:'包装补录',product:'包装盒',owner:'chang',completedDate:'2026-11-01',supplementedAt:1,items:[{typeName:'包装设计',points:4,qty:1}],historicalArchive:{at:2,productPath:'历史产物路径'}};
 const context=vm.createContext({data:{tasks:[]},reviewResult:{tasks:[task]},view:'review',reviewDate:value=>'完整日期:'+value,dateTime:String,taskName:t=>t.title,peopleName:()=> '常慧杰',points:()=>4,fmt:String,esc:String,button:()=>'',icon:()=>'',api:()=>{requested=true;throw Error('unexpected RPC')},openSheet:(...args)=>opened=args});
 vm.runInContext(source.slice(source.indexOf('async function taskDetail('),source.indexOf('async function pairPerson(')),context);await context.taskDetail('historical');
 assert.equal(opened[0],'包装补录');assert.equal(opened[3],'HISTORICAL RECORD');assert.ok(opened[1].includes('历史产物路径'));assert.ok(opened[1].includes('完整日期:2'));assert.ok(opened[1].includes('2026-11-01（未记录时刻）'));assert.equal(requested,false);
});
