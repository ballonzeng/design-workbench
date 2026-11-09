'use strict';
const fs=require('node:fs'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const {readPlan}=require('./backfill-packaging-2026-11.cjs'),{prepareHistoricalTasks}=require('../core/historical-tasks.cjs');
const {planHistoricalArchive,archiveHistoricalPlan}=require('../core/historical-archive.cjs');
const out=path.resolve(__dirname,'../outputs/packaging-backfill-2026-11-03');
const dbPath=path.join(process.env.APPDATA,'设计协作·负责人端/workspaces/49eccbca4e09212f9fa7/workbench.sqlite');
const sources=new Map([
 ['蓝山味黑咖啡','AG蓝山黑咖啡'],
 ['西洋参黄芪党参桂圆茶','西洋参黄芪党参桂圆茶包装'],
 ['九制黄精','九芝堂-九制黄精ai文件'],
 ['ag氨基酸云感洁面','AG氨基酸云感洁面乳包装文件'],
 ['协和花阿胶膏500g','1029-协和花-阿胶糕包装-定(1)'],
 ['人参黄精肉苁蓉枸杞原浆饮','协和花-人参黄精肉苁蓉枸杞原浆饮包装']
]);
async function main(){
 const execute=process.argv.includes('--copy'),db=new DatabaseSync(dbPath,{readOnly:true});let config;
 try{config=JSON.parse(db.prepare("SELECT body FROM records WHERE kind='setting' AND id='nas'").get().body)}finally{db.close()}
 const {rows}=readPlan(path.join(out,'plan.json'));
 const tasks=prepareHistoricalTasks(rows,{now:Date.now(),actor:'zeng',source:'user-confirmed-historical'}).records;
 if(tasks.length!==6)throw Error('Expected six confirmed records');
 const archiveDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(Date.now());
 const plans=[];
 for(const task of tasks){
  const folder=sources.get(task.product);if(!folder)throw Error('No confirmed source for '+task.product);
  const sourceRoot=path.join(process.env.USERPROFILE,'Desktop',folder);
  plans.push(await planHistoricalArchive(task,{sourceRoot,assetRoot:config.assetRoot,archiveDate}));
 }
 const files=plans.flatMap(p=>p.files),totals={records:plans.length,files:files.length,bytes:files.reduce((n,f)=>n+f.size,0),sourceFiles:files.filter(f=>f.kind==='source').length,outputFiles:files.filter(f=>f.kind==='output').length};
 console.log(JSON.stringify({phase:"inventory",totals}));
 if(totals.files!==57||totals.bytes!==685850386)throw Error('Source inventory differs from confirmed 57 files / 685850386 bytes');
 fs.writeFileSync(path.join(out,'archive-plans.json'),JSON.stringify({schemaVersion:1,status:'planned',at:Date.now(),consent:'用户确认：暂时没有69码，先封存到待定位区',totals,plans},null,2));
 console.log(JSON.stringify({phase:'planned',execute,totals}));
 if(!execute)return;
 const archives=[];
 for(const plan of plans){
  console.log(JSON.stringify({phase:'copying',product:plan.product,files:plan.files.length}));
  archives.push(await archiveHistoricalPlan(plan));
  fs.writeFileSync(path.join(out,'archives-progress.json'),JSON.stringify({schemaVersion:1,status:'partial',at:Date.now(),archives,totals},null,2));
  console.log(JSON.stringify({phase:'verified',product:plan.product,completed:archives.length,files:plan.files.length}));
 }
 fs.writeFileSync(path.join(out,'archives.json'),JSON.stringify({schemaVersion:1,source:'user-confirmed-historical',status:'archived',at:Date.now(),archives,totals},null,2));
 console.log(JSON.stringify({phase:'complete',totals,bundle:path.join(out,'archives.json')}));
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1});
