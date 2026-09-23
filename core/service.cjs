'use strict';
const fs=require('node:fs');const fsp=fs.promises;const path=require('node:path');const https=require('node:https');const crypto=require('node:crypto');const {EventEmitter}=require('node:events');
const selfsigned=require('selfsigned');const {Store,digest}=require('./store.cjs');const {Nas,exists,guarded}=require('./nas.cjs');const {Assets,archiveSpec}=require('./assets.cjs');const {parseRequirement,patchWorkbook,workflowFields,workbookTaskId,identifyWorkbook}=require('./workbook.cjs');
const {RequirementsSync,reconcileTask,itemsIdentity}=require('./requirements-sync.cjs');
const {Products}=require('./products.cjs');
const R=require('./rules.cjs');
const requestIdentity=task=>JSON.stringify([task.requestedAt,task.code,R.normalize(task.product)]);
class Service extends EventEmitter{
 constructor(dir,{identity=null,saveIdentity=null,host='0.0.0.0',port=47831}={}){
  super();this.store=new Store(dir);this.nas=new Nas(this.store);this.products=new Products(this.store,this.nas);this.assets=new Assets(this.store,this.nas,this.products);this.identity=identity;this.saveIdentity=saveIdentity;this.host=host;this.port=port;this.streams=new Map();this.drafts=new Map();this.rateLimits=new Map();this.startError=null;
 }
 async start(){
  if(!this.identity){const generated=await selfsigned.generate([{name:'commonName',value:'design-workbench.local'}],{keySize:2048,algorithm:'sha256',notAfterDate:new Date(Date.now()+5*365*86400000),extensions:[{name:'basicConstraints',cA:true},{name:'keyUsage',keyCertSign:true,digitalSignature:true,keyEncipherment:true},{name:'extKeyUsage',serverAuth:true},{name:'subjectAltName',altNames:[{type:2,value:'design-workbench.local'}]}]});this.identity={key:generated.private,cert:generated.cert};if(this.saveIdentity)await this.saveIdentity(this.identity)}
  this.server=https.createServer({key:this.identity.key,cert:this.identity.cert,minVersion:'TLSv1.2'},(req,res)=>this.route(req,res).catch(e=>{if(!res.headersSent)this.json(res,{error:e.message},e.status||500);else res.destroy()}));
  this.server.requestTimeout=30*60*1000;this.server.headersTimeout=20000;
  await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,this.host,resolve)});this.port=this.server.address().port;
  this.migrateContributionStandard();
   if(this.store.get('setting','nas')){try{await this.ensureNasConnection(true);const issues=this.store.get('setting','importIssues')||[];if(issues.length)await this.scanExisting()}catch{}}
  this.requirementsSync=new RequirementsSync(this);this.on('sync-status',status=>{for(const stream of this.streams.values())stream.res.write('data: '+JSON.stringify({kind:'sync-status',status})+'\n\n')});this.requirementsSync.start();this.archiveRetryTimer=setInterval(()=>{if(this.archiveRetryRunning||!this.nas.lease)return;this.archiveRetryRunning=this.store.exclusive(async()=>{await this.nas.recover();await this.assets.recover();const count=await this.assets.retryPending();if(count)this.broadcast()}).catch(()=>{}).finally(()=>{this.archiveRetryRunning=null})},30000);this.archiveRetryTimer.unref();return this;
 }
 async ensureNasConnection(force=false){
  if(this.connecting)return this.connecting;
  if(!force&&Date.now()<(this.retryAt||0))throw Error(this.startError||'NAS 正在等待重试');
  this.connecting=this.store.exclusive(async()=>{
   const config=this.nas.config||this.store.get('setting','nas');if(!config)R.fail('尚未连接 NAS，请在连接与维护中设置目录');
   try{
    if(this.nas.lease){try{await this.nas.heartbeat()}catch(e){if(e.code!=='LEASE_LOST'&&e.code!=='ENOENT')throw e;await this.nas.release()}}
    if(!this.nas.lease){await this.nas.connect(config);await this.nas.recover();await this.assets.recover();await this.products.sync()}
    await this.nas.ready();this.startError=null;this.retryAt=0;this.connectFailures=0;
   }catch(e){this.startError=e.message;this.connectFailures=(this.connectFailures||0)+1;this.retryAt=Date.now()+Math.min(60000,5000*2**Math.min(this.connectFailures-1,4));throw e}
  }).finally(()=>{this.connecting=null});return this.connecting;
 }
 migrateContributionStandard(){
  if((this.store.get('setting','contributionStandard')?.version||0)>=2)return 0;
  const converted=new Set(['main-set','sku-set','sku-full','main-full']);let changed=0;
  this.store.atomic(()=>{
   for(const task of this.store.all('task')){
    const next=structuredClone(task),before=next.items.reduce((sum,item)=>sum+(item.points||0),0);let touched=false;
    for(const item of next.items||[]){
     if(converted.has(item.type)&&item.extra){item.extra=0;touched=true}
     const points=R.itemPoints(item);if(points!==item.points){item.points=points;touched=true}
    }
    if(!touched)continue;
    const after=next.items.reduce((sum,item)=>sum+(item.points||0),0);next.version=(next.version||0)+1;next.updatedAt=Date.now();
    this.store.put('task',next.id,next);this.store.event('contribution-standard-updated','system',next.id,{before,after});changed++;
   }
   this.store.put('setting','contributionStandard',{version:2,at:Date.now(),units:'individual'});
  });return changed;
 }
 json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))}
 async body(req,limit=1024*1024){let size=0;const chunks=[];for await(const b of req){size+=b.length;if(size>limit)R.fail('请求过大',413);chunks.push(b)}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{R.fail('请求格式无效')}}
 authenticate(req){const token=req.headers.authorization?.match(/^Bearer ([a-zA-Z0-9_-]{43})$/)?.[1];const record=token&&this.store.get('token',digest(token));if(!record||record.revoked||this.store.get('removedMember',record.personId))R.fail('连接已失效，请向负责人索取新的连接码',401);return {role:record.role==='manager'?'manager':'designer',personId:record.personId,tokenHash:digest(token)}}
 async route(req,res){
  if(req.headers.origin)R.fail('仅支持已绑定的桌面客户端',403);
  const url=new URL(req.url,'https://design-workbench.local');
  if(req.method==='POST'&&url.pathname==='/pair'){
   const key=req.socket.remoteAddress,rate=this.rateLimits.get(key)||{at:Date.now(),count:0};if(Date.now()-rate.at>60000){rate.at=Date.now();rate.count=0}if(++rate.count>20)R.fail('尝试次数过多，请稍后再试',429);this.rateLimits.set(key,rate);
   const body=await this.body(req,10000);if(typeof body.secret!=='string')R.fail('连接码无效',401);
   const pairing=this.store.get('pair',digest(body.secret));if(!pairing||pairing.used||pairing.expires<Date.now()||this.store.get('removedMember',pairing.personId))R.fail('连接码无效或已过期，请重新生成',401);
   const token=crypto.randomBytes(32).toString('base64url');
   this.store.atomic(()=>{this.store.put('pair',digest(body.secret),{...pairing,used:true});this.store.put('token',digest(token),{personId:pairing.personId,createdAt:Date.now(),revoked:false,role:pairing.role||'designer'});this.store.event('paired',pairing.personId,null)});
   this.broadcast();return this.json(res,{token,role:pairing.role||'designer',person:R.PEOPLE.find(p=>p.id===pairing.personId)});
  }
  const actor=this.authenticate(req);
  if(req.method==='GET'&&url.pathname==='/events'){
   res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive'});res.write('data: {"kind":"connected"}\n\n');
   const id=crypto.randomUUID();this.streams.set(id,{res,actor});this.emit('presence');const heartbeat=setInterval(()=>res.write(': heartbeat\n\n'),15000);
   req.on('close',()=>{clearInterval(heartbeat);this.streams.delete(id);this.emit('presence')});return;
  }
  if(req.method==='POST'&&url.pathname==='/rpc'){
   const body=await this.body(req,actor.role==='manager'?70*1024*1024:1024*1024);const result=await this.call(actor,body.command,body.payload||{},body.requestId);return this.json(res,result);
  }
  const upload=url.pathname.match(/^\/upload\/([a-f0-9-]{36})\/(\d{1,3})$/);
  if(req.method==='PUT'&&upload){const result=await this.assets.receive(upload[1],upload[2],actor,req,req.headers['content-length']);return this.json(res,result)}
  const requirement=url.pathname.match(/^\/requirement\/([a-f0-9-]{36})$/);
  if(req.method==='GET'&&requirement){
   const task=this.store.get('task',requirement[1]);if(!task)R.fail('任务不存在',404);R.own(actor,task);
   const bytes=await this.nas.readTask(task);res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Length':bytes.length,'Cache-Control':'no-store'});res.end(bytes);return;
  }
  R.fail('接口不存在',404);
 }
 online(personId){return [...this.streams.values()].some(s=>s.actor.personId===personId)}
 broadcast(){for(const stream of this.streams.values())stream.res.write('data: {"kind":"changed"}\n\n');this.emit('change')}
 snapshot(actor){
  const tasks=this.store.all('task').filter(t=>!(t.state<4&&!t.sealed&&t.workbookSyncIssue?.message==='五个状态文件夹内未找到原需求表，请检查是否被移动或改名')).filter(t=>actor.role==='manager'||t.owner===actor.personId&&t.state>0).sort((a,b)=>(a.state===0?0:1)-(b.state===0?0:1)||(b.updatedAt-a.updatedAt));
  const nasStatus={connected:!!this.nas.lease&&!this.nas.error&&!this.startError,error:this.startError||this.nas.error};
  return {role:actor.role,person:R.PEOPLE.find(p=>p.id===actor.personId),serverTime:Date.now(),tasks,people:actor.role==='manager'?R.PEOPLE.map(p=>({...p,removed:!!this.store.get('removedMember',p.id),online:this.online(p.id),paired:this.store.all('token').some(t=>t.personId===p.id&&!t.revoked)})):[],rates:R.RATES,categories:R.CATEGORIES,monthlyCapacity:139.2,nasStatus,workbookSync:this.requirementsSync?.status,workbookSyncVersion:1,
   ...(actor.role==='manager'?{config:this.nas.config||this.store.get('setting','nas'),port:this.port,jobs:this.store.all('job').filter(j=>j.status==='prepared').map(j=>({id:j.id,taskId:j.next?.id,error:j.error||'等待恢复'})),importIssues:this.store.get('setting','importIssues')||[],events:this.store.recent(30)}:{})};
 }
 async importFile(bytes,filename,options={},state=0,existing=false){
  // Asset category belongs to the final delivery folder, not to requirement intake.
  // A requirement can contain generic contribution items and several asset types.
  const parsed=parseRequirement(bytes,filename,options);
  if(parsed.workbookTaskId&&this.store.get('task',parsed.workbookTaskId))R.fail('这份表的任务编号已存在，可能是复制的原需求；请保留唯一原表，新需求请使用空白模板',409);
  if(parsed.workbookTaskId)parsed.id=parsed.workbookTaskId;
  for(const item of parsed.items)item.category=null;
  if(this.store.all('task').some(t=>t.originalHash===parsed.sourceHash||t.filename===filename))R.fail('此需求已经导入，未重复创建',409);
  await this.nas.ready();const now=Date.now();let owner=state>0?R.PEOPLE.find(p=>p.name===parsed.requestedDesigner)?.id:null;
  if(state>0&&!owner)R.fail('已分配目录内的需求表需要填写设计师');
  const task={...parsed,originalHash:parsed.sourceHash,workbookHash:parsed.sourceHash,state,owner,version:1,createdAt:now,updatedAt:now,elapsedMs:0,runningSince:null,startedAt:null,sealed:false,assignedAt:owner?now:null,assignmentId:owner?crypto.randomUUID():null,receivedAt:null,readAt:null};
  // Imported running work is paused until its designer explicitly resumes;
  // previous elapsed time cannot be inferred from hour-only workbook fields.
  if(existing){task.assignedAt=parsed.templateTimes.assignedAt||task.assignedAt;task.startedAt=parsed.templateTimes.startedAt}
  if(state===2){task.pauseReason='导入后待恢复计时';task.importedTiming=true}
  if(state===3){task.reviewAt=parsed.templateTimes.reviewAt||now;task.importedTiming=true}
  if(state===4){
   task.completedAt=parsed.templateTimes.completedAt||parsed.templateTimes.reviewAt||(existing&&Number.isFinite(options.observedAt)?options.observedAt:null);
   if(!task.completedAt)R.fail('历史已完结需求缺少确认时间，且无法从设计完成时间或文件时间确定归档日期');
   task.completionFromFolder=!parsed.templateTimes.completedAt;task.completedMonth=R.monthKey(task.completedAt);task.importedTiming=true;
   task.completionTimeSource=parsed.templateTimes.completedAt?'workbook-confirmed':parsed.templateTimes.reviewAt?'review-estimate':'file-estimate';
  }
  task.workbookTaskId=task.id;
  const dest=await guarded(this.nas.config.taskRoot,R.STAGES[state],filename);
  if(existing)return this.nas.sync({...task,workbookHash:parsed.sourceHash},task,{}, {kind:'imported-existing',actor:'zeng',body:{filename}});
  if(!existing){bytes=identifyWorkbook(patchWorkbook(bytes,{E4:'',F4:'',H4:'',I4:'',J4:'',K4:'',L4:'',M4:'',N4:''}),task.id);task.workbookHash=digest(bytes);await fsp.writeFile(dest,bytes,{flag:'wx'});if(await require('./nas.cjs').fileHash(dest)!==task.workbookHash)R.fail('需求表写入校验失败')}
  task.workflowFields=workflowFields(bytes);
  this.store.atomic(()=>{this.store.put('task',task.id,task);this.store.event(existing?'imported-existing':'requirement-created','zeng',task.id,{filename})});return task;
 }
 async inspectDuplicate(actor,taskId){
  R.manager(actor);await this.nas.ready();const duplicate=this.store.get('task',taskId);if(!duplicate)R.fail('任务不存在');
  const locations=[];for(const stage of R.STAGES)for(const filename of await fsp.readdir(path.join(this.nas.config.taskRoot,stage)))if(filename===duplicate.filename)locations.push(path.join(this.nas.config.taskRoot,stage,filename));
  if(locations.length!==1)R.fail('必须先保留唯一的 NAS 原需求表');const file=locations[0];if(await exists(path.join(path.dirname(file),'~$'+path.basename(file))))R.fail('请保存并关闭 Excel 后再修复');
  const bytes=await fsp.readFile(file),id=workbookTaskId(bytes),keep=this.store.get('task',id);
  if(!keep||id===taskId)R.fail('这条记录与原表匹配，不能作为重复项移除；请从异常卡片进入');
  const signature=t=>JSON.stringify(t.items.map(i=>[i.row,i.type,i.qty,i.extra||0,i.points]));
  if(keep.filename!==duplicate.filename||keep.state!==duplicate.state||keep.owner!==duplicate.owner||requestIdentity(keep)!==requestIdentity(duplicate)||signature(keep)!==signature(duplicate))R.fail('两条任务内容或状态不同，无法安全合并');
  if([keep,duplicate].some(t=>t.blocked||t.sealed||t.runningSince||t.items.some(i=>i.sealed)))R.fail('任务正在处理或已有封存记录，不能清理');
  const ids=[keep.id,duplicate.id];if(this.store.all('asset').some(a=>ids.includes(a.taskId))||this.store.all('upload').some(a=>ids.includes(a.taskId))||this.store.all('job').some(j=>j.status==='prepared'&&ids.includes(j.next?.id)))R.fail('任务存在资产或上传操作，不能清理');
  return {keep,duplicate,file,hash:digest(bytes)};
 }
 async repairDuplicate(actor,payload){
  const plan=await this.inspectDuplicate(actor,payload.taskId);
  if(payload.keepId!==plan.keep.id||payload.version!==plan.duplicate.version||payload.keepVersion!==plan.keep.version||payload.hash!==plan.hash)R.fail('核对后任务或原表已变化，请重新检查');
  const folder=path.join(this.store.dir,'duplicate-backups');await fsp.mkdir(folder,{recursive:true});const backupPath=path.join(folder,'before-'+Date.now()+'-'+plan.duplicate.id+'.sqlite');await require('node:sqlite').backup(this.store.db,backupPath);
  if(digest(await fsp.readFile(plan.file))!==plan.hash)R.fail('原需求表已变化，请重新检查');
  this.store.atomic(()=>{this.store.put('duplicateArchive',plan.duplicate.id,{task:plan.duplicate,events:this.store.events(plan.duplicate.id,100000),keptTaskId:plan.keep.id,archivedAt:Date.now(),backupPath});this.store.remove('task',plan.duplicate.id);this.store.event('duplicate-record-repaired',actor.personId,plan.keep.id,{removedTaskId:plan.duplicate.id,backupPath,preservedHistory:true})});
  return {keptTaskId:plan.keep.id,backupPath};
 }
 async repairRenamedDuplicates({includeCompleted=true}={}){
  const tasks=this.store.all('task').filter(t=>includeCompleted||t.state!==4),live=new Map();let repaired=0;
  for(const task of tasks){try{live.set(task.id,await exists(this.nas.taskPath(task)))}catch{live.set(task.id,false)}}
  for(const missing of tasks){
   if(!/未找到原需求表/.test(missing.workbookSyncIssue?.message||'')||live.get(missing.id)||missing.sealed||missing.items.some(item=>item.sealed))continue;
   const candidates=tasks.filter(other=>other.id!==missing.id&&live.get(other.id)&&!other.sealed&&!other.items.some(item=>item.sealed)&&other.owner===missing.owner&&requestIdentity(other)===requestIdentity(missing)&&itemsIdentity(other.items)===itemsIdentity(missing.items));
   if(candidates.length!==1)continue;const current=candidates[0];
   // Legacy guesses are not proof. Merge only when the saved workbook identifies the original.
   if(workbookTaskId(await fsp.readFile(this.nas.taskPath(current)))!==missing.id)continue;
   if(this.store.all('upload').some(u=>u.taskId===current.id)||this.store.all('asset').some(a=>a.taskId===current.id)||this.store.all('job').some(j=>j.status==='prepared'&&j.next?.id===current.id))continue;
   const merged={...current,id:missing.id,createdAt:Math.min(missing.createdAt||Date.now(),current.createdAt||Date.now()),version:Math.max(missing.version||0,current.version||0)+1,updatedAt:Date.now(),workbookSyncIssue:null,previousOriginalHash:missing.originalHash};
   for(const key of ['assignmentId','assignedAt','receivedAt','readAt','elapsedMs','startedAt','reviewAt','completedAt','runningSince','pauseReason','importedTiming','externalTiming'])if(missing[key]!==undefined&&missing[key]!==null)merged[key]=missing[key];
   this.store.atomic(()=>{this.store.db.prepare('UPDATE events SET taskId=? WHERE taskId=?').run(missing.id,current.id);this.store.remove('task',current.id);this.store.put('task',missing.id,merged);this.store.event('renamed-duplicate-repaired','system',missing.id,{removedTaskId:current.id,from:missing.filename,to:current.filename})});
   live.delete(current.id);live.set(missing.id,true);repaired++;
  }
  return repaired;
 }
 scanExisting(options={}){
  if(this.scanExistingPromise)return this.scanExistingPromise;
  this.scanExistingPromise=this.runScanExisting(options).finally(()=>{this.scanExistingPromise=null});return this.scanExistingPromise;
 }
 async runScanExisting({includeCompleted=true}={}){
  await this.nas.ready();const scanRoot=this.nas.config.taskRoot;includeCompleted=includeCompleted||this.store.get('setting','requirementsInitialScan')?.root!==scanRoot;const repaired=await this.repairRenamedDuplicates({includeCompleted}),issues=includeCompleted?[]:(this.store.get('setting','importIssues')||[]).filter(i=>i.stage===R.STAGES[4]);let count=0,relinked=0;const known=new Set(this.store.all('task').map(t=>t.filename));
  for(let state=0;state<R.STAGES.length;state++){
   if(state===4&&!includeCompleted)continue;
   const dir=await guarded(this.nas.config.taskRoot,R.STAGES[state]),files=await fsp.readdir(dir,{withFileTypes:true});
   for(const f of files){
    if(!f.isFile()||f.name.startsWith('~$')||f.name.startsWith('.')||/^命名和状态模板[：:]/.test(f.name))continue;
    if(f.name.toLowerCase().endsWith('.xls')){issues.push({filename:f.name,stage:R.STAGES[state],error:'文件是旧版 .xls 格式，请在 Excel 中另存为 .xlsx 后再导入',details:['文件是旧版 .xls 格式，请在 Excel 中另存为 .xlsx 后再导入']});continue}
    if(!f.name.toLowerCase().endsWith('.xlsx')||known.has(f.name))continue;
    try{
     const file=await guarded(this.nas.config.taskRoot,R.STAGES[state],f.name),stat=await fsp.stat(file);if(stat.size>50*1024*1024)R.fail('需求表超过 50 MB');const bytes=await fsp.readFile(file),initial=parseRequirement(bytes,f.name);
     if(await exists(path.join(dir,'~$'+f.name)))R.fail('Excel 正在编辑原表，请保存并关闭后自动重试');
     const after=await fsp.stat(file);if(after.size!==stat.size||after.mtimeMs!==stat.mtimeMs)R.fail('需求表正在保存，稍后自动重试');
     const missing=[];
     if(initial.workbookTaskId){const linked=this.store.get('task',initial.workbookTaskId);if(linked){if(await exists(this.nas.taskPath(linked)))R.fail('多个文件使用同一个任务编号，请保留唯一原需求；复制提新需求请使用空白模板');missing.push(linked)}}
     else for(const task of this.store.all('task'))if(requestIdentity(task)===requestIdentity(initial)&&!await exists(this.nas.taskPath(task))){
      if(task.workbookHash===initial.sourceHash)missing.push(task);
      else R.fail('旧表已改名且内容变化，缺少固定编号，无法确认是否为原任务；请恢复原文件名后同步，再改名');
     }
     if(missing.length>1)R.fail('找到多个可能的原任务，无法安全关联改名后的需求表，请负责人核对重复任务');
     if(missing.length===1){
      const old=missing[0],categories=Object.fromEntries(old.items.map(item=>[item.row,item.category])),extras=Object.fromEntries(old.items.map(item=>[item.row,item.extra||0])),parsed=parseRequirement(bytes,f.name,{categories,extras}),fields=workflowFields(bytes),next=reconcileTask(old,parsed,fields,{state,stage:R.STAGES[state],filename:f.name});
      this.store.atomic(()=>{this.store.put('task',old.id,next);this.store.event('requirement-renamed','nas',old.id,{from:old.filename,to:f.name,fromState:old.state,toState:next.state})});known.add(f.name);relinked++;
     }else{await this.importFile(bytes,f.name,{observedAt:stat.mtimeMs},state,true);known.add(f.name);count++}
    }catch(e){issues.push({filename:f.name,stage:R.STAGES[state],error:e.reasons?.join('；')||e.message,details:e.reasons||[]})}
   }
  }
  if(includeCompleted)this.store.put('setting','requirementsInitialScan',{root:scanRoot,at:Date.now()});
  const before=this.store.get('setting','importIssues')||[];if(JSON.stringify(before)!==JSON.stringify(issues))this.store.put('setting','importIssues',issues);return {imported:count,relinked,repaired,issues};
 }
 async call(actor,command,payload={},requestId=null){
  if(actor.role==='designer'&&this.store.get('removedMember',actor.personId))R.fail('你已被移出组织',403);
  if(!['manager','designer'].includes(actor.role)||!R.PEOPLE.some(p=>p.id===actor.personId))R.fail('无效账号',403);
  if(actor.tokenHash&&['configure','manager-pair-code','manager-revoke'].includes(command))R.fail('请在负责人主机上执行此操作',403);
  if(command==='report-data'){R.manager(actor);const {periodRange}=require('./report.cjs'),range=periodRange(payload.frequency,payload.anchor),generatedAt=Date.now(),history=this.store.reportTasks(Math.min(generatedAt,range.end-1));return {tasks:history.tasks,events:this.store.reportEvents(range.start,Math.min(range.end,generatedAt+1)),generatedAt,unavailable:history.unavailable}}
  if(command==='snapshot')return this.snapshot(actor);
  if(command==='product-groups'&&!payload.force&&this.products.indexReady()){R.manager(actor);return this.products.all()}
  if(command==='sync-requirements'){if(payload.includeCompleted)R.manager(actor);return this.requirementsSync.check(true,{includeCompleted:!!payload.includeCompleted})}
  if(command==='requirement-location'){
   await this.requirementsSync.check();const task=this.store.get('task',payload.taskId);if(!task)R.fail('任务不存在',404);if(actor.role!=='manager')R.own(actor,task);
   const file=await guarded(this.nas.config.taskRoot,R.STAGES[task.state],task.filename);
   if(!await exists(file))R.fail(task.workbookSyncIssue?.message||'NAS 原需求表未找到，请先同步任务');
   return {path:file,taskId:task.id,assignmentId:task.assignmentId};
  }
  if(command==='task-asset-location'){
   const task=this.store.get('task',payload.taskId);if(!task)R.fail('任务不存在',404);if(actor.role!=='manager')R.own(actor,task);
   if(task.state!==4||(!task.sealed&&!(task.deliveries||[]).length))R.fail('任务尚未上传成功任何产物');
   const product=await this.nas.productDirectory({brand:task.brand,product:task.product,code:task.code},false);if(product.isNew||!await exists(product.path))R.fail('未找到该69码的封存产品目录，请检查 NAS');return {path:product.path,taskId:task.id};
  }
  if(command==='history'){const t=this.store.get('task',payload.taskId);if(!t)R.fail('任务不存在',404);if(actor.role!=='manager')R.own(actor,t);return this.store.events(t.id)}
  if(command==='assets'){
   if(this.nas?.lease&&!payload.recordsOnly&&(payload.force||!this.products.indexReady()))await this.store.exclusive(()=>this.products.sync({force:!!payload.force}));
   const groups=this.products.all(),records=this.store.all('asset').filter(a=>!a.missingAt&&(!payload.mine||a.author===actor.personId)).map(({files,...a})=>({...a,requirement:(()=>{const t=this.store.get('task',a.taskId);return t?{title:t.title||t.product,filename:t.filename,state:t.state,canOpen:actor.role==='manager'||t.owner===actor.personId}:null})(),authorName:R.PEOPLE.find(p=>p.id===a.author)?.name||'人员未知',files:(files||[]).map(f=>({name:f.name,path:f.path,size:f.size,kind:f.kind})),aliases:groups.filter(g=>g.variants.some(v=>v.code===a.code)).flatMap(g=>[g.canonicalName,...g.aliases])}));
   if(!payload.mine)for(const group of groups)for(const variant of group.variants)if(variant.path&&!records.some(a=>a.code===variant.code))records.push({id:'product:'+group.id+':'+variant.code,brand:group.brand,product:variant.name,code:variant.code,path:variant.path,aliases:[group.canonicalName,...group.aliases],source:'nas-index',at:null});
   return records;
  }
  // Synchronize saved edits before acquiring the mutation lock; retain version checks.
  let codeCorrection=null;
  if(command==='action'){
   const task=this.store.get('task',payload.taskId);if(!task)R.fail('任务不存在',404);
   if(payload.action==='rollback')R.manager(actor);
   if(actor.role!=='manager')R.own(actor,task);
   if(payload.action==='rollback'){
    if(!task.sealed){const checked=await this.requirementsSync.checkTask(task.id,{acceptCodeCorrection:payload.confirmed===true&&payload.acceptCodeCorrection===true});if(!checked.checked)R.fail(checked.error||'当前需求表尚未检查完成',409);codeCorrection=checked.codeCorrection}
   }else await this.requirementsSync.check(true,{includeCompleted:task.state===4});
  }
  return this.store.exclusive(async()=>{
   if(actor.role==='designer'&&this.store.get('removedMember',actor.personId))R.fail('你已被移出组织',403);
   if(actor.tokenHash&&this.store.get('token',actor.tokenHash)?.revoked)R.fail('连接已失效',401);
   const cacheId=requestId&&command!=='pair-code'&&actor.role+':'+actor.personId+':'+requestId;
   if(requestId&&!/^[a-f0-9-]{36}$/.test(requestId))R.fail('请求编号无效');
   const previous=cacheId&&this.store.get('request',cacheId);if(previous)return previous.result;
   let result;
    if(command==='calibrate-contribution'){
     result=await require('./contribution-calibration.cjs').calibrateContribution(this,actor,payload);
   }else if(command==='configure'){
     R.manager(actor);await this.nas.connect(payload);await this.nas.recover();await this.assets.recover();await this.products.sync();this.startError=null;this.retryAt=0;this.connectFailures=0;result={connected:true};
   }else if(command==='manager-revoke'){
    R.manager(actor);this.store.atomic(()=>{for(const row of this.store.db.prepare("SELECT id,body FROM records WHERE kind='token'").all()){const v=JSON.parse(row.body);if(v.role==='manager')this.store.put('token',row.id,{...v,revoked:true})}for(const row of this.store.db.prepare("SELECT id,body FROM records WHERE kind='pair'").all()){const v=JSON.parse(row.body);if(v.role==='manager')this.store.put('pair',row.id,{...v,used:true})}this.store.event('manager-access-revoked',actor.personId,null,{})});for(const [id,stream]of this.streams)if(stream.actor.role==='manager'){this.streams.delete(id);stream.res.end()}result={revoked:true};
   }else if(command==='manager-pair-code'){
    R.manager(actor);if(typeof payload.host!=='string'||!/^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/.test(payload.host)||payload.host.length>253)R.fail('连接地址无效');const secret=crypto.randomBytes(32).toString('base64url'),expires=Date.now()+3600000;this.store.put('pair',digest(secret),{personId:actor.personId,role:'manager',expires,used:false});result={code:'DW1.'+Buffer.from(JSON.stringify({host:payload.host,port:this.port,cert:this.identity.cert,secret})).toString('base64url'),expires};
   }else if(command==='pair-code'){
    R.manager(actor);if(!R.PEOPLE.some(p=>p.id===payload.personId)||this.store.get('removedMember',payload.personId))R.fail('人员不存在或已移出组织');
    if(typeof payload.host!=='string'||!/^([a-zA-Z0-9-]+\.)*[a-zA-Z0-9-]+$/.test(payload.host)||payload.host.length>253)R.fail('连接地址无效');
    const secret=crypto.randomBytes(32).toString('base64url'),expires=Date.now()+60*60000;
    this.store.put('pair',digest(secret),{personId:payload.personId,expires,used:false});
    const code='DW1.'+Buffer.from(JSON.stringify({host:payload.host,port:this.port,cert:this.identity.cert,secret,personId:payload.personId})).toString('base64url');result={code,expires};
    }else if(command==='member-remove'){
    R.manager(actor);const person=R.PEOPLE.find(p=>p.id===payload.personId);if(!person||person.id===actor.personId||person.title!=='设计师')R.fail('不能移除此成员');
    if(this.store.all('task').some(t=>t.owner===person.id&&t.state>0&&(t.state<4||!t.sealed)))R.fail('该成员还有未完成或待封存任务，请先改派或完成封存',409);
    if(this.store.all('upload').some(u=>u.actor===person.id&&['uploading','publishing'].includes(u.status)))R.fail('该成员还有上传待处理，请先处理完毕',409);
    this.store.atomic(()=>{this.store.put('removedMember',person.id,{at:Date.now(),by:actor.personId});for(const kind of ['token','pair'])for(const row of this.store.db.prepare('SELECT id,body FROM records WHERE kind=?').all(kind)){const v=JSON.parse(row.body);if(v.personId===person.id)this.store.put(kind,row.id,{...v,revoked:true,used:true})}this.store.event('member-removed',actor.personId,null,{personId:person.id,name:person.name})});
    for(const [id,stream] of this.streams)if(stream.actor.personId===person.id){this.streams.delete(id);stream.res.end()}result={removed:true};
   }else if(command==='revoke'){
    R.manager(actor);for(const token of this.store.db.prepare("SELECT id,body FROM records WHERE kind='token'").all()){const t=JSON.parse(token.body);if(t.personId===payload.personId)this.store.put('token',token.id,{...t,revoked:true})}
    for(const pairing of this.store.db.prepare("SELECT id,body FROM records WHERE kind='pair'").all()){const p=JSON.parse(pairing.body);if(p.personId===payload.personId)this.store.put('pair',pairing.id,{...p,used:true})}
    for(const stream of this.streams.values())if(stream.actor.personId===payload.personId)stream.res.end();
    this.store.event('device-revoked',actor.personId,null,{personId:payload.personId});result={revoked:true};
   }else if(command==='draft'){
    R.manager(actor);if(payload.bytesBase64){if(typeof payload.bytesBase64!=='string'||payload.bytesBase64.length>70000000)R.fail('需求表过大');payload.bytes=Buffer.from(payload.bytesBase64,'base64')}if(!Buffer.isBuffer(payload.bytes))R.fail('请选择需求表');
    const parsed=parseRequirement(payload.bytes,payload.filename);const id=crypto.randomUUID();
    this.drafts.clear();this.drafts.set(id,{bytes:payload.bytes,filename:payload.filename,at:Date.now()});result={id,filename:payload.filename,items:parsed.items};
   }else if(command==='import'){
    R.manager(actor);const draft=this.drafts.get(payload.draftId);if(!draft||Date.now()-draft.at>30*60000)R.fail('请重新选择需求表');
    result=await this.importFile(draft.bytes,draft.filename,{categories:payload.categories,extras:payload.extras});this.drafts.delete(payload.draftId);
   }else if(command==='scan'){
    R.manager(actor);result=await this.scanExisting();
   }else if(command==='action'){
    const old=this.store.get('task',payload.taskId);if(!old)R.fail('任务不存在',404);
    if(payload.action==='assign'&&this.store.get('removedMember',payload.owner))R.fail('该成员已移出组织，不能分配任务');
    if(payload.action==='rollback'){
     if(codeCorrection&&(old.version!==codeCorrection.version||old.workbookHash!==codeCorrection.previousHash||old.code!==codeCorrection.from))R.fail('任务已更新，请刷新后重新核对69码',409);
     if(!old.sealed&&old.workbookSyncIssue&&!codeCorrection)R.fail('请先处理原表异常后回退：'+old.workbookSyncIssue.message,409);
     const uploads=this.store.all('upload').filter(u=>u.taskId===old.id&&(u.archiveRound||0)===(old.archiveRound||0));
     if(uploads.some(u=>u.status==='publishing'||[...this.assets.inflight].some(k=>k.startsWith(u.id+'/'))))R.fail('产物正在写入或传输，请等待完成或恢复后再回退',409);
    }
    const next=R.transition(old,actor,payload.action,payload);
    if(codeCorrection){next.task.code=codeCorrection.to;for(const item of next.task.items)item.code=codeCorrection.to;next.task.workbookSyncIssue=null}
    if(payload.action==='rollback'&&next.task.state===0)next.task.filename=R.stamp(old.requestedAt)+'-'+old.brand+'-'+(old.title||old.product)+'-'+old.operator+'-未分配.xlsx';
    if(payload.action==='assign')next.task.filename=R.stamp(old.requestedAt)+'-'+old.brand+'-'+(old.title||old.product)+'-'+old.operator+'-'+R.PEOPLE.find(p=>p.id===next.task.owner).name+'.xlsx';
    const event={kind:payload.action,actor:actor.personId,body:{from:old.state,to:next.task.state,owner:next.task.owner,reason:payload.reason||null,...(payload.action==='rollback'?{fromSealed:!!old.sealed,toSealed:!!next.task.sealed,retainedAssetIds:[...(old.deliveries||[]).map(d=>d.id),...old.items.map(i=>i.assetId).filter(Boolean)]}:{})}};
    if(codeCorrection)event.body.codeCorrection={from:codeCorrection.from,to:codeCorrection.to};
    if(next.task.state===old.state&&!Object.keys(next.patch).length){this.store.atomic(()=>{this.store.put('task',old.id,next.task);this.store.event(event.kind,event.actor,old.id,event.body)});result=next.task}
    else result=await this.nas.sync(codeCorrection?{...old,workbookHash:codeCorrection.hash}:old,next.task,next.patch,event);
   }else if(command==='received'||command==='read'){
    const t=this.store.get('task',payload.taskId);if(!t)R.fail('任务不存在',404);R.own(actor,t);
    if(payload.assignmentId!==t.assignmentId)R.fail('分配记录已经变更',409);
    t.receivedAt??=Date.now();if(command==='read')t.readAt??=Date.now();this.store.put('task',t.id,t);result={receivedAt:t.receivedAt,readAt:t.readAt};
    }else if(command==='archive-spec'){
     const original=this.store.get('task',payload.taskId);if(!original)R.fail('任务不存在',404);R.own(actor,original);await this.nas.recover(payload.taskId);await this.assets.recover();await this.assets.retryPending(payload.taskId);
     const t=this.store.get('task',payload.taskId);if(!t)R.fail('任务不存在',404);R.own(actor,t);if(t.state!==4||t.sealed)R.fail('此任务尚不能封存');
     const item=payload.itemId&&t.items.find(i=>i.id===payload.itemId);if(payload.itemId&&!item)R.fail('事项不存在');const assetItem=item||t.items[0];result={namingVersion:2,...archiveSpec(t,item||null,payload.folder),productMatch:await this.products.match(assetItem)};
   }else if(command==='archive-prepare'){
    const t=this.store.get('task',payload.taskId);if(!t)R.fail('任务不存在',404);const u=await this.assets.prepare(t,payload.itemId,actor,payload);result={id:u.id,received:u.received,files:u.files.map(({sha256,...f})=>f),status:u.status};
   }else if(command==='archive-commit'){
    try{result=await this.assets.commit(payload.uploadId,actor)}catch(e){const u=this.store.get('upload',payload.uploadId);if(u?.actor===actor.personId&&u.status==='publishing'&&/Excel|占用|EBUSY|EPERM|EACCES|网络|连接|超时/i.test(e.message)){result={pending:true,taskId:u.taskId,uploadId:u.id,reason:'文件已接收，等待归档或回填：'+e.message+'。负责人端每30秒自动重试，无需重传。'}}else throw e}
    }else if(command==='archive-reopen'){
    R.manager(actor);const task=this.store.get('task',payload.taskId);if(!task)R.fail('任务不存在',404);
    if(payload.version!==task.version)R.fail('任务已更新，请刷新后重试',409);
    if(task.state!==4||!task.sealed)R.fail('仅已完成封存的任务可以恢复待封存',409);
    if(task.blocked)R.fail('任务正在同步，请稍后重试',409);
    const next=structuredClone(task);next.sealed=false;delete next.sealedAt;next.updatedAt=Date.now();next.version++;
    this.store.atomic(()=>{this.store.put('task',next.id,next);this.store.event('archive-reopened',actor.personId,next.id,{previousSealedAt:task.sealedAt,retainedDeliveries:(task.deliveries||[]).map(d=>d.id),reason:'负责人恢复待封存，允许继续补传'})});result=next;
   }else if(command==='archive-finish'){
    result=await this.assets.finish(payload.taskId,actor,payload.version);
    }else if(command==='recover'){
     R.manager(actor);await this.nas.heartbeat();this.startError=null;await this.nas.recover();await this.assets.recover();result={recovered:true};
    }else if(command==='duplicate-inspect'){result=await this.inspectDuplicate(actor,payload.taskId);
    }else if(command==='duplicate-repair'){result=await this.repairDuplicate(actor,payload);
    }else if(command==='product-groups'){
       R.manager(actor);result=await this.products.sync({force:!!payload.force});
    }else if(command==='product-group-update'){
     R.manager(actor);result=this.products.update(actor.personId,payload);
    }else if(command==='product-variant-move'){
     R.manager(actor);result=this.products.moveVariant(actor.personId,payload);
   }else if(command==='backup'){
    R.manager(actor);await this.nas.ready();const folder=path.join(this.nas.config.taskRoot,'_workbench-system','database-backups');await fsp.mkdir(folder,{recursive:true});
    const file=path.join(folder,'workbench-'+new Date().toISOString().replace(/[:.]/g,'-')+'.sqlite');
    await require('node:sqlite').backup(this.store.db,file);result={path:file};this.store.event('backup',actor.personId,null);
   }else R.fail('不支持的操作');
   if(cacheId)this.store.put('request',cacheId,{result,at:Date.now()});
   this.broadcast();return result;
  });
 }
 async stop(){clearInterval(this.archiveRetryTimer);await this.archiveRetryRunning;await this.requirementsSync?.stop();for(const stream of this.streams.values())stream.res.end();this.streams.clear();await this.nas.release();if(this.server)await new Promise(resolve=>this.server.close(resolve));this.store.close()}
}
module.exports={Service};
