'use strict';
const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {Service}=require('../core/service.cjs'),R=require('../core/rules.cjs');
const out=path.resolve('outputs/ui-0.6.30-month');fs.mkdirSync(out,{recursive:true});app.setPath('userData',path.join(out,'profile'));app.on('window-all-closed',()=>{});fs.rmSync(path.join(out,'error.txt'),{force:true});
process.stdout.on('error',()=>{});process.stderr.on('error',()=>{});
const wait=ms=>new Promise(r=>setTimeout(r,ms));let role='manager',service;const results=[],errors=[];
app.whenReady().then(async()=>{
 service=new Service(path.join(out,'db-'+Date.now()));let seq=0;
 for(const state of [0,1,2,3,4]){const id='ui-'+state;service.store.put('task',id,{id,state,owner:state?'hong':null,title:'示例产品主图',product:'示例产品',brand:'测试品牌',code:'6970855224163',operator:'测试运营',filename:'需求.xlsx',items:[{row:6,id:'row-6',type:'basic',typeName:'单图任务',qty:2,points:1.6}],version:1,createdAt:Date.now()-86400000,assignedAt:Date.now()-80000000,startedAt:state>1?Date.now()-3600000:null,reviewAt:state>=3?Date.now()-1800000:null,completedAt:state===4?Date.now()-600000:null,completedMonth:R.monthKey(Date.now()),updatedAt:Date.now(),sealed:false})}
 const actor=()=>({role,personId:role==='manager'?'zeng':'hong'});
 ipcMain.handle('workbench:call',async(_e,c,p)=>{try{let value=[];if(c==='snapshot')value={...service.snapshot(actor()),version:'0.6.30',connection:{online:true},nasStatus:{connected:true},addresses:[{address:'192.168.1.100',adapter:'Ethernet'}]};else if(['work-calendar-preview','work-policy-save'].includes(c))value=await service.call(actor(),c,p,'ui-'+seq++);else if(c==='pair-code'||c==='manager-pair-code')value={code:'DW1.TEST-CONNECTION-CODE'};else if(c==='duplicate-inspect')value={keep:service.store.get('task','ui-4'),duplicate:service.store.get('task','ui-3')};else if(c==='archive-spec')value={folderUploadVersion:2,namingVersion:4,namingRepairVersion:1,basePrefix:'0924-洪华-',categories:R.CATEGORIES,productMatch:{status:'exact',message:'69码一致',destinationName:'示例产品'}};return {ok:true,value}}catch(e){return {ok:false,error:e.message}}});
 async function evaluate(w,code){return w.webContents.executeJavaScript(code)}
 async function click(w,selector){await evaluate(w,`document.querySelector(${JSON.stringify(selector)}).click()`);await wait(100)}

 const w=new BrowserWindow({show:false,width:1024,height:760,frame:false,backgroundColor:'#f5f5f7',webPreferences:{preload:path.resolve('desktop/preload.cjs'),contextIsolation:true,sandbox:true}});
 require('../core/window-chrome.cjs')(w,ipcMain);w.webContents.on('console-message',(_e,d)=>{if(d.level==='error'&&!d.message.includes('favicon'))errors.push(d.message)});
 await w.loadFile(path.resolve('ui/index.html'));await wait(350);await click(w,'[data-command="work-policy-open"]');
 const month=R.monthKey(Date.now()),date=month+'-20',future=(Number(month.slice(0,4))+1)+'-02';
 const original=await evaluate(w,`document.querySelector('[data-date="${date}"]').className`);
 await click(w,'[data-date="'+date+'"]');const changed=await evaluate(w,`document.querySelector('[data-date="${date}"]').className`);assert.notEqual(changed,original);
 assert.equal(await evaluate(w,`document.querySelector('#work-month').tagName`),'BUTTON');assert.equal(await evaluate(w,`document.querySelector('input[type="month"]')===null`),true);
 await click(w,'#work-month');
 for(const [width,height] of [[1360,900],[1024,650],[800,500]]){
  w.setSize(width,height);await wait(100);const r=await evaluate(w,`(()=>{const d=document.querySelector('.date-picker'),b=d.getBoundingClientRect(),c=document.querySelector('.window-controls');return {count:d.querySelectorAll('.calendar-months button').length,selected:d.querySelector('[aria-pressed="true"]').dataset.date,top:b.top,bottom:b.bottom,left:b.left,right:b.right,height:innerHeight,width:innerWidth,radius:getComputedStyle(d).borderRadius,overflow:d.scrollHeight>d.clientHeight+1,controls:d.contains(c)&&c.matches(':popover-open')}})()`);
  assert.equal(r.count,12);assert.equal(r.selected,month+'-01');assert(r.top>=42&&r.bottom<=r.height&&r.left>=0&&r.right<=r.width,JSON.stringify(r));assert.equal(r.overflow,false);assert(r.controls);results.push({width,height,...r});
 }
 w.setSize(1024,760);await wait(100);fs.writeFileSync(path.join(out,'month-menu.png'),(await w.capturePage()).toPNG());
 await click(w,'.date-picker [data-step="1"]');await click(w,'.date-picker [data-close]');assert.equal(await evaluate(w,`document.querySelector('#work-month').value`),month);
 await click(w,'#work-month');await click(w,'.date-picker [data-step="1"]');await click(w,'.date-picker [data-date="'+future+'-01"]');await wait(150);
 assert.equal(await evaluate(w,`document.querySelector('#work-month').value`),future);assert(await evaluate(w,`document.querySelector('#work-calendar [data-date="${future}-01"]')!==null`));
 await click(w,'#work-month');await click(w,'.date-picker [data-today]');await wait(150);assert.equal(await evaluate(w,`document.querySelector('#work-month').value`),month);assert.equal(await evaluate(w,`document.querySelector('#work-calendar [data-date="${date}"]').className`),changed);
 await click(w,'#work-month');await evaluate(w,`document.querySelector('.date-picker').dispatchEvent(new Event('cancel',{cancelable:true}))`);await wait(100);assert.equal(await evaluate(w,`document.activeElement.id`),'work-month');assert(await evaluate(w,`document.querySelector('#sheet').contains(document.querySelector('.window-controls'))`));
 await click(w,'[data-command="work-policy-save"]');assert.equal(service.store.get('setting','workPolicies')[month].exceptions[date],false);
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({results,checks:['12 months and selected state','year navigation','cancel preserves month','month preview changes','unsaved adjustments survive month switch','current month shortcut','escape restores focus and window controls','policy saves'],errors},null,2));w.destroy();service.store.close();app.exit(0);
}).catch(e=>{fs.writeFileSync(path.join(out,'error.txt'),e.stack||String(e));app.exit(1)});
