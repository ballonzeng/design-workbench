'use strict';
(()=>{
const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon=name=>'<i data-lucide="'+name+'" aria-hidden="true"></i>',fmt=n=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n||0);
const states=['待分配','待设计','设计中','待确认','已完结'],stateIcons=['inbox','circle-dot','pen-tool','message-circle','circle-check'];
const TASK_ROOT='\\\\Kyuan_NAS\\任务对接库',ASSET_ROOT='\\\\Kyuan_NAS\\共享产品主图及详情\\00.设计资产库';
let data={role:'manager',tasks:[],people:[],rates:[],categories:[],connection:{online:false},nasStatus:{connected:false}},view='team',filter='all',person=null,query='',assets=[],assetScope='all',productGroups=[],lastInput='keyboard',dialogContext=null,toastTimer,sheetMotion,first=true,clockOffset=0;
const connected=()=>data.connection?.online&&data.nasStatus?.connected,manager=()=>data.role==='manager',now=()=>Date.now()+clockOffset;
let composingSearch=false,assetPeriod='all',assetPerson='',assetDate='';
const flowReminders=new Map();
let uploadJob=null;
let managerConnectionStatus='';
const pageLoads={assets:{busy:false,error:''},products:{busy:false,error:''}};
function drawUpload(){
 let box=$('#background-upload');if(!box){box=document.createElement('aside');box.id='background-upload';box.setAttribute('aria-live','polite');document.body.append(box)}
 if(!uploadJob){box.hidden=true;return}box.hidden=false;const j=uploadJob;
 box.innerHTML='<div class="progress-label"><strong>'+esc(j.status==='running'?'正在后台上传':j.status==='error'?'上传未完成':j.status==='waiting'?'等待自动归档':'上传完成')+'</strong>'+(j.status==='running'?'<span class="spinner"></span>':button('关闭','upload-dismiss'))+'</div><p>'+esc(j.title)+'</p><div class="progress-label"><span>'+esc(j.phase)+'</span><b>'+j.percent+'%</b></div><div class="progress-track"><div style="width:'+j.percent+'%"></div></div><small>'+(j.status==='running'?'可以切换页面，请保持软件运行。':['error','waiting'].includes(j.status)?esc(j.error):'所选产物已归档；全部上传后，请完成封存。')+'</small>'+(j.status!=='running'?button(j.status==='error'?'重新选择并上传':'返回任务','upload-task'):'');
}
async function loadPage(next,force=false){
 const state=pageLoads[next];if(!state||state.busy)return;state.busy=true;state.error='';render();
 try{const result=await api(next==='assets'?'assets':'product-groups',{force});if(next==='assets')assets=result;else productGroups=result}
 catch(e){state.error=e.message}finally{state.busy=false;if(view===next)render()}
}
const dayKey=value=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const byteText=n=>n>=1024**3?fmt(n/1024**3)+' GB':n>=1024**2?fmt(n/1024**2)+' MB':fmt(n/1024)+' KB';
function assetRange(){
 const anchor=assetDate||dayKey(now()),start=new Date(anchor+'T00:00:00+08:00');let from=+start,to=from+86400000;
 if(assetPeriod==='week'){const weekday=new Date(from+8*3600000).getUTCDay();from-=((weekday+6)%7)*86400000;to=from+7*86400000}
 if(assetPeriod==='month'){from=Date.parse(anchor.slice(0,7)+'-01T00:00:00+08:00');const d=new Date(from+8*3600000);to=Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+1,1)-8*3600000}
 return {from,to};
}
const peopleName=id=>data.people?.find(p=>p.id===id)?.name||(data.person?.id===id?data.person.name:'未分配');
const taskName=t=>t.title||t.product;
const points=t=>Math.round(t.items.reduce((n,i)=>n+i.points,0)*100)/100;
const month=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date(now()));
const dateTime=t=>t?new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const timeText=ms=>{const minutes=Math.floor(Math.max(0,ms)/60000);return minutes<60?minutes+' 分钟':Math.floor(minutes/60)+' 小时 '+minutes%60+' 分钟'};
const elapsed=t=>(t.elapsedMs||0)+(t.runningSince?Math.max(0,now()-t.runningSince):0);
const taskIssue=t=>t?.workbookSyncIssue||t?.assetSyncIssue;
const issueText=t=>{const issue=taskIssue(t);return issue?issue.stage+' · '+issue.message:''};
function icons(){window.lucide?.createIcons({attrs:{'aria-hidden':'true'}})}
function syncBadge(){if(!data.connection?.online){$('#nas-badge').innerHTML='<span class="status-dot"></span>离线 · 显示上次同步数据';return}const ok=data.nasStatus?.connected&&!data.workbookSync?.error;$('#nas-badge').innerHTML='<span class="status-dot '+(ok?'online':'')+'"></span>'+(data.nasStatus?.connected?(data.workbookSync?.error?'NAS 同步异常':data.workbookSync?.lastCheckedAt?'同步于 '+dateTime(data.workbookSync.lastCheckedAt):'NAS 已连接 · 待检查'):'NAS 待连接')}
async function api(command,payload={}){const result=await window.workbench.call(command,payload);if(!result.ok)throw Error(result.error);return result.value}
function toast(message,error=false){clearTimeout(toastTimer);const box=$('#toast');box.textContent=message;box.classList.toggle('error',error);box.hidden=false;toastTimer=setTimeout(()=>box.hidden=true,error?7000:3500)}
function errorBox(message){const target=$('#sheet-error');if(target){target.textContent=message;target.hidden=false}else toast(message,true)}
function button(label,command,extra='',primary=false,disabled=false){return '<button class="button'+(primary?' primary':'')+'" data-command="'+command+'" '+extra+(disabled?' disabled':'')+'>'+label+'</button>'}
function empty(title,copy,action=''){return '<div class="empty">'+icon('layers-2')+'<h2>'+title+'</h2><p>'+copy+'</p>'+action+'</div>'}
function heading(title,description,actions='',eyebrow='DESIGN WORKSPACE'){return '<div class="page-heading"><div><p class="eyebrow">'+eyebrow+'</p><h1>'+title+'</h1><p class="description">'+description+'</p></div><div class="heading-actions">'+actions+'</div></div>'}
function personSummary(p){
 const tasks=data.tasks.filter(t=>t.owner===p.id&&t.state>0),active=tasks.filter(t=>t.state<4),done=tasks.filter(t=>t.state===4&&t.completedMonth===month()),waiting=tasks.filter(t=>t.state===4&&!t.sealed);
 const running=active.some(t=>t.state===2&&t.runningSince),queued=active.some(t=>t.state===1),paused=active.some(t=>t.state===2&&!t.runningSince),score=active.reduce((n,t)=>n+points(t),0),doneScore=done.reduce((n,t)=>n+points(t),0);
 return {tasks,active,done,waiting,running,queued,paused,score,doneScore,free:!running&&!queued&&!paused,label:running?'正在设计':queued?'有待做任务':paused?'设计已暂停':active.some(t=>t.state===3)?'等待确认 · 可接任务':'可接新任务'};
}
function personCard(p,index){
 const s=personSummary(p),capacity=data.monthlyCapacity||139.2,remaining=capacity-s.doneScore-s.score,ratio=Math.min(100,s.doneScore/capacity*100),activeRatio=Math.min(100-ratio,s.score/capacity*100);
 return '<article class="person-card" data-load="'+(s.running?'busy':s.queued||s.paused?'queued':'available')+'"><div class="person-state"><span class="status-dot"></span>'+s.label+'</div><div class="person-head"><span class="avatar a'+index%8+'">'+esc(p.name.slice(-2))+'</span><div class="person-name"><h3>'+esc(p.name)+'<small>'+esc(p.title)+'</small></h3><p><span class="status-dot '+(p.online?'online':'')+'"></span>'+(p.online?'设计端在线':p.paired?'设计端离线':'尚未连接设备')+'</p></div></div><div class="person-score-row"><div><div class="point-display">'+fmt(s.score)+'<small>点</small></div><div class="metric-caption">在手贡献力</div></div><span class="metric-divider"></span><div><div class="task-count">'+s.active.length+'<small>项</small></div><div class="metric-caption">在手任务</div></div></div><div class="status-counts">'+[1,2,3].map(state=>'<span><i class="s'+state+'"></i>'+states[state]+'<b>'+s.active.filter(t=>t.state===state).length+'</b></span>').join('')+'</div><div class="capacity"><div class="capacity-labels"><span>本月完成 <b>'+fmt(s.doneScore)+' 点</b></span><span>月度基准 '+fmt(capacity)+' 点</span></div><div class="capacity-track" aria-label="本月已完成 '+fmt(s.doneScore)+' 点，在手 '+fmt(s.score)+' 点"><span class="capacity-done" style="width:'+ratio+'%"></span><span class="capacity-active" style="width:'+activeRatio+'%"></span></div><div class="capacity-note"><span>'+(remaining>=0?'参考余量 '+fmt(remaining)+' 点':'超出月度基准 '+fmt(-remaining)+' 点')+'</span><span>待封存 '+s.waiting.length+' 项</span></div></div><div class="person-footer"><button class="button quiet small" data-command="pair-person" data-person="'+p.id+'">'+icon('monitor')+'连接设备</button><button class="button quiet small arrow-link" data-command="person-tasks" data-person="'+p.id+'">查看任务'+icon('arrow-up-right')+'</button></div></article>';
}
function teamPage(){
 const active=data.tasks.filter(t=>t.state>0&&t.state<4),free=data.people.filter(p=>!p.removed&&personSummary(p).free).length;
 return heading('团队负荷','先看每个人手上的工作，再安排下一项任务。',button(icon('refresh-cw')+'同步需求','scan','',false,!connected()),'TEAM OVERVIEW')+
 '<div class="overview">'+[
 ['在手任务',active.length,'项','layers-2'],['在手贡献力',fmt(active.reduce((n,t)=>n+points(t),0)),'点','chart-no-axes-column-increasing'],['可接新任务',free,'人','users-round']
 ].map(([title,value,unit,i])=>'<div class="overview-item"><div><div class="overview-label">'+title+'</div><div class="overview-number">'+value+'<small>'+unit+'</small></div></div><span class="overview-icon">'+icon(i)+'</span></div>').join('')+'</div>'+
 '<div class="section-heading"><h2>人员看板 <span> / '+data.people.length+' 人</span></h2><span>'+month().replace('-',' 年 ')+' 月 · '+fmt(data.monthlyCapacity||139.2)+' 点 / 人</span></div>'+
 (!data.nasStatus?.connected?'<div class="notice">连接现有 NAS 后，导入这五个文件夹中的需求。'+button('连接 NAS','settings-shortcut','',false,false)+'</div>':'')+
 '<div class="people-grid">'+data.people.filter(p=>!p.removed).map(personCard).join('')+'</div>';
}
function timing(t){
 if(t.state===0)return '等待负责人分配';
 if(t.state===1)return '分配于 '+dateTime(t.assignedAt);
 if(t.state===2)return (t.runningSince?'已设计 ':'已暂停 · 累计 ')+timeText(elapsed(t))+(t.pauseReason?' · '+esc(t.pauseReason):'');
 if(t.state===3)return '等待确认 '+timeText(now()-t.reviewAt)+' · 累计设计 '+timeText(elapsed(t));
 return '确认于 '+dateTime(t.completedAt);
}
function taskActions(t){
 const id='data-task="'+t.id+'"';
 let actions='';
 if(manager()){
  if(t.state===0)actions='<div class="action-group"><select aria-label="为'+esc(taskName(t))+'选择设计师" data-assignee="'+t.id+'">'+data.people.filter(p=>!p.removed).map(p=>'<option value="'+p.id+'"'+(p.name===t.requestedDesigner?' selected':'')+'>'+esc(p.name)+'</option>').join('')+'</select>'+button('分配任务','assign',id,true,!connected())+'</div>';
  else if(t.state===3)actions=button('确认完成','approve-open',id,true,!connected());
  else actions='<span class="readonly">'+(t.state===4?(t.sealed?'已封存':'等待设计封存'):t.state===2?'设计师正在处理':'等待设计师开始')+'</span>';
  if(t.state>0)actions+=button(icon('undo-2')+'回退','rollback-open',id,false,!connected());
  if(t.state>0&&t.state<4)actions+=button('改派','reassign-open',id,false,!connected());
 }else{
  if(t.state===1)actions=button(icon('play')+'开始设计','start',id,true,!connected());
  else if(t.state===2){actions=button('已提交，待确认','review',id,true,!connected())+button(t.runningSince?'暂停':'继续计时',t.runningSince?'pause-open':'resume',id,false,!data.connection?.online)}
  else if(t.state===3)actions='<span class="readonly">等待运营在聊天中确认</span>'+button('收到修改','rework',id,false,!connected());
  else if(t.state===4)actions=t.sealed?'<span class="readonly">'+icon('circle-check')+' 已封存</span>':button(icon('archive')+((t.deliveries||[]).length?'继续归档 / 完成封存':'上传产物'),'seal-open',id,true,!connected());
 }
 return actions;
}
function taskCard(t){
 const unread=!manager()&&t.assignmentId&&!t.readAt&&t.state<4,rateOf=i=>data.rates?.find(r=>r.id===i.type);
 return '<article class="task-card s'+t.state+'" data-card="'+t.id+'"><div class="task-top"><span class="task-status">'+icon(stateIcons[t.state])+states[t.state]+(t.state===4?' · '+(t.sealed?'已封存':'待封存'):'')+'</span><small>'+(t.state===0?'优先分配':unread?'新分配任务':t.blocked?'文件同步待恢复':t.importedTiming?'原有任务':'')+'</small></div><div class="task-content"><button class="task-title" data-command="task-detail" data-task="'+t.id+'">'+esc(taskName(t))+'</button><div class="task-subtitle">'+esc(t.brand)+' · '+esc(manager()?peopleName(t.owner):t.operator+' 提出需求')+'</div><div class="task-value-row"><div class="point-display">'+fmt(points(t))+'<small>点</small></div><div class="task-types">'+t.items.slice(0,2).map(i=>'<div><b>'+esc(i.typeName)+'</b><br>'+fmt(rateOf(i)?.points)+' 点 / '+esc(rateOf(i)?.unit||'项')+' × '+i.qty+(i.extra?' · 额外 '+i.extra+' 张':'')+'</div>').join('')+(t.items.length>2?'<div>共 '+t.items.length+' 个事项</div>':'')+'</div></div><div class="task-timing">'+icon(t.runningSince?'timer':'clock-3')+'<span class="time" data-clock="'+t.id+'">'+timing(t)+'</span></div>'+(manager()&&t.owner&&t.state<4?'<div class="receipt">'+(t.readAt?'已查看 · '+dateTime(t.readAt):t.receivedAt?'已送达设计端':'等待设计端接收')+'</div>':'')+'</div><div class="task-footer">'+taskActions(t)+'</div></article>';
}
function selectedTasks(){
 return data.tasks.filter(t=>(!person||t.owner===person)&&(!['seal'].includes(view)||t.state===4&&!t.sealed)&&(filter==='all'||(filter==='unsealed'?t.state===4&&!t.sealed:t.state===Number(filter)))&&(!query||((taskName(t))+' '+t.product+' '+t.code+' '+t.brand+' '+t.operator).toLowerCase().includes(query.toLowerCase()))).sort((a,b)=>(a.state===0?0:1)-(b.state===0?0:1)||(b.updatedAt-a.updatedAt));
}
function tasksPage(){
 const unread=data.tasks.filter(t=>!t.readAt&&t.assignmentId&&t.state<4),label=person?peopleName(person)+'的任务':view==='seal'?'待封存':'我的任务';
 const title=manager()?(person?label:'任务列表'):label,description=manager()?(person?'已分配任务与等待事项，一眼看清进度。':'待分配任务优先排列，操作后需求表自动流转。'):view==='seal'?'运营已经确认完成，上传最终产物并封存。':'从这里开始设计，每一次进展都会同步给负责人。';
 const actions=(manager()?button(icon('refresh-cw')+'刷新已完结','refresh-completed','',false,!connected()):'')+(person?button(icon('arrow-left')+'返回人员','back-team'):'')+(manager()?button(icon('upload')+'上传需求','import-open','',true,!connected()):'');
 let html=heading(title,description,actions,manager()?'TASKS':'MY WORK');
 if(!manager()&&unread.length&&view!=='seal')html+='<div class="new-inbox"><div class="inbox-icon">'+icon('bell-ring')+'</div><div><h3>你有 '+unread.length+' 项新分配任务</h3><p>'+esc(unread.slice(0,2).map(taskName).join('、'))+'</p></div>'+button('查看新任务','open-new','data-task="'+unread[0].id+'"',true)+'</div>';
 if(view!=='seal')html+='<div class="list-tools"><div class="segmented" aria-label="任务状态">'+[['all','全部'],...states.map((s,i)=>[String(i),s]).filter(([i])=>manager()||i!=='0'),...(manager()?[['unsealed','待封存']]:[])].map(([value,label])=>'<button class="segment '+(filter===value?'active':'')+'" data-filter="'+value+'" aria-pressed="'+(filter===value)+'">'+label+(manager()?'<span class="filter-count">'+data.tasks.filter(t=>(!person||t.owner===person)&&(value==='all'||(value==='unsealed'?t.state===4&&!t.sealed:t.state===Number(value)))).length+'</span>':'')+'</button>').join('')+'</div><label class="search">'+icon('search')+'<input id="task-search" value="'+esc(query)+'" placeholder="搜索任务名、产品名、69码" aria-label="搜索任务"></label></div>';
 const tasks=selectedTasks();return html+(tasks.length?'<div class="tasks-grid">'+tasks.map(taskCard).join('')+'</div>':empty(view==='seal'?'所有已完结任务都已封存':'这里暂时没有任务',manager()?'上传需求，或从现有 NAS 文件夹导入。':'负责人分配后，新任务会在这里出现。'));
}
function pairingPage(){
 return '<div class="onboarding"><div class="intro-icon">'+icon('monitor-check')+'</div><p class="eyebrow">DESIGNER</p><h1>这是你的设计工作台</h1><p>向负责人索取你的设备连接码，粘贴后即可收到分配给你的任务。首次连接后，这台电脑会记住你的身份。</p><form id="pair-form"><label class="field"><span>设备连接码</span><textarea id="pair-code-input" spellcheck="false" placeholder="粘贴负责人生成的连接码" required aria-label="设备连接码"></textarea></label><div class="form-error" id="pair-error" hidden></div><button class="button primary" type="submit">连接我的工作台'+icon('arrow-right')+'</button></form><p>请在公司内网中打开负责人端，再完成连接。</p></div>';
}
function assetsPage(){
 const range=assetRange(),matches=assets.filter(a=>(assetScope==='all'||a.author===data.person?.id)&&(!assetPerson||a.author===assetPerson)&&(assetPeriod==='all'||a.at&&a.at>=range.from&&a.at<range.to)&&(!query||[a.code,a.product,a.brand,a.authorName,...(a.aliases||[])].join(' ').toLowerCase().includes(query.toLowerCase()))).sort((a,b)=>(b.at||0)-(a.at||0));
 const authors=[...new Map(assets.filter(a=>a.author).map(a=>[a.author,a.authorName||peopleName(a.author)])).entries()],files=matches.flatMap(a=>a.files||[]),dated=matches.filter(a=>a.at),unknown=assets.filter(a=>!a.at).length;
 let lastDay='',rows='';const history=matches.filter(a=>!a.at),historyOpen=$('#asset-history')?.open;
 for(const a of matches){const day=a.at?dayKey(a.at):'上传时间未知';if(day!==lastDay){rows+=a.at?'<h2 class="asset-day">'+esc(day)+'</h2>':'<details class="asset-history" id="asset-history"'+(historyOpen?' open':'')+'><summary><span>历史目录 <b>'+history.length+'</b></span><span class="history-hint">无上传时间 · 点击展开或收起</span></summary><div class="asset-history-body">';lastDay=day}
  rows+='<article class="asset-row"><span class="asset-icon">'+icon('folder-check')+'</span><div class="asset-info"><h3>'+esc(a.product)+'</h3><p>'+esc(a.brand)+' · '+esc(a.code)+'</p><p class="asset-stamp">'+icon('clock-3')+(a.at?esc(dateTime(a.at))+' · '+esc(a.authorName||peopleName(a.author)):'NAS 历史目录 · 无上传记录')+'</p><p class="asset-location">'+esc(a.path)+'</p><div class="asset-requirement">'+(a.requirement?'<span>对应需求：'+esc(a.requirement.title)+' · '+esc(states[a.requirement.state])+'</span>'+(a.requirement.canOpen?button('打开需求表','open-requirement','data-task="'+esc(a.taskId)+'"'):'<span>请向负责人查看需求表</span>'):'<span>未关联需求表</span>')+'</div>'+(a.files?.length?'<details class="asset-files"><summary>'+a.files.length+' 个文件 · '+byteText(a.files.reduce((n,f)=>n+(f.size||0),0))+' · 查看明细和位置</summary>'+a.files.map(f=>'<div class="asset-file"><strong>'+esc(f.name)+'</strong><span>'+(f.kind==='output'?'最终产物':'源文件')+' · '+byteText(f.size||0)+'</span><p>'+esc(f.path)+'</p></div>').join('')+'</details>':'')+'</div>'+button('打开位置'+icon('arrow-up-right'),'open-asset','data-asset="'+a.id+'"')+'</article>';
 }
 if(history.length)rows+='</div></details>';
 return heading('资产查询','按真实归档时间追踪上传批次、人员和文件位置。','','ASSET LIBRARY')+
 '<div class="asset-filters"><div class="list-tools"><div class="segmented">'+[['all','全部时间'],['day','按天'],['week','按周'],['month','按月']].map(([id,label])=>'<button class="segment '+(assetPeriod===id?'active':'')+'" data-period="'+id+'" aria-pressed="'+(assetPeriod===id)+'">'+label+'</button>').join('')+'</div><label class="field"><span>选择日期'+(assetPeriod==='week'?'（所在周）':assetPeriod==='month'?'（所在月）':'')+'</span><button type="button" class="calendar-trigger" data-calendar="asset" id="asset-date" value="'+esc(assetDate||dayKey(now()))+'"'+(assetPeriod==='all'?' disabled':'')+'>'+esc(assetDate||dayKey(now()))+icon('calendar-days')+'</button></label><label class="field"><span>上传人员</span><select id="asset-person"><option value="">全部人员</option>'+authors.map(([id,name])=>'<option value="'+esc(id)+'"'+(assetPerson===id?' selected':'')+'>'+esc(name)+'</option>').join('')+'</select></label></div><div class="list-tools"><div class="segmented">'+['all','mine'].map(scope=>'<button class="segment '+(assetScope===scope?'active':'')+'" data-command="asset-scope" data-scope="'+scope+'">'+(scope==='all'?'团队共享':'仅看我的')+'</button>').join('')+'</div><label class="search">'+icon('search')+'<input id="asset-search" value="'+esc(query)+'" placeholder="搜索产品、69码或人员" aria-label="搜索资产"></label></div><p class="description">'+(assetPeriod==='all'?'全部时间':dayKey(range.from)+' 至 '+dayKey(range.to-1))+(assetPeriod==='week'?' · 周一至周日，北京时间。':' · 北京时间。')+(unknown?' '+unknown+' 个历史目录无上传时间，不计入日期统计。':'')+'</p></div>'+
 '<div class="asset-totals"><span><b>'+dated.length+'</b> 个上传批次</span><span><b>'+files.length+'</b> 个文件</span><span><b>'+byteText(files.reduce((n,f)=>n+(f.size||0),0))+'</b> 文件总量</span></div>'+
 (matches.length?'<div class="asset-list">'+rows+'</div>':empty('这个范围没有资产记录','可以更换日期、人员，或清空搜索条件。'));
}
function productsPage(){
 const needle=query.trim().toLowerCase(),groups=productGroups.filter(group=>!needle||[group.brand,group.canonicalName,...(group.aliases||[]),...(group.variants||[]).flatMap(variant=>[variant.code,variant.name,variant.spec])].join(' ').toLowerCase().includes(needle));
 return heading('产品归组','优先显示已保存的目录索引。NAS 手动新增或改名后，点击“更新目录”；归组不会移动历史文件。','','PRODUCT FAMILIES')+
 '<div class="product-rule-banner">'+icon('scan-search')+'<div><strong>模糊只负责找候选，69码负责最终封存</strong><p>别名和产品系列不会移动历史文件，也不会让不同规格共用一个目录。</p></div></div>'+
 '<div class="list-tools"><label class="search">'+icon('search')+'<input id="product-search" value="'+esc(query)+'" placeholder="搜索品牌、产品名、别名或69码" aria-label="搜索产品归组"></label><span class="description">'+groups.length+' 个产品系列 · '+groups.reduce((sum,group)=>sum+(group.variants?.length||0),0)+' 个69码</span></div>'+
 (groups.length?'<div class="product-groups">'+groups.map(group=>'<article class="product-group-card"><div class="product-group-head"><div><p>'+esc(group.brand)+'</p><h2>'+esc(group.canonicalName)+'</h2></div>'+button('管理归组'+icon('chevron-right'),'product-group-open','data-group="'+group.id+'"')+'</div>'+(group.aliases?.length?'<div class="product-aliases">'+group.aliases.map(alias=>'<span>'+esc(alias)+'</span>').join('')+'</div>':'')+'<div class="variant-list">'+group.variants.map(variant=>'<div class="variant-row"><span class="variant-code">'+esc(variant.code)+'</span><div><strong>'+esc(variant.name)+'</strong><small>'+(variant.spec?'规格 '+esc(variant.spec):'规格未单独标注')+'</small></div><span class="variant-path">'+(variant.path?'已定位 NAS':'等待首次封存')+'</span></div>').join('')+'</div></article>').join('')+'</div>':empty('还没有产品归组','连接 NAS 后，已有“产品名-69码”目录会自动建立索引。'));
}
function reportsPage(){
 return heading('数据分析导出','按周或按月生成结构化 Excel，直接交给 AI 做人员、任务、产品和流程分析。','','ANALYTICS EXPORT')+
 '<div class="report-hero"><div class="report-hero-icon">'+icon('sparkles')+'</div><div><h2>一个文件，保留分析所需的完整上下文</h2><p>包含任务明细、事项明细、人员汇总、产品维度、状态流转和每日趋势。每张表都使用固定字段，便于 AI 交叉核对。</p><div class="dimension-chips"><span>人员</span><span>任务</span><span>事项</span><span>产品</span><span>状态</span><span>时间</span></div></div></div>'+
 '<div class="report-grid"><article class="report-card"><span class="report-icon week">'+icon('calendar-days')+'</span><p class="eyebrow">WEEKLY</p><h2>周度数据表</h2><p>按周一至周日统计工作量和流程变化；缺少历史版本的任务会单独注明。</p>'+button('选择周并导出'+icon('arrow-up-right'),'report-open','data-frequency="week"',true)+'</article><article class="report-card"><span class="report-icon month">'+icon('calendar-range')+'</span><p class="eyebrow">MONTHLY</p><h2>月度数据表</h2><p>按自然月统计，适合复盘产出结构、贡献力分布、高频产品和长期流程问题。</p>'+button('选择月份并导出'+icon('arrow-up-right'),'report-open','data-frequency="month"',true)+'</article></div>'+
 '<div class="report-note">'+icon('shield-check')+'<div><strong>截止状态与缺失数据均有说明</strong><p>按统计截止时的版本导出，后续修改不会倒灌历史。升级前无法还原的任务、推定确认时间和不完整计时会列入数据质量页。</p></div></div>';
}
function importIssueRow(issue){
 const stageIndex=states.findIndex((state,index)=>issue.stage===(index+1)+'.'+state);
 const location=stageIndex>=0?issue.stage:'位置未记录，请重新扫描';
 return '<li><div class="import-location"><span>所在文件夹</span><span class="import-stage s'+stageIndex+'">'+icon('folder')+esc(location)+'</span></div><strong>'+esc(issue.filename)+'</strong><span>'+esc(issue.error)+'</span></li>';
}
function managementConnection(){return '<section class="settings-card" style="margin-bottom:24px"><h2>'+ (data.remoteManager?'已连接负责人主机':'多电脑管理')+'</h2><p class="description">主机保持运行。第二台连接后可管理同一份任务，无需另连 NAS 任务库。</p>'+(!data.remoteManager?'<label class="field"><span>主机内网地址</span><select id="manager-host">'+(data.addresses||[]).map(a=>'<option>'+esc(a.address)+'</option>').join('')+'</select></label>'+button('生成管理连接码','manager-code')+button('停用所有远程管理连接','manager-revoke-open'):'')+'<label class="field"><span>在第二台电脑粘贴管理连接码</span><textarea id="manager-connection-code" placeholder="DW1.…"></textarea></label>'+button(data.remoteManager?'重新连接主机':'连接现有负责人主机','manager-connect','',true)+'<p id="manager-connect-status" class="description" role="status" aria-live="polite">'+esc(managerConnectionStatus)+'</p></section>'}
function settingsPage(){
 if(manager()&&data.remoteManager)return heading('连接与维护','当前为管理连接端，NAS 服务由主机运行。','','WORKSPACE SETTINGS')+managementConnection();
 if(!manager())return heading('连接与提醒','保持工作台在后台运行，及时接收新任务。','','PREFERENCES')+'<div class="settings-grid"><section class="settings-card"><h2>我的设备</h2><p class="description">'+esc(data.person?.name||'尚未连接')+' · '+(data.connection?.online?'已连接负责人端':'正在重连')+'</p><div class="setting-row"><div><strong>开机启动</strong><small>登录 Windows 后自动打开设计端</small></div><input class="switch" type="checkbox" data-preference="autostart" aria-label="开机启动" '+(data.preferences?.autostart?'checked':'')+'></div><div class="setting-row"><div><strong>关闭通知声音</strong><small>保留桌面提醒和应用内未读标记</small></div><input class="switch" type="checkbox" data-preference="mute" aria-label="关闭通知声音" '+(data.preferences?.mute?'checked':'')+'></div><div class="notice">关闭窗口后，设计端会继续在系统托盘运行。完全退出后，未读任务会在下次打开时补收。</div>'+button('测试通知','test-notification')+button('重新绑定设备','re-pair')+'</section><section class="settings-card"><h2>同步状态</h2><div class="summary-line"><span>负责人端</span><span>'+(data.connection?.online?'已连接':'未连接')+'</span></div><div class="summary-line"><span>NAS</span><span>'+(data.nasStatus?.connected?'连接正常':'等待恢复')+'</span></div><p class="description" style="margin-top:18px">断线时保留最近的任务信息，重新连接后再进行状态操作。</p></section></div>';
 const config=data.config||{taskRoot:TASK_ROOT,assetRoot:ASSET_ROOT};
 return heading('连接与维护','沿用现有 NAS 目录，让两端始终看到同一份任务。','','WORKSPACE SETTINGS')+managementConnection()+
 '<div class="settings-grid"><div><section class="settings-card"><h2>连接现有 NAS</h2><p class="description">原需求表在这五个文件夹中移动，封存产物进入正式资产库。</p><div class="stages-inline">'+states.map((s,i)=>'<span>'+(i+1)+'.'+s+'</span>').join('')+'</div><form id="nas-form"><label class="field"><span>任务对接库</span><div class="field-line"><input class="path" id="task-root" value="'+esc(config.taskRoot)+'" required><button class="icon-button" type="button" data-command="pick-root" data-field="task-root" aria-label="选择任务对接库">'+icon('folder-open')+'</button></div></label><label class="field"><span>正式资产库</span><div class="field-line"><input class="path" id="asset-root" value="'+esc(config.assetRoot)+'" required><button class="icon-button" type="button" data-command="pick-root" data-field="asset-root" aria-label="选择正式资产库">'+icon('folder-open')+'</button></div></label><div class="form-error" id="nas-error" hidden></div><div class="notice">负责人端后台每 5 秒检查五个状态文件夹：自动导入新需求，同步 Excel 状态、改名和封存资产。右上角刷新会立即执行同一套完整检查。</div><div class="settings-action"><button type="submit" class="button primary">'+icon('plug-zap')+(data.nasStatus?.connected?'检查并连接':'连接 NAS')+'</button>'+button('立即扫描需求','scan','',false,!connected())+'</div></form></section>'+
 '<section class="settings-card" style="margin-top:20px"><h2>服务与数据</h2><div class="setting-row"><div><strong>开机启动负责人端</strong><small>登录 Windows 后恢复任务同步服务</small></div><input class="switch" type="checkbox" data-preference="autostart" aria-label="开机启动负责人端" '+(data.preferences?.autostart?'checked':'')+'></div><div class="notice">负责人端关闭窗口后仍会在托盘运行。完全退出或电脑关机时，设计端会等待重新连接。</div><div class="settings-action">'+button('备份任务记录','backup','',false,!connected())+button('重试文件同步','recover','',false,!data.connection?.online)+'</div>'+(data.jobs?.length?'<ul class="issue-list">'+data.jobs.map(j=>'<li><strong>文件同步待处理</strong>'+esc(j.error)+'</li>').join('')+'</ul>':'')+'</section>'+
 (data.importIssues?.length?'<section class="settings-card" style="margin-top:20px"><h2>'+data.importIssues.length+' 份需求未导入</h2><p class="description">按所在状态文件夹找到原表，查看失败原因，修正后再次导入。</p><ul class="issue-list import-issues">'+data.importIssues.map(importIssueRow).join('')+'</ul></section>':'')+'</div>'+
 '<section class="settings-card"><h2>设计端连接</h2><p class="description">每位设计师使用自己的连接码，绑定对应的设计端。</p><label class="field"><span>这台电脑的内网地址</span><select id="host-address">'+(data.addresses||[]).map(a=>'<option value="'+a.address+'">'+a.address+' · '+esc(a.adapter)+'</option>').join('')+'</select></label><div class="device-list">'+data.people.filter(p=>p.title==='设计师'&&!p.removed).map((p,i)=>'<div class="device"><span class="avatar small a'+i+'">'+esc(p.name.slice(-2))+'</span><div class="device-name">'+esc(p.name)+'<small>'+(p.online?'在线':p.paired?'已绑定 · 离线':'尚未绑定')+'</small></div>'+button('连接','pair-person','data-person="'+p.id+'"',false,!connected())+button('移出成员','member-remove','data-person="'+p.id+'"',false,!connected())+'</div>').join('')+'</div></section></div>';
}
function render({animate=false}={}){
 if(composingSearch)return;
 const roleLabel=manager()?'负责人端':'设计端',roleIcon=manager()?'../assets/icon-manager.png':'../assets/icon-designer.png';document.documentElement.dataset.role=data.role;$('#app-icon').src=roleIcon;$('#client-label').textContent=roleLabel;$('#window-role').textContent=roleLabel;$('#app-version').textContent='v'+(data.version||'—');document.title='设计协作·'+roleLabel+' v'+(data.version||'')+' · Design by Mason Zeng';$('#identity-name').textContent=data.person?.name||'等待连接';$('#identity-avatar').textContent=data.person?.name.slice(-2)||'设';
 const nav=manager()?[['team','人员看板','users-round'],['tasks','任务列表','layout-grid'],['reports','数据导出','file-chart-column-increasing'],['products','产品归组','boxes'],['assets','资产查询','folder-check'],['settings','连接与维护','settings-2']]:[['tasks','我的任务','layout-grid'],['seal','待封存','archive'],['assets','资产查询','folder-check'],['settings','连接与提醒','settings-2']];
 $('#navigation').innerHTML=nav.map(([id,label,i])=>'<button class="nav-item '+(view===id?'active':'')+'" data-view="'+id+'">'+icon(i)+'<span>'+label+'</span>'+(manager()&&id==='tasks'&&data.tasks.some(t=>t.state===0)?'<span class="badge" aria-label="待分配">'+data.tasks.filter(t=>t.state===0).length+'</span>':'')+(id==='seal'&&data.tasks.some(t=>t.state===4&&!t.sealed)?'<span class="badge">'+data.tasks.filter(t=>t.state===4&&!t.sealed).length+'</span>':'')+'</button>').join('');
 $('#breadcrumb').textContent=(manager()?'负责人工作台':'设计工作台')+' / '+(nav.find(n=>n[0]===view)?.[1]||'我的任务');
 $('#current-date').textContent=new Date(now()).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',month:'long',day:'numeric',weekday:'long'});
 $('#connection-state').innerHTML='<span class="status-dot '+(data.connection?.online?'online':'')+'"></span>'+(data.connection?.online?'内网同步在线':'等待连接');
 syncBadge();
 const offline=$('#offline-banner');offline.hidden=(!!data.connection?.online&&!data.nasStatus?.error)||data.requiresPairing;offline.textContent=data.connection?.error||data.nasStatus?.error||'正在连接负责人端，任务操作将在连接恢复后开放。';
 const main=$('#main'),scroll=window.scrollY,active=document.activeElement,focusId=active?.id,selection=active?.selectionStart;
 if(data.requiresPairing)main.innerHTML=pairingPage();
 else if(view==='team')main.innerHTML=teamPage();
 else if(view==='assets')main.innerHTML=assetsPage();
 else if(view==='reports')main.innerHTML=reportsPage();
 else if(view==='products')main.innerHTML=productsPage();
 else if(view==='settings')main.innerHTML=settingsPage();
 else main.innerHTML=tasksPage();
 if(pageLoads[view]){const state=pageLoads[view],banner=document.createElement('div');banner.className='index-status';banner.setAttribute('role','status');banner.innerHTML=(state.busy?'<span class="spinner"></span>正在读取目录索引，首次读取可能较慢…':state.error?'读取失败：'+esc(state.error):'已加载保存的目录索引；NAS 新增或改名后，请点击“更新目录”。')+button(state.error?'重试':'更新目录','index-refresh','',false,state.busy);main.prepend(banner)}
 if(data.workbookSync?.error){const warning=document.createElement('div');warning.className='form-error';warning.textContent=data.workbookSync.error;main.prepend(warning)}
 for(const t of data.tasks.filter(taskIssue)){
  const card=$('[data-card="'+t.id+'"] .task-content');if(!card)continue;
  const warning=document.createElement('p');warning.className='form-error';warning.textContent=issueText(t);card.append(warning);
 }
 for(const [id,reminder] of flowReminders){
  const task=data.tasks.find(t=>t.id===id);if(!task||task.state!==reminder.state){flowReminders.delete(id);continue}
  const card=$('[data-card="'+id+'"] .task-content');if(card){const warning=document.createElement('p');warning.className='form-error';warning.setAttribute('role','status');warning.textContent=reminder.message;card.append(warning)}
 }
 const detailTask=dialogContext?.kind==='detail'&&data.tasks.find(t=>t.id===dialogContext.taskId);
 if(detailTask){for(const line of document.querySelectorAll('#sheet-body .summary-line'))if(line.querySelector('dt')?.textContent==='任务状态')line.querySelector('dd').textContent=states[detailTask.state]}
 const sheetIssue=$('#requirement-sync-issue');if(sheetIssue){const issueTask=data.tasks.find(t=>t.id===dialogContext?.taskId);sheetIssue.hidden=!taskIssue(issueTask);sheetIssue.textContent=issueText(issueTask)}
 main.classList.toggle('page-enter',!manager()&&animate&&lastInput==='pointer');icons();window.scrollTo({top:scroll,behavior:'instant'});
 if(manager()&&animate&&lastInput==='pointer'&&!matchMedia('(prefers-reduced-motion:reduce)').matches){
  const parts=[...main.querySelectorAll('.page-heading,.overview,.section-heading,.person-card,.task-card,.list-tools,.settings-card,.report-card,.product-group')].filter(el=>el.getBoundingClientRect().top<innerHeight).slice(0,9);
  for(const [index,el] of parts.entries())el.animate([{opacity:0,transform:'translateY(8px)'},{opacity:1,transform:'translateY(0)'}],{duration:200,delay:Math.min(index*12,72),easing:'cubic-bezier(0.23,1,0.32,1)',fill:'backwards'});
 }
 if(focusId&&['task-search','asset-search','product-search'].includes(focusId)){const input=document.getElementById(focusId);input?.focus({preventScroll:true});input?.setSelectionRange(selection,selection)}
}
async function navigate(next){view=next;filter='all';person=null;query='';render({animate:true});window.scrollTo({top:0,behavior:'instant'});if(pageLoads[next])await loadPage(next)}
function moveSheet(open){
 const dialog=$('#sheet'),reduced=matchMedia('(prefers-reduced-motion:reduce)').matches||(manager()&&lastInput==='keyboard');
 const presentation=getComputedStyle(dialog),fromX=dialog.open?(new DOMMatrixReadOnly(presentation.transform).m41||0):36,fromOpacity=dialog.open?Number(presentation.opacity):0;
 sheetMotion?.cancel();
 if(open&&!dialog.open)dialog.showModal();
 if(reduced){dialog.style.transform='none';dialog.style.opacity='1';if(!open)dialog.close();return}
 const targetX=open?0:36,targetOpacity=open?1:0,frames=[];
 for(let i=0;i<=30;i++){const t=i/30*.4,w=24,s=1-(1+w*t)*Math.exp(-w*t);frames.push({transform:'translateX('+(fromX+(targetX-fromX)*s)+'px)',opacity:fromOpacity+(targetOpacity-fromOpacity)*s,offset:i/30})}
 frames[30]={transform:'translateX('+targetX+'px)',opacity:targetOpacity,offset:1};
 sheetMotion=dialog.animate(frames,{duration:open?(manager()?280:320):220,fill:'both'});
 const current=sheetMotion;current.onfinish=()=>{if(sheetMotion!==current)return;if(!open)dialog.close();current.cancel();dialog.style.transform='none';dialog.style.opacity='1'};
}
function openSheet(title,content,context={},eyebrow='设计协作'){
 if(eyebrow==='TASK DETAILS')context.kind='detail';
 const issueTask=data.tasks.find(t=>t.id===context.taskId),issue=taskIssue(issueTask);
 content='<div id="requirement-sync-issue" class="form-error" '+(issue?'':'hidden')+'>'+esc(issueText(issueTask))+'</div>'+content;
 dialogContext=context;$('#sheet-title').textContent=title;$('#sheet-eyebrow').textContent=eyebrow;$('#sheet-body').innerHTML=content+'<div id="sheet-error" class="form-error" hidden></div>';icons();moveSheet(true);
 setTimeout(()=>$('#sheet-body input, #sheet-body select, #sheet-body textarea, #sheet-body button')?.focus({preventScroll:true}),0);
}
function closeSheet(){moveSheet(false);dialogContext=null}
async function taskDetail(id){
 const t=data.tasks.find(t=>t.id===id);if(!t)return;
 if(!manager()&&t.assignmentId&&!t.readAt){try{await api('read',{taskId:id,assignmentId:t.assignmentId})}catch{}}
 openSheet(taskName(t),'<div class="task-detail-score"><span>标准贡献力</span><div class="point-display">'+fmt(points(t))+'<small>点</small></div></div><dl>'+[['任务状态',states[t.state]],['产品名',t.product],['品牌',t.brand],['产品69码',t.code],['运营',t.operator],['设计师',manager()?peopleName(t.owner):data.person?.name],['提出需求',dateTime(t.requestedAt)],['分配时间',dateTime(t.assignedAt)],['首次开始',dateTime(t.startedAt)],['提交待确认',dateTime(t.reviewAt)],['确认完成',dateTime(t.completedAt)],['完成封存',dateTime(t.sealedAt)],['最近更新',dateTime(t.updatedAt)],['实际设计耗时',timeText(elapsed(t))]].map(([k,v])=>'<div class="summary-line"><dt>'+k+'</dt><dd>'+esc(v)+'</dd></div>').join('')+'</dl><div style="margin-top:22px">'+t.items.map(i=>'<div class="item-row"><strong>'+esc(i.typeName)+' · '+fmt(i.points)+' 点</strong><p>'+i.qty+' '+esc(data.rates.find(r=>r.id===i.type)?.unit||'项')+(i.note?' · '+esc(i.note):'')+'</p></div>').join('')+'</div>'+ (t.importedTiming?'<div class="notice">这是从现有 NAS 导入的任务。导入前的准确耗时无法从表内小时字段还原；恢复计时后会继续准确记录。</div>':'')+'<div class="sheet-actions">'+button(icon('file-spreadsheet')+'查看需求表','open-requirement','data-task="'+id+'"',true,!connected())+(t.state===4&&(t.sealed||(t.deliveries||[]).length)?button(icon('folder-open')+'文件存放位置','task-asset-location','data-task="'+id+'"'):'')+(manager()&&t.state===4&&t.sealed?button('恢复待封存','archive-reopen','data-task="'+id+'"'):'')+(manager()?button('检查重复记录','duplicate-inspect','data-task="'+id+'"'):'')+'</div><div id="history-region"></div>',{taskId:id},'TASK DETAILS');
 try{const history=await api('history',{taskId:id});if(dialogContext?.taskId===id){const names={rollback:'负责人回退环节',assign:'分配 / 改派任务',start:'开始设计',pause:'暂停设计',resume:'继续计时',review:'提交运营确认',rework:'收到修改，继续设计',approve:'记录运营聊天确认',sealed:'产物封存完成','archive-reopened':'负责人恢复待封存','asset-archived':'一类产物归档成功','asset-removed':'封存文件已删除，恢复待封存','contribution-standard-updated':'贡献力改为按单个成品计算','requirement-created':'上传需求','imported-existing':'导入原有需求','excel-synced':'NAS 原表同步'};$('#history-region').innerHTML='<ul class="history-list">'+history.slice(0,8).map(e=>'<li>'+esc(names[e.kind]||e.kind)+'<time>'+dateTime(e.at)+'</time></li>').join('')+'</ul>'}}catch{}
}
async function pairPerson(id){
 const p=data.people.find(p=>p.id===id);if(!p)return;
 if(!connected()){toast('请先连接现有 NAS',true);return}
 const host=$('#host-address')?.value||data.addresses?.[0]?.address;if(!host){toast('未找到公司内网地址，请检查网络',true);return}
 openSheet('连接 '+p.name+' 的设计端','<p class="description">此连接码只绑定 '+esc(p.name)+'，使用一次后失效。</p><div class="loading-shell" style="padding:50px 0">正在生成连接码…</div>',{personId:id},'CONNECT DEVICE');
 try{const result=await api('pair-code',{personId:id,host});dialogContext={personId:id,code:result.code};$('#sheet-body').innerHTML='<p class="description">在 '+esc(p.name)+' 的电脑上安装设计端，将此连接码粘贴到首次连接页面。</p><label class="field"><span>专属设备连接码</span><textarea class="connection-code" readonly aria-label="专属连接码">'+esc(result.code)+'</textarea></label><div class="notice">有效期至 '+dateTime(result.expires)+'。负责人端保持运行，两台电脑连接公司内网。</div><div class="sheet-actions">'+button('复制连接码','copy-code','',true)+'</div>'+(p.paired?'<div class="sheet-actions">'+button('解除该人员所有旧设备','revoke','data-person="'+id+'"')+'</div>':'')+'<div id="sheet-error" class="form-error" hidden></div>';icons()}catch(e){errorBox(e.message)}
}
function importSheet(){openSheet('上传需求','<p class="description">选择填写完成的公司需求表。</p><button class="upload-pick" data-command="draft-pick">'+icon('file-up')+'选择 Excel 需求表</button><div id="draft-summary"></div><div class="sheet-actions">'+button('上传需求','import-submit','disabled',true)+'</div>',{},'NEW REQUEST')}
function reportSheet(frequency){
 const weekly=frequency==='week',today=new Date(now()+8*3600000).toISOString().slice(0,10);
 openSheet(weekly?'导出周度数据表':'导出月度数据表','<p class="description">'+(weekly?'选择这一周内的任意一天，系统会自动按周一至周日统计。':'选择目标月份内的任意一天，系统会自动统计整个自然月。')+'</p><label class="field"><span>'+(weekly?'选择周':'选择月份')+'</span><button type="button" class="calendar-trigger" data-calendar="report" data-mode="'+(weekly?'week':'month')+'" id="report-anchor" value="'+today+'">'+today+icon('calendar-days')+'</button></label><div class="report-sheet-list"><span>'+icon('table-2')+'7 个结构化工作表</span><span>'+icon('bot')+'附带 AI 分析口径与提示词</span><span>'+icon('list-filter')+'表头冻结并支持筛选</span></div><div class="sheet-actions">'+button(icon('file-down')+'导出 Excel','report-export','',true)+'</div>',{frequency},'EXPORT DATA');
}
function productGroupSheet(id){
 const group=productGroups.find(item=>item.id===id);if(!group)return;
 const options=productGroups.filter(item=>item.brand===group.brand&&item.id!==group.id).map(item=>'<option value="'+item.id+'">'+esc(item.canonicalName)+'</option>').join('');
 openSheet(group.canonicalName,'<p class="description">'+esc(group.brand)+' · '+group.variants.length+' 个独立69码规格</p><label class="field"><span>标准产品名</span><input id="group-canonical" value="'+esc(group.canonicalName)+'" maxlength="110"></label><label class="field"><span>产品别名</span><textarea id="group-aliases" rows="3" placeholder="每行一个别名">'+esc((group.aliases||[]).join('\n'))+'</textarea><small>用于搜索和模糊候选，不会改变 NAS 文件夹名。</small></label><div class="sheet-actions">'+button('保存产品系列','product-group-save','data-group="'+group.id+'"',true)+'</div><div class="group-variants"><h3>69码与规格</h3>'+group.variants.map(variant=>'<div class="group-variant"><div><strong>'+esc(variant.code)+'</strong><p>'+esc(variant.name)+(variant.spec?' · '+esc(variant.spec):' · 规格未标注')+'</p></div><label><span>移动到</span><select id="move-'+variant.code+'"><option value="">选择产品系列</option>'+options+'<option value="new">拆分为新产品系列</option></select></label>'+button('移动','product-variant-move','data-group="'+group.id+'" data-code="'+variant.code+'"')+'</div>').join('')+'</div>',{groupId:id},'PRODUCT FAMILY');
}
async function pickDraft(){
 const draft=await api('draft-pick');if(!draft)return;
 dialogContext={draft};
 $('#draft-summary').innerHTML='<div class="file-summary" style="margin-top:20px"><b>'+esc(draft.filename)+'</b><br>'+draft.items.length+' 个事项 · '+fmt(draft.items.reduce((sum,i)=>sum+i.points,0))+' 点</div>';
 $('#sheet-body [data-command="import-submit"]').disabled=false;$('#sheet-error').hidden=true;
}
function sealSheet(id){
 if(uploadJob?.status==='running'){drawUpload();toast('已有产物正在后台上传，可在右下角查看进度');return}
 const t=data.tasks.find(t=>t.id===id);if(!t||t.sealed)return;const uploaded=(t.deliveries||[]).map(d=>'<span class="status-chip">'+icon('folder-check')+esc(d.categoryName||d.category)+'</span>').join('');
 openSheet('归档最终产物','<p class="description">'+esc(t.product)+' · '+esc(t.code)+' · 运营已确认完成</p>'+(uploaded?'<div class="notice"><span>已归档</span><div class="uploaded-types">'+uploaded+'</div></div>':'')+'<div id="product-resolution" class="product-resolution"><span class="spinner"></span>正在定位产品系列…</div><div class="notice" id="seal-spec">正在读取命名规则…</div><button id="asset-dropzone" class="upload-pick asset-dropzone" data-command="asset-pick" disabled>'+icon('folder-up')+'<strong>拖入总文件夹或单个类型文件夹</strong><span>总文件夹内按主图、SKU 等类型分文件夹，也可以点击选择</span></button><p class="upload-hint">按类型文件夹分类，上传前核对原名与目标名。主图按实际宽度分组编号，详情页保留原名；工程依赖整夹保留，本地文件不修改。</p><div id="asset-summary" aria-live="polite"></div><label class="check-line"><input id="self-check" type="checkbox" disabled><span>产品系列与69码定位正确，文件夹命名正确，源文件可编辑，最终产物与运营确认内容一致。</span></label><div id="upload-progress" hidden><div class="progress-label"><span id="progress-phase">准备上传</span><b id="progress-value">0%</b></div><div class="progress-track"><div id="progress-bar" style="width:0%"></div></div></div><div class="sheet-actions">'+button('确认命名并上传','asset-upload','disabled',true)+((t.deliveries||[]).length?button(icon('folder-open')+'文件存放位置','task-asset-location','data-task="'+id+'"'):'')+((t.deliveries||[]).length?button('全部产物已上传，完成封存','archive-finish','data-task="'+id+'"'):'')+'</div>',{taskId:id},'ARCHIVE');
 loadSpec();
}
function productDecisionReady(context){return !context?.productMatch?.decisionRequired||!!context.productDecision}
function productResolutionHtml(match){
 const iconName=match.status==='exact'?'badge-check':match.status==='fuzzy'?'list-checks':match.status==='same-series'?'git-branch-plus':'folder-plus',tone=match.status==='exact'?'exact':match.status==='fuzzy'?'fuzzy':match.status==='same-series'?'series':'new';
 let control='';
 if(match.decisionRequired){
  const placeholder=match.status==='fuzzy'?'<option value="">请选择正确产品系列</option>':'';
  control='<label class="field product-choice"><span>产品系列</span><select id="product-group-choice">'+placeholder+match.candidates.map(group=>'<option value="'+group.id+'" '+(group.id===match.recommendedGroupId?'selected':'')+'>'+esc(group.brand+' · '+group.canonicalName)+'（'+group.variantCount+' 个规格）'+(group.score?' · '+group.score+'% 相似':'')+'</option>').join('')+'<option value="new">这是独立的新产品</option></select></label>';
 }
 return '<div class="product-resolution-head '+tone+'"><span>'+icon(iconName)+'</span><div><strong>'+esc(match.message)+'</strong><p>将写入 <b>'+esc(match.destinationName)+'</b></p></div></div>'+control+(match.status==='same-series'?'<p class="product-resolution-note">已默认选择同名产品系列；新69码仍会建立独立规格目录。</p>':match.status==='fuzzy'?'<p class="product-resolution-note">名称相似不会自动合并，请确认后再选择文件。</p>':'');
}
async function loadSpec(){
 if(!dialogContext?.taskId)return;
 const context=dialogContext,request=Symbol();context.specRequest=request;context.selection=null;context.spec=null;
 $('#self-check').checked=false;$('#self-check').disabled=true;$('#asset-summary').innerHTML='';$('#sheet-body [data-command="asset-upload"]').disabled=true;$('#asset-dropzone').disabled=true;
 $('#seal-spec').textContent='正在读取命名规则…';$('#sheet-error').hidden=true;
 try{
  const spec=await api('archive-spec',{taskId:context.taskId});
  if(dialogContext!==context||context.specRequest!==request)return;
  if(spec.folderUploadVersion!==2||!spec.productMatch)throw Error('请同时更新负责人端和设计端');
  context.spec=spec;context.productMatch=spec.productMatch;context.productDecision=spec.productMatch?.status==='same-series'?{mode:'group',groupId:spec.productMatch.recommendedGroupId}:null;
  $('#product-resolution').innerHTML=productResolutionHtml(spec.productMatch);$('#seal-spec').innerHTML='<span>交付文件夹命名</span><strong class="delivery-name">'+esc(spec.basePrefix)+'产物类型</strong><span>可选：'+spec.categories.map(c=>esc(c.output)).join('、')+'。日期可用实际交付日期（MMDD），不必与运营确认日一致。</span>';
  $('#asset-dropzone').disabled=!productDecisionReady(context);icons();
 }catch(e){if(dialogContext===context&&context.specRequest===request){$('#product-resolution').textContent='产品定位未完成';$('#seal-spec').innerHTML='<span>暂时无法读取上传规则，请处理下方原因后重试。</span>'+button('重新定位','archive-retry');errorBox(e.message)}}
}
async function chooseDelivery(droppedFiles){
 const context=dialogContext;if(!context?.spec||context.busy||context.uploading)return;
 context.busy=true;context.selection=null;const zone=$('#asset-dropzone'),before=zone.innerHTML;
 zone.disabled=true;zone.classList.remove('drag-over');zone.innerHTML='<span class="spinner"></span><strong>正在识别文件夹…</strong>';
 $('#self-check').checked=false;$('#self-check').disabled=true;$('#sheet-body [data-command="asset-upload"]').disabled=true;$('#asset-summary').innerHTML='';$('#sheet-error').hidden=true;
 try{
  const payload={taskId:context.taskId,productDecision:context.productDecision};
  let selection;
  if(droppedFiles){const result=await window.workbench.dropAssets(droppedFiles,payload);if(!result.ok)throw Error(result.error);selection=result.value}
  else selection=await api('asset-pick',payload);
  if(dialogContext!==context||!selection)return;
  context.selection=selection;$('#self-check').disabled=false;
  const sources=selection.files.filter(f=>f.kind==='source'),outputs=selection.files.filter(f=>f.kind==='output');
  $('#asset-summary').innerHTML='<div class="delivery-summary"><strong>'+esc(selection.folder)+'</strong><div class="delivery-counts"><div>'+icon('image')+'<b>'+outputs.length+'</b><span>'+(selection.spec.category==='video'?'视频产物':'图片产物')+'</span></div><div>'+icon('files')+'<b>'+sources.length+'</b><span>源文件</span></div></div>'+(selection.projectFolders.length?'<p>'+icon('folder-check')+'整夹保留：'+selection.projectFolders.map(esc).join('、')+'</p>':'')+'<p>共 '+(selection.categoryCount||1)+' 类待上传。源文件和完整工程放入「01.源文件」，图片产物文件夹放入「02.导出图片」。</p>'+(selection.skipped?.length?'<p>已归档，跳过：'+selection.skipped.map(esc).join('、')+'</p>':'')+'<details open><summary>核对命名与归类清单</summary><ul>'+selection.files.map(f=>'<li><span>'+(f.kind==='source'?'源文件':'产物')+'</span>'+esc(f.previewFrom||f.relativePath)+' → '+esc(f.previewTo||f.relative)+'</li>').join('')+'</ul></details></div>';icons();
 }catch(e){if(dialogContext===context)errorBox(e.message)}
 finally{context.busy=false;if(dialogContext===context){zone.disabled=false;zone.innerHTML=before;icons()}}
}
async function run(element,fn){
 const before=element?.innerHTML;if(element){element.disabled=true;element.innerHTML='<span class="spinner"></span>'+ (element.textContent.trim()||'处理中')}
 try{return await fn()}catch(e){errorBox(e.message);return null}finally{if(element?.isConnected){element.disabled=false;element.innerHTML=before;icons()}}
}
async function taskAction(t,action,extra={}){
 try{await api('action',{taskId:t.id,action,version:t.version,...extra})}catch(e){
  if(manager())throw e;
  const locked=/Excel 正在编辑|正在被 Excel 占用|EBUSY|共享冲突/i.test(e.message),label=({start:'开始设计',review:'提交待确认',rework:'恢复设计',pause:'暂停计时',resume:'继续计时'})[action]||'更新任务';
  const message=locked?'流转未完成：请先保存并关闭此需求表的 Excel 窗口，刷新同步后重试。若仍失败，请检查是否被他人占用或没有写入权限。':'流转未确认成功：'+e.message+'。请先刷新核对任务状态，再重试。';
  flowReminders.set(t.id,{state:t.state,message});render();
  openSheet(label+'未完成','<div class="form-error" role="alert">'+esc(message)+'</div><p class="description">实际原因：'+esc(e.message)+'</p><p class="description">需求表：'+esc(t.filename||taskName(t))+'</p><p class="description">所在状态：'+esc(states[t.state])+'</p><p class="description">'+(locked?'关闭 Excel 后，点击工作台右上角的刷新按钮，核对状态后再次操作。程序不会自动关闭 Excel，也不会替你丢弃未保存的内容。':'失败原因：'+esc(e.message))+'</p><div class="sheet-actions">'+button('知道了','close-sheet','',true)+'</div>',{kind:'flow-reminder',taskId:t.id},'流转提醒');return;
 }
 flowReminders.delete(t.id);const updated=await api('snapshot');accept(updated);closeSheet();
 const card=$('[data-card="'+t.id+'"]');if(card&&lastInput==='pointer')card.classList.add('arrival');
 toast(({rollback:'已回退，原需求表和任务状态已同步',assign:'已分配，设计端将收到提醒',start:'已开始设计，需求表已流转',review:'已进入待确认',pause:'计时已暂停',resume:'已继续计时',rework:'已恢复设计',approve:'已完结，设计端可以上传封存'})[action]||'已更新');
}
function accept(snapshot){data=snapshot;clockOffset=snapshot.serverTime?snapshot.serverTime-Date.now():clockOffset;if(first){view=manager()?'team':'tasks';first=false}render()}
document.addEventListener('pointerdown',()=>lastInput='pointer',{passive:true});document.addEventListener('keydown',()=>lastInput='keyboard');
document.addEventListener('dragover',e=>{
 if(!Array.from(e.dataTransfer?.types||[]).includes('Files'))return;
 e.preventDefault();const zone=e.target.closest?.('#asset-dropzone');
 e.dataTransfer.dropEffect=zone&&!zone.disabled?'copy':'none';
 $('#asset-dropzone')?.classList.toggle('drag-over',!!zone&&!zone.disabled);
});
document.addEventListener('dragleave',e=>{const zone=e.target.closest?.('#asset-dropzone');if(zone&&!zone.contains(e.relatedTarget))zone.classList.remove('drag-over')});
document.addEventListener('drop',e=>{
 if(!Array.from(e.dataTransfer?.types||[]).includes('Files'))return;
 e.preventDefault();const zone=e.target.closest?.('#asset-dropzone');$('#asset-dropzone')?.classList.remove('drag-over');
 if(zone&&!zone.disabled)chooseDelivery(Array.from(e.dataTransfer.files));
});
const isSearch=el=>['task-search','asset-search','product-search'].includes(el?.id);
document.addEventListener('compositionstart',e=>{if(isSearch(e.target))composingSearch=true});
document.addEventListener('compositionend',e=>{if(isSearch(e.target)){composingSearch=false;query=e.target.value;render()}});
document.addEventListener('input',e=>{if(isSearch(e.target)){query=e.target.value;if(!e.isComposing&&!composingSearch)render()}});
document.addEventListener('change',async e=>{
 if(e.target.id==='asset-person'){assetPerson=e.target.value;render();return}
 if(e.target.id==='asset-date'){assetDate=e.target.value;render();return}
 if(e.target.id==='product-group-choice'){
  dialogContext.productDecision=e.target.value?(e.target.value==='new'?{mode:'new'}:{mode:'group',groupId:e.target.value}):null;
  $('#asset-dropzone').disabled=!productDecisionReady(dialogContext);$('#self-check').checked=false;$('#self-check').disabled=true;$('#sheet-body [data-command="asset-upload"]').disabled=true;$('#asset-summary').innerHTML='';return;
 }
 if(e.target.id==='self-check'){$('#sheet-body [data-command="asset-upload"]').disabled=!(e.target.checked&&dialogContext?.selection);return}
 if(e.target.dataset.preference)try{await api('preferences',{[e.target.dataset.preference]:e.target.checked})}catch(err){toast(err.message,true)}
});
document.addEventListener('submit',e=>{
 e.preventDefault();const form=e.target,submit=form.querySelector('[type="submit"]');
 if(form.id==='pair-form')run(submit,async()=>{try{accept(await api('pair',{code:$('#pair-code-input').value.trim()}))}catch(err){$('#pair-error').textContent=err.message;$('#pair-error').hidden=false}});
 if(form.id==='nas-form')run(submit,async()=>{try{await api('configure',{taskRoot:$('#task-root').value.trim(),assetRoot:$('#asset-root').value.trim()});accept(await api('snapshot'));toast('已连接现有 NAS，可以导入需求')}catch(err){$('#nas-error').textContent=err.message;$('#nas-error').hidden=false}});
});
document.addEventListener('click',async e=>{
 const calendar=e.target.closest('[data-calendar]');if(calendar&&!calendar.disabled){window.workbenchCalendar.open({value:calendar.value,mode:calendar.dataset.calendar==='asset'?assetPeriod:calendar.dataset.mode,animate:lastInput==='pointer',onChange:value=>{if(calendar.dataset.calendar==='asset'){assetDate=value;render();$('#asset-date')?.focus({preventScroll:true})}else{calendar.value=value;calendar.innerHTML=esc(value)+icon('calendar-days');icons()}}});return}
 const period=e.target.closest('[data-period]');if(period){assetPeriod=period.dataset.period;render();return}
 const el=e.target.closest('button');if(!el||el.disabled)return;if(el.dataset.view){navigate(el.dataset.view);return}if(el.dataset.filter!==undefined){filter=el.dataset.filter;render();return}
 const command=el.dataset.command,t=data.tasks.find(t=>t.id===el.dataset.task);
 if(command==='archive-retry'){await loadSpec();return}
 if(command==='close-sheet'){closeSheet();return}
 if(command==='index-refresh'){await loadPage(view,true);return}
 if(command==='upload-dismiss'){if(uploadJob?.status!=='running'){uploadJob=null;drawUpload()}return}
 if(command==='upload-task'){sealSheet(uploadJob.taskId);return}
 if(command==='person-tasks'){view='tasks';person=el.dataset.person;filter='all';query='';render({animate:true});return}
 if(command==='back-team'){navigate('team');return}
 if(command==='settings-shortcut'){navigate('settings');return}
 if(command==='task-detail'||command==='open-new'){taskDetail(el.dataset.task);return}
 if(command==='pair-person'){pairPerson(el.dataset.person);return}
 if(command==='import-open'){importSheet();return}
 if(command==='report-open'){reportSheet(el.dataset.frequency);return}
 if(command==='product-group-open'){productGroupSheet(el.dataset.group);return}
 if(command==='seal-open'){sealSheet(el.dataset.task);return}
 if(command==='re-pair'){data.requiresPairing=true;render();return}
 if(command==='rollback-open'){
  const target=t.sealed?'待封存':states[t.state-1],description=t.sealed?'撤销完成封存标记，保留已上传文件，可以继续补传。':t.state===4?'撤销运营确认、评分及当前封存关联，原交付文件保留为历史。若需要设计师修改，再回退一次到设计中。':t.state===3?'清除本次提交时间、确认和评分，恢复设计计时。设计师修改后重新提交，运营重新确认。':t.state===2?'停止计时，清除本次开始、提交和确认时间；累计设计耗时保留，设计师可重新开始。':'撤销分配和后续环节记录，需求回到待分配。';
  openSheet('回退到'+target,'<p class="description">'+esc(taskName(t))+'</p><div class="notice">'+esc(description)+'</div><p class="description">原需求表会同步移动并备份，操作保留历史记录。请先保存并关闭 Excel。</p><div class="sheet-actions">'+button('取消','close-sheet')+button('确认回退到'+target,'rollback-confirm','data-task="'+t.id+'"',true)+'</div>',{taskId:t.id,rollbackVersion:t.version},'ROLLBACK');return;
 }
 if(command==='approve-open'){
  openSheet('确认本次设计已完成','<p class="description">'+esc(taskName(t))+' · '+fmt(points(t))+' 点</p><div class="notice">确认后，原需求表将流转到「5.已完结」，设计师随后上传最终产物封存。</div><label class="check-line"><input id="chat-confirmed" type="checkbox"><span>运营已在聊天中确认完成，由我记录本次确认。</span></label><div class="sheet-actions">'+button('确认完成','approve-confirm','data-task="'+t.id+'"',true)+'</div>',{taskId:t.id},'COMPLETE TASK');return;
 }
 if(command==='pause-open'){
  openSheet('暂停设计计时','<label class="field"><span>暂停原因</span><select id="pause-reason">'+['等待素材','等待需求补充','插单中断','暂时离开'].map(s=>'<option>'+s+'</option>').join('')+'</select></label><div class="sheet-actions">'+button('确认暂停','pause-confirm','data-task="'+t.id+'"',true)+'</div>',{taskId:t.id},'PAUSE');return;
 }
 if(command==='reassign-open'){
  openSheet('改派任务','<p class="description">'+esc(taskName(t))+' · 保留原设计记录，通知新的设计师。</p><label class="field"><span>新的设计负责人</span><select id="reassign-person">'+data.people.filter(p=>!p.removed).map(p=>'<option value="'+p.id+'" '+(p.id===t.owner?'disabled':'')+'>'+esc(p.name)+'</option>').join('')+'</select></label><div class="sheet-actions">'+button('确认改派','reassign-confirm','data-task="'+t.id+'"',true)+'</div>',{taskId:t.id},'REASSIGN');return;
 }
 await run(el,async()=>{
  if(command==='refresh'||command==='refresh-completed'){
   const sync=data.workbookSyncVersion===1?await api('sync-requirements',{includeCompleted:command==='refresh-completed'}):null;if(view==='assets')assets=await api('assets');accept(await api('snapshot'));
   const details=[];if(sync?.imported)details.push('新导入 '+sync.imported+' 份');if(sync?.relinked)details.push('重新关联 '+sync.relinked+' 份改名需求');if(sync?.repaired)details.push('修复 '+sync.repaired+' 个重复任务');if(sync?.assetsReopened)details.push(sync.assetsReopened+' 个任务恢复待封存');
   toast(sync?.error||(!sync||sync.checked===false?'尚未检查 NAS，请确认负责人服务已连接':details.length?'NAS 检查完成：'+details.join('，'):command==='refresh-completed'?'已完结需求及归档文件已重新检查':'进行中任务已刷新；已完结内容保留缓存'),!!sync?.error||!sync||sync.checked===false)
  }
  else if(command==='asset-scope'){assetScope=el.dataset.scope;render()}
  else if(command==='test-notification'){await api('test-notification');toast('已发送测试提醒；声音遵循当前开关和 Windows 通知设置')}
  else if(command==='scan'){const result=await api('scan');accept(await api('snapshot'));toast('已导入 '+result.imported+' 份需求'+(result.issues.length?'，'+result.issues.length+' 份需要更正':''));if(result.issues.length)navigate('settings')}
  else if(command==='draft-pick')await pickDraft();
  else if(command==='import-submit'){
   await api('import',{draftId:dialogContext.draft.id});closeSheet();accept(await api('snapshot'));await navigate('tasks');toast('需求已上传到待分配');
  }
  else if(command==='report-export'){
   const result=await api('export-report',{frequency:dialogContext.frequency,anchor:$('#report-anchor').value});
   if(result){closeSheet();toast('已导出 '+result.label+' 数据：'+result.counts.tasks+' 个任务，'+result.counts.items+' 个事项')}
  }
  else if(command==='product-group-save'){
   await api('product-group-update',{groupId:el.dataset.group,canonicalName:$('#group-canonical').value,aliases:$('#group-aliases').value});productGroups=await api('product-groups');closeSheet();render();toast('产品系列已更新');
  }
  else if(command==='product-variant-move'){
   const targetGroupId=$('#move-'+el.dataset.code).value;if(!targetGroupId)throw Error('请选择目标产品系列');productGroups=await api('product-variant-move',{code:el.dataset.code,targetGroupId});closeSheet();render();toast('69码归组已更新');
  }
  else if(command==='rollback-confirm'){await taskAction({...t,version:dialogContext.rollbackVersion},'rollback',{confirmed:true})}
  else if(command==='assign')await taskAction(t,'assign',{owner:$('[data-assignee="'+t.id+'"]').value});
  else if(['start','resume','review','rework'].includes(command))await taskAction(t,command);
  else if(command==='pause-confirm')await taskAction(t,'pause',{reason:$('#pause-reason').value});
  else if(command==='reassign-confirm')await taskAction(t,'assign',{owner:$('#reassign-person').value});
  else if(command==='approve-confirm')await taskAction(t,'approve',{chatConfirmed:$('#chat-confirmed').checked});
  else if(command==='copy-code'){await api('copy',{text:dialogContext.code});toast('连接码已复制')}
  else if(command==='member-remove'){const p=data.people.find(p=>p.id===el.dataset.person);openSheet('移出 '+p.name,'<p class="description">移出后，该成员所有设备和旧连接码都会失效，不再显示于人员看板和分配名单。历史任务和资产保留。</p><div class="sheet-actions">'+button('取消','close-sheet')+button('确认移出','member-remove-confirm','data-person="'+p.id+'"',true)+'</div>',{personId:p.id},'REMOVE MEMBER')}
  else if(command==='member-remove-confirm'){await api('member-remove',{personId:el.dataset.person});closeSheet();accept(await api('snapshot'));toast('已移出成员，所有旧连接已停用')}
  else if(command==='manager-connect'){const code=$('#manager-connection-code').value.trim();managerConnectionStatus='正在连接主机并验证管理权限，请稍候…';$('#manager-connect-status').textContent=managerConnectionStatus;try{const snapshot=await api('manager-connect',{code});managerConnectionStatus='已切换为管理连接端';accept(snapshot);toast('已连接负责人主机')}catch(e){managerConnectionStatus='连接未完成：'+e.message;const status=$('#manager-connect-status');if(status)status.textContent=managerConnectionStatus;throw e}}
  else if(command==='manager-code'){const r=await api('manager-pair-code',{host:$('#manager-host').value});openSheet('管理连接码','<p class="description">此码授予任务管理权限，一次有效，一小时内使用。请仅交给需要管理权限的人。</p><textarea class="connection-code" readonly>'+esc(r.code)+'</textarea>',{},'MANAGEMENT CONNECTION')}
  else if(command==='manager-revoke-open'){openSheet('停用远程管理连接','<p class="description">所有已连接的远程管理电脑和未使用的管理连接码都将失效。本机继续运行。</p><div class="sheet-actions">'+button('取消','close-sheet')+button('确认停用','manager-revoke','',true)+'</div>',{},'REVOKE ACCESS')}
  else if(command==='manager-revoke'){await api('manager-revoke');closeSheet();toast('远程管理连接已停用')}
  else if(command==='revoke'){await api('revoke',{personId:el.dataset.person});closeSheet();accept(await api('snapshot'));toast('该人员的旧设备已解除绑定')}
  else if(command==='duplicate-inspect'){
   const plan=await api('duplicate-inspect',{taskId:t.id});openSheet('修复重复任务','<p class="description">已核对唯一原表与两条任务内容。修复后保留有效任务，重复项及其历史会备份；NAS 原表保持不变。</p><dl>'+[['保留任务',plan.keep.title||plan.keep.product],['设计师',peopleName(plan.keep.owner)],['保留记录分配时间',dateTime(plan.keep.assignedAt)],['移除重复记录分配时间',dateTime(plan.duplicate.assignedAt)],['原需求表',plan.keep.filename]].map(([k,v])=>'<div class="summary-line"><dt>'+k+'</dt><dd>'+esc(v)+'</dd></div>').join('')+'</dl><div class="sheet-actions">'+button('取消','close-sheet')+button('备份并修复重复项','duplicate-repair','',true)+'</div>',{duplicatePlan:plan},'REPAIR');
  }
  else if(command==='duplicate-repair'){
   const p=dialogContext.duplicatePlan;await api('duplicate-repair',{taskId:p.duplicate.id,keepId:p.keep.id,version:p.duplicate.version,keepVersion:p.keep.version,hash:p.hash});closeSheet();accept(await api('snapshot'));toast('已保留有效任务，重复项及历史已备份');
  }
  else if(command==='asset-pick')await chooseDelivery();
  else if(command==='asset-upload'){
   const context=dialogContext,selection=context.selection;if(!selection||uploadJob?.status==='running')return;
   const selfChecked=$('#self-check').checked,job={taskId:context.taskId,title:taskName(data.tasks.find(t=>t.id===context.taskId)||{}),status:'running',phase:'准备上传',percent:0};uploadJob=job;closeSheet();drawUpload();
   try{const result=await api('asset-upload',{selectionId:selection.selectionId,selfChecked});if(result?.pending){job.status='waiting';job.uploadId=result.uploadId;job.phase='等待负责人端自动重试';job.error=result.reason;drawUpload();toast(result.reason);return}job.status='done';job.phase='归档完成';job.percent=100;drawUpload();toast('所选产物已归档，交付地址已回填');try{accept(await api('snapshot'))}catch(e){toast('上传已完成，任务刷新失败：'+e.message,true)}}
   catch(e){job.status='error';job.phase='请检查后重试';job.error=e.message;drawUpload();toast('上传未完成：'+e.message,true)}

  }
  else if(command==='archive-reopen'){
   openSheet('恢复待封存','<p class="description">'+esc(taskName(t))+'</p><div class="notice">已上传的文件和记录会保留。恢复后，设计师可以继续补传；需求表仍在「5.已完结」，不重新计算设计耗时。</div><div class="sheet-actions">'+button('取消','close-sheet')+button('确认恢复待封存','archive-reopen-confirm','data-task="'+t.id+'"',true)+'</div>',{taskId:t.id,reopenVersion:t.version},'RESTORE ARCHIVE');
  }
  else if(command==='archive-reopen-confirm'){await api('archive-reopen',{taskId:t.id,version:dialogContext.reopenVersion});closeSheet();accept(await api('snapshot'));toast('已恢复待封存，设计师可以继续补传')}
  else if(command==='archive-finish'){await api('archive-finish',{taskId:t.id,version:t.version});closeSheet();accept(await api('snapshot'));toast('全部产物已完成封存')}
  else if(command==='open-requirement'){if(data.workbookSyncVersion!==1)throw Error('请先将负责人端更新至 0.2.4，再打开可同步的 NAS 原表');await api('open-requirement',{taskId:el.dataset.task});toast('已打开 NAS 原表；修改后请保存并关闭 Excel，自动同步流转')}
  else if(command==='task-asset-location'){await api('task-asset-location',{taskId:el.dataset.task});toast('已打开该产品的封存目录')}
  else if(command==='open-asset')await api('open-asset',{assetId:el.dataset.asset});
  else if(command==='pick-root'){const selected=await api('pick-root');if(selected)document.getElementById(el.dataset.field).value=selected}
  else if(command==='backup'){await api('backup');toast('任务记录已备份到 NAS')}
  else if(command==='recover'){await api('recover');accept(await api('snapshot'));toast('已重新检查文件同步')}
 });
});
$('#sheet').addEventListener('cancel',e=>{e.preventDefault();closeSheet()});
let assetLoad=0;
window.workbench?.onChange(snapshot=>{accept(snapshot);if(uploadJob?.status==='waiting'&&snapshot.tasks?.find(t=>t.id===uploadJob.taskId)?.deliveries?.some(d=>d.id===uploadJob.uploadId)){uploadJob.status='done';uploadJob.phase='已完成等待中的类别';uploadJob.percent=100;drawUpload();toast('等待中的类别已归档；如有其他类别，请继续选择上传')} if(view==='assets'){const load=++assetLoad;api('assets',{recordsOnly:true}).then(records=>{if(load===assetLoad&&view==='assets'){assets=records;render()}}).catch(e=>toast('资产记录刷新失败：'+e.message,true))}});
window.workbench?.onSyncStatus?.(status=>{data.workbookSync=status;syncBadge()});
window.workbench?.onOpenTask(id=>{if(dialogContext?.uploading){toast('收到新任务，当前产物封存完成后可查看');return}taskDetail(id)});
window.workbench?.onProgress(progress=>{if(uploadJob?.status!=='running')return;uploadJob.phase=progress.phase;uploadJob.percent=Math.max(0,Math.min(100,Number(progress.percent)||0));drawUpload()});
setInterval(()=>{document.querySelectorAll('[data-clock]').forEach(el=>{const task=data.tasks.find(t=>t.id===el.dataset.clock);if(task)el.innerHTML=timing(task)})},1000);
(async()=>{try{if(!window.workbench)throw Error('请通过已安装的负责人端或设计端打开工作台');accept(await api('snapshot'));window.workbench.ready()}catch(e){$('#main').innerHTML=empty('工作台暂未连接',esc(e.message));icons()}})();
})();
