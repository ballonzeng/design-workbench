'use strict';
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Service}=require('../core/service.cjs'),{createPersonalReport}=require('../core/personal-report.cjs');
const root=path.resolve(__dirname,'..'),out=path.join(root,'checks','personal-report-ui');
fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let service,win,role='designer',online=true,capability=1,cancelSave=false;
const errors=[],exportResults=[],layouts=[];
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
 service=new Service(fs.mkdtempSync(path.join(out,'db-')));
 const timestamp=Date.now();
 service.store.put('task','example-task',{id:'example-task',owner:'hong',state:4,title:'示例产品上新设计',brand:'示例品牌',product:'示例产品',code:'6900000000000',filename:'示例需求.xlsx',operator:'示例运营',createdAt:timestamp-86400000,reviewAt:timestamp-3600000,completedAt:timestamp-600000,completedMonth:new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(timestamp),completionTimeSource:'app-confirmed',version:1,items:[{row:6,type:'sku-full',qty:4,points:2},{row:7,type:'main-full',qty:3,points:2.4},{row:8,type:'detail-full',qty:6,points:9}]});
 const actor=()=>({role,personId:role==='designer'?'hong':'zeng'});
 ipcMain.handle('workbench:call',async(_event,command,payload)=>{
  try{
   if(command==='snapshot')return {ok:true,value:{...service.snapshot(actor()),version:'0.6.29 + 个人导出',connection:{online},nasStatus:{connected:true},personalReportVersion:capability}};
   if(command==='export-personal-report'){
    const source=await service.call(actor(),'personal-report-data',payload);
    const report=createPersonalReport(source.tasks,{...payload,...source});
    exportResults.push({payload,counts:report.counts});
    if(cancelSave)return {ok:true,value:null};
    const file=path.join(out,'个人任务明细-测试数据.xlsx');fs.writeFileSync(file,report.bytes);
    return {ok:true,value:{path:file,label:report.range.label,counts:report.counts}};
   }
   return {ok:true,value:[]};
  }catch(error){return {ok:false,error:error.message}}
 });
 win=new BrowserWindow({show:false,frame:false,width:1360,height:900,backgroundColor:'#f5f5f7',webPreferences:{preload:path.join(root,'desktop','preload.cjs'),contextIsolation:true,sandbox:true}});
 require('../core/window-chrome.cjs')(win,ipcMain);
 win.webContents.on('console-message',(_event,details)=>{if(details.level==='error')errors.push(details.message)});
 const evaluate=code=>win.webContents.executeJavaScript(code);
 const click=async selector=>{await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);await wait(100)};
 async function audit(label,sheet=false){
  for(const [width,height]of [[1360,900],[1024,650],[820,640]]){
   win.setSize(width,height);await wait(100);
   const state=await evaluate(`(()=>{const main=document.querySelector('#main'),s=document.querySelector('#sheet'),body=document.querySelector('#sheet-body'),footer=document.querySelector('#sheet-footer');return {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,mainWidth:main.clientWidth,mainScroll:main.scrollWidth,open:s.open,top:s.getBoundingClientRect().top,bottom:s.getBoundingClientRect().bottom,bodyWidth:body.clientWidth,bodyScroll:body.scrollWidth,footerBottom:footer.getBoundingClientRect().bottom}})()`);
   assert(state.documentWidth<=state.width+1,label+' document overflow');assert(state.mainScroll<=state.mainWidth+1,label+' main overflow');
   if(sheet){assert(state.open,label+' panel absent');assert(state.top>=42&&state.bottom<=state.height+1,label+' panel viewport');assert(state.bodyScroll<=state.bodyWidth+1,label+' panel overflow');assert(state.footerBottom<=state.height,label+' footer clipped')}
   layouts.push({label,...state});
  }
  win.setSize(1024,760);await wait(100);fs.writeFileSync(path.join(out,label+'.png'),(await win.capturePage()).toPNG());
 }
 await win.loadFile(path.join(root,'ui','index.html'));await wait(250);
 assert(await evaluate(`!!document.querySelector('[data-command="personal-report-open"]')`));
 await click('[data-view="reports"]');await audit('personal-reports');
 await click('[data-frequency="week"]');await audit('weekly-export',true);
 assert.match(await evaluate(`document.querySelector('#personal-range').textContent`),/北京时间/);
 const thisWeek=await evaluate(`document.querySelector('#personal-anchor').value`);
 await click('[data-offset="-7"]');const lastWeek=await evaluate(`document.querySelector('#personal-anchor').value`);assert.equal(Date.parse(thisWeek)-Date.parse(lastWeek),7*86400000);
 await click('[data-offset="0"]');
 await click('#personal-anchor');assert(await evaluate(`document.querySelector('.date-picker').open`));await click('.date-picker [data-close]');
 await click('[data-command="personal-report-export"]');assert.equal(exportResults.at(-1).counts.tasks,1);assert.equal(exportResults.at(-1).counts.points,13.4);assert(!await evaluate(`document.querySelector('#sheet').open`));
 await click('[data-frequency="month"]');await audit('monthly-export',true);await click('#personal-anchor');assert(await evaluate(`!!document.querySelector('.calendar-months')`));await click('.date-picker [data-close]');
 cancelSave=true;await click('[data-command="personal-report-export"]');assert(await evaluate(`document.querySelector('#sheet').open`));cancelSave=false;await click('[data-command="close-sheet"]');
 await click('[data-frequency="custom"]');await audit('custom-export',true);
 const previousDay=new Date(Date.parse(thisWeek+'T12:00:00Z')-86400000).toISOString().slice(0,10);
 await evaluate(`document.querySelector('#personal-start').value=${JSON.stringify(thisWeek)};document.querySelector('#personal-end').value=${JSON.stringify(previousDay)}`);
 await click('[data-command="personal-report-export"]');assert.match(await evaluate(`document.querySelector('#sheet-error').textContent`),/结束日期/);assert(await evaluate(`document.querySelector('#sheet').open`));
 await click('#personal-end');await click('.date-picker [data-today]');assert((await evaluate(`document.querySelector('#personal-range').textContent`)).includes(thisWeek));await click('[data-command="close-sheet"]');
 capability=0;await click('[data-command="refresh"]');assert(await evaluate(`document.querySelector('[data-command="personal-report-open"]').disabled`));assert.match(await evaluate(`document.querySelector('main').textContent`),/更新负责人主机/);
 capability=1;online=false;await click('[data-command="refresh"]');assert(await evaluate(`document.querySelector('[data-command="personal-report-open"]').disabled`));
 online=true;role='manager';await win.loadFile(path.join(root,'ui','index.html'));await wait(200);await click('[data-view="reports"]');assert(await evaluate(`!!document.querySelector('[data-command="report-open"]')`));assert(!await evaluate(`document.querySelector('[data-command="personal-report-open"]')`));
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({layouts,exportResults,errors},null,2));
 service.store.close();app.exit(0);
}).catch(error=>{fs.writeFileSync(path.join(out,'error.txt'),error.stack||String(error));try{service?.store.close()}catch{}app.exit(1)});
