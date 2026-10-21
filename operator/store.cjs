const {isTemplateFile}=require('../core/template-files.cjs');
'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');const {STAGES,safeName,validCode}=require('../core/rules.cjs');const {parseRequirement,patchWorkbook,patchBarcode,workbookTaskId,unpack,mergedValue,cellText}=require('../core/workbook.cjs');const {guarded}=require('../core/nas.cjs');
async function timedRead(promise,label){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label+'超时，请先在资源管理器打开 NAS 路径，检查网络或登录权限后重试')),20000)})])}finally{clearTimeout(timer)}}
const {validateLinks}=require('./link-validation.cjs');
const {readRatings,patchRatings}=require('./ratings.cjs');
const {hasWorkbookLock}=require('../core/workbook-lock.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
async function existingHash(file){try{return hash(await fs.readFile(file))}catch(e){if(e.code==='ENOENT')return null;throw e}}
function correctionIdentity(task){const copy=structuredClone(task);delete copy.id;delete copy.sourceHash;delete copy.code;for(const item of copy.items||[])delete item.code;return JSON.stringify(copy)}
class OperatorStore{
 constructor(dir){this.dir=dir;this.settings={name:'',root:'\\\\Kyuan_NAS\\任务对接库'};this.cache=new Map();this.tasks=[];this.issues=[];this.busy=null}
 async init(){await fs.mkdir(this.dir,{recursive:true});try{this.settings={...this.settings,...JSON.parse(await fs.readFile(path.join(this.dir,'operator.json'),'utf8'))}}catch(e){if(e.code!=='ENOENT')throw e}return this}
 async configure(value){const name=String(value.name||'').trim(),root=String(value.root||'').trim();safeName(name,'运营姓名');if(!path.isAbsolute(root))throw Error('请填写完整 NAS 路径');await timedRead(fs.access(root),'访问 NAS ');this.settings={name,root:path.resolve(root)};await fs.writeFile(path.join(this.dir,'operator.json'),JSON.stringify(this.settings));this.cache.clear();return this.scan()}
 async scan(){if(this.busy)return this.busy;this.busy=this.read().finally(()=>this.busy=null);return this.busy}
 async read(){if(!this.settings.name)return {tasks:[],issues:[],settings:this.settings};const tasks=[],issues=[],seen=new Set();
 for(let state=0;state<STAGES.length;state++){const dir=await timedRead(guarded(this.settings.root,STAGES[state]),STAGES[state]+'目录检查');for(const e of await timedRead(fs.readdir(dir,{withFileTypes:true}),STAGES[state]+'目录读取')){if(isTemplateFile(e.name)||!e.isFile()||!e.name.endsWith('.xlsx')||/^[.~]/.test(e.name))continue;const file=await timedRead(guarded(dir,e.name),'需求路径检查');seen.add(file);try{const stat=await timedRead(fs.stat(file),'需求信息读取');if(stat.size>50*1024**2)throw Error('超过50MB，未读取');let c=this.cache.get(file);const signature=stat.size+':'+stat.mtimeMs;if(!c||c.signature!==signature){const bytes=await timedRead(fs.readFile(file),'需求表读取'),wb=unpack(bytes),owner=cellText(mergedValue(wb.status,'D4'));if(owner!==this.settings.name)c={signature,other:true,workbookTaskId:workbookTaskId(wb)};else{const parsed=parseRequirement(bytes,e.name);parsed.ratings=readRatings(bytes,parsed.items);c={signature,parsed}}this.cache.set(file,c)}if(c.other)continue;const t=c.parsed;tasks.push({...t,id:parseInt(hash(Buffer.from(file)).slice(0,12),16),state,designer:t.requestedDesigner,count:t.items.map(i=>i.typeName+' '+i.qty).join(' · '),time:t.templateTimes.completedAt||t.templateTimes.reviewAt||t.templateTimes.startedAt||t.templateTimes.assignedAt||t.requestedAt,file,signature})}catch(e2){if(e.name.split('-').at(-2)?.trim()===this.settings.name)issues.push({file:e.name,stage:STAGES[state],message:e2.message})}}}
 this.tasks=tasks;this.issues=issues;for(const key of this.cache.keys())if(!seen.has(key))this.cache.delete(key);return {tasks,issues,settings:this.settings,checkedAt:Date.now()}}
 async own(id,allowed){const t=this.tasks.find(t=>t.id===id);if(!t||!allowed.includes(t.state))throw Error('当前阶段不允许此操作，请刷新');const file=await guarded(this.settings.root,STAGES[t.state],t.filename);const bytes=await fs.readFile(file),parsed=parseRequirement(bytes,t.filename);if(parsed.operator!==this.settings.name||parsed.sourceHash!==t.sourceHash)throw Error('原需求已变化，请刷新后重试');return {t,file,bytes,parsed}}
 async uniqueCorrectionOriginal(task,file){
  const matches=[];
  for(const stage of STAGES){const dir=await guarded(this.settings.root,stage);for(const entry of await fs.readdir(dir,{withFileTypes:true})){
   if(!entry.isFile()||isTemplateFile(entry.name)||!entry.name.toLowerCase().endsWith('.xlsx')||/^[.~]/.test(entry.name))continue;
   const candidate=await guarded(this.settings.root,stage,entry.name);
   if(entry.name===task.filename){matches.push(candidate);continue}
   if(!task.workbookTaskId)continue;
   const stat=await fs.stat(candidate),signature=stat.size+':'+stat.mtimeMs,cached=this.cache.get(candidate);
   let internalId;
   if(cached?.signature===signature)internalId=cached.parsed?.workbookTaskId||cached.workbookTaskId;
   else internalId=workbookTaskId(await fs.readFile(candidate));
   if(internalId===task.workbookTaskId)matches.push(candidate);
  }}
  if(matches.length!==1||matches[0]!==file)throw Error('存在多份同名或同任务编号的需求表，请负责人保留唯一原表后再更正69码');
 }
 async correctionHasAssets(task,bytes){
  if(cellText(mergedValue(unpack(bytes).status,'L4')))return true;
  if(!task.workbookTaskId)return false;
  const dir=await guarded(this.settings.root,'_workbench-system','asset-records');let entries;
  try{entries=await fs.readdir(dir,{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return false;throw e}
  for(const entry of entries){if(!entry.isFile()||!entry.name.endsWith('.json'))continue;const file=await guarded(this.settings.root,'_workbench-system','asset-records',entry.name);let record;try{record=JSON.parse(await fs.readFile(file,'utf8'))}catch{throw Error('归档记录暂时无法核对，请负责人检查后更正69码')}if(record.taskId===task.workbookTaskId)return true}
  return false;
 }
 async correctCode(id,code,expectedHash){
  if(typeof code!=='string'||!validCode(code.trim()))throw Error('请填写69开头的13位产品69码');code=code.trim();
  if(typeof expectedHash!=='string'||!/^[a-f0-9]{64}$/.test(expectedHash))throw Error('请刷新后重新核对69码');
  const {t,file,bytes,parsed}=await this.own(id,[0,1,2,3]);
  if(expectedHash!==parsed.sourceHash)throw Error('原需求已变化，请刷新后重试');
  await this.uniqueCorrectionOriginal(t,file);
  if(await this.correctionHasAssets(t,bytes))throw Error('该需求已有封存产物或归档位置，请负责人核对产物归属后更正69码');
  if(parsed.code===code)return this.scan();
  if(await hasWorkbookLock(file,this.settings.root))throw Error('检测到 Excel 占用记录，请保存并关闭后更正69码');
  const jobId=crypto.randomUUID(),lock=await guarded(this.settings.root,STAGES[t.state],'~$'+t.filename),lockBytes=Buffer.from(JSON.stringify({kind:'barcode-correction',id:jobId,operator:this.settings.name}));
  const temp=await guarded(this.settings.root,STAGES[t.state],'.operator-code-'+jobId+'.tmp'),backup=await guarded(this.settings.root,STAGES[t.state],'.operator-code-'+jobId+'.bak');
  let handle;
  try{handle=await fs.open(lock,'wx')}catch(e){if(e.code==='EEXIST')throw Error('Excel 或另一端正在操作，请保存并关闭后重试');throw e}
  let recovery,manifest,manifestFile,moved=false,published=false;
  const saveManifest=async()=>{if(manifestFile)await fs.writeFile(manifestFile,JSON.stringify(manifest,null,2))};
  try{
   await handle.writeFile(lockBytes);await handle.sync();
   if(await existingHash(file)!==expectedHash)throw Error('原需求已变化，请刷新后重试');
   const output=patchBarcode(bytes,code),after=parseRequirement(output,t.filename),nextHash=hash(output);
   if(after.code!==code||correctionIdentity(parsed)!==correctionIdentity(after))throw Error('69码更正校验失败，原需求已保留');
   recovery=await guarded(this.settings.root,'_workbench-system','recovery','barcode-corrections',jobId);await fs.mkdir(recovery,{recursive:true});
   const beforeFile=path.join(recovery,'before.xlsx');await fs.writeFile(beforeFile,bytes,{flag:'wx'});if(await existingHash(beforeFile)!==expectedHash)throw Error('原表备份校验失败，未更正69码');
   manifestFile=path.join(recovery,'manifest.json');manifest={id:jobId,kind:'barcode-correction',status:'prepared',at:Date.now(),operator:this.settings.name,taskId:t.workbookTaskId||null,stage:STAGES[t.state],source:file,temporary:temp,backup,before:beforeFile,from:parsed.code,to:code,originalHash:expectedHash,nextHash};await saveManifest();
   const staged=await fs.open(temp,'wx');try{await staged.writeFile(output);await staged.sync()}finally{await staged.close()}
   if(await existingHash(temp)!==nextHash)throw Error('更正后的表格校验失败，原需求已保留');
   await this.uniqueCorrectionOriginal(t,file);
   if(await existingHash(file)!==expectedHash)throw Error('原需求刚刚发生变化，请刷新后重试');
   await fs.rename(file,backup);moved=true;
   if(await existingHash(backup)!==expectedHash)throw Error('原需求刚刚发生变化，未覆盖另一次保存');
   manifest.status='backed-up';await saveManifest();
   // Exclusive publication preserves a concurrent save instead of replacing it.
   await fs.copyFile(temp,file,require('node:fs').constants.COPYFILE_EXCL);published=true;
   if(await existingHash(file)!==nextHash||await existingHash(backup)!==expectedHash)throw Error('写入结果已变化，保留原表备份供恢复');
   manifest.status='completed';manifest.completedAt=Date.now();await saveManifest();
   await fs.unlink(backup);moved=false;
   try{await fs.appendFile(path.join(this.dir,'actions.jsonl'),JSON.stringify({at:Date.now(),operator:this.settings.name,action:'correct-code',taskId:t.workbookTaskId||null,source:file,from:parsed.code,to:code,originalHash:expectedHash,nextHash,backup:beforeFile})+'\n')}catch(e){manifest.localLogError=e.message;await saveManifest().catch(()=>{})}
  }catch(e){
   let recoveryError;
   if(moved){try{
    const currentHash=await existingHash(file),backupHash=await existingHash(backup);
    // Once published, retain both versions for review. A check then unlink could
    // otherwise remove an Excel save that arrived after the hash read.
    if(published)throw Error('更正结果已发布，已保留当前原表与备份供核对');
    if(await existingHash(file)===null){if(!backupHash)throw Error('原表备份暂不可读取');await fs.copyFile(backup,file,require('node:fs').constants.COPYFILE_EXCL);if(await existingHash(file)!==backupHash)throw Error('恢复原表校验未完成');await fs.unlink(backup);moved=false}
    else if(currentHash!==backupHash)throw Error('检测到另一次保存，已保留该文件和原表备份');
   }catch(failure){recoveryError=failure}}
   if(manifest){manifest.status=recoveryError?'recovery-needed':'rolled-back';manifest.error=e.message;if(recoveryError)manifest.recoveryError=recoveryError.message;await saveManifest().catch(()=>{})}
   if(recoveryError)throw Error(e.message+'；恢复资料保留于 '+recovery+'，请负责人核对，未覆盖另一份保存');
   throw e;
  }finally{
   await fs.unlink(temp).catch(()=>{});await handle.close().catch(()=>{});
   try{if(await existingHash(lock)===hash(lockBytes))await fs.unlink(lock)}catch{}
   this.cache.delete(file);
  }
  return this.scan();
 }
 async submit(file,{asNew=false,expectedHash}={}){if(!this.settings.name)throw Error('请先设置运营姓名');let bytes=await fs.readFile(file);if(expectedHash&&hash(bytes)!==expectedHash)throw Error('文件已变化，请重新拖入确认');if(bytes.length>50*1024**2)throw Error('需求表超过50MB');const filename=path.basename(file),t=parseRequirement(bytes,filename);validateLinks(t.items);if(t.operator!==this.settings.name)throw Error('表内运营姓名为「'+t.operator+'」，与当前身份不同');if(t.requestedDesigner!=='未分配'||t.templateTimes.startedAt||t.templateTimes.completedAt)throw Error('请使用未分配的新需求表');if(t.workbookTaskId&&!asNew){const e=Error('这份表带有旧任务编号，是否作为新需求提交？');e.code='COPIED_TASK';e.sourceHash=hash(bytes);throw e;}for(const stage of STAGES){try{await fs.access(path.join(this.settings.root,stage,filename));throw Error('NAS 中已存在同名需求，未重复提交')}catch(e){if(e.code!=='ENOENT')throw e}}
 if(t.workbookTaskId){const {strFromU8,strToU8,zipSync}=require('fflate');const wb=unpack(bytes);const xml=strFromU8(wb.entries['xl/workbook.xml']);wb.entries['xl/workbook.xml']=strToU8(xml.replace(/<definedName\b(?=[^>]*\bname=["']_DW_TASK_ID["'])[^>]*>[\s\S]*?<\/definedName>/g,''));bytes=Buffer.from(zipSync(wb.entries,{level:6}));if(parseRequirement(bytes,filename).workbookTaskId)throw Error('旧编号清理失败，未上传');}
 const dest=await guarded(this.settings.root,STAGES[0],filename),temp=await guarded(this.settings.root,STAGES[0],'.operator-'+crypto.randomUUID()+'.tmp');try{await fs.writeFile(temp,bytes,{flag:'wx'});await fs.copyFile(temp,dest,require('node:fs').constants.COPYFILE_EXCL)}finally{await fs.unlink(temp).catch(()=>{})}return this.scan()}
 async approve(id,date,time,ratings){const {t,file,bytes}=await this.own(id,[3]);const ratedBytes=patchRatings(bytes,t.items,ratings);if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^([01]\d|2[0-3]):00$/.test(time))throw Error('请填写确认日期和整点时段（例如 14:00）');const when=Date.parse(date+'T'+time+':00+08:00');if(!Number.isFinite(when)||when<(t.templateTimes.reviewAt||t.requestedAt)||when>Date.now()+60000)throw Error('确认时间不能早于提交确认，也不能晚于当前时间');const locks=[],lockPaths=[path.join(path.dirname(file),'~$'+t.filename),path.join(this.settings.root,STAGES[4],'~$'+t.filename)];const dest=await guarded(this.settings.root,STAGES[4],t.filename);let copied=false;
 for(const original of [file,dest])if(await hasWorkbookLock(original,this.settings.root))throw Error('检测到 Excel 占用记录，请保存并关闭后重试');
 try{for(const l of lockPaths){await guarded(this.settings.root,path.relative(this.settings.root,l));const h=await fs.open(l,'wx');locks.push({h,l})}if(hash(await fs.readFile(file))!==hash(bytes))throw Error('原表已变化，请刷新');try{await fs.access(dest);throw Error('已完结目录存在同名需求，未覆盖')}catch(e){if(e.code!=='ENOENT')throw e}
 const backup=path.join(this.dir,'backups');await fs.mkdir(backup,{recursive:true});const record=path.join(backup,Date.now()+'-'+t.filename);await fs.writeFile(record,bytes);const excelDate=(Date.parse(date+'T00:00:00Z')-Date.UTC(1899,11,30))/86400000,hour=Number(time.slice(0,2));const output=patchWorkbook(ratedBytes,{M4:excelDate,N4:hour});const target=await fs.open(dest,'wx');copied=true;try{await target.writeFile(output);await target.sync()}finally{await target.close()}if(hash(await fs.readFile(dest))!==hash(output)||hash(await fs.readFile(file))!==hash(bytes))throw Error('写入校验失败，原需求已保留');await fs.unlink(file);copied=false;await fs.appendFile(path.join(this.dir,'actions.jsonl'),JSON.stringify({at:Date.now(),operator:this.settings.name,action:'approve',source:file,destination:dest,backup:record})+'\n');
 }catch(e){if(copied)await fs.unlink(dest).catch(()=>{});if(e.code==='EEXIST')throw Error('Excel 正在编辑或另一端正在操作，请保存并关闭后重试');throw e}finally{for(const {h,l}of locks){await h.close();await fs.unlink(l).catch(()=>{})}}this.cache.clear();return this.scan()}
}
module.exports={OperatorStore};
