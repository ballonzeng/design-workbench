'use strict';
const crypto=require('node:crypto');
const {resetArchive}=require('./archive-state.cjs');
const PEOPLE=[
  {id:'zeng',name:'曾祥鹏',title:'负责人'},
  {id:'lv',name:'吕慧芸',title:'设计师'},
  {id:'zhu',name:'朱文梅',title:'设计师'},
  {id:'hong',name:'洪华',title:'设计师'},
  {id:'chang',name:'常慧杰',title:'设计师'},
  {id:'qiu',name:'仇宇航',title:'设计师'},
  {id:'jiang',name:'江雨婷',title:'设计师'},
  {id:'liu',name:'刘先姗',title:'设计师'}
];
const STAGES=['1.待分配','2.待设计','3.设计中','4.待确认','5.已完结'];
const CATEGORIES=[
  {id:'main',name:'主图',folder:'02.主图',output:'主图'},
  {id:'sku',name:'SKU',folder:'03.SKU',output:'SKU'},
  {id:'detail',name:'详情页',folder:'04.详情页',output:'详情页'},
  {id:'six',name:'六面图',folder:'01.六面图',output:'六面图'},
  {id:'creative',name:'创意图',folder:'05.创意图',output:'创意图'},
  {id:'video',name:'创意视频',folder:'06.创意视频',output:'创意视频'},
  {id:'project',name:'工程',folder:'00.产品素材-工程',output:'工程'}
];
const RATE_ROWS=[
 ['simple','简单信息修改',.15,'张'],
 ['stamp','盖章/添加广审号',.1,'事项'],
 ['resize','图片尺寸适配',.4,'张'],
 ['cutout','现成白底抠图',.1,'张'],
 ['photo','实拍白底图（单张）',.3,'张'],
 ['photo-six','实拍白底图（六面）',.2,'张',0,0,6],
 ['model-six','建模白底图（六面）',.5,'张',0,0,6],
 ['complex','单图任务（复杂元素替换）',1.5,'张'],
 ['basic','单图任务（基础元素替换）',.8,'张'],
 ['creative','创意图',2,'张'],
 ['video-image','现图生成创意视频',.3,'条'],
 ['video-basic','基础替换创意视频',1.1,'条'],
 ['video-zero','零基础创意视频',2,'条'],
 ['detail-adjust','详情页套图调整',.25,'张'],
 ['main-set','主图套图调整',.3,'张'],
 ['sku-set','SKU套图调整',.25,'张'],
 ['creative-adjust','创意图套图调整',.25,'张'],
 ['sku-full','完整SKU精做',.5,'张'],
 ['main-full','完整主图精做',.8,'张'],
 ['detail-full','完整详情页精做',1.5,'屏'],
 ['live-text','达播文字修改内容',.15,'张'],
 ['live-size','达播尺寸适配',.4,'张'],
 ['live-create','达播内容制作',1,'张']
];
const RATES=RATE_ROWS.map(([id,name,points,unit,base=0,extra=0,min=1])=>({id,name,points,unit,base,extra,min}));
const normalize=v=>String(v??'').replace(/\s+/g,'').replace(/[()]/g,x=>x==='('?'（':'）');
function fail(message,status=400){const e=new Error(message);e.status=status;throw e}
function safeName(value,label='名称'){
  if(typeof value!=='string'||value!==value.trim()||!value||value.length>110||/[<>:"/\\|?*\x00-\x1f]/.test(value)||/[. ]$/.test(value)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)||value==='.'||value==='..')fail(label+'不符合文件夹命名要求');
  return value;
}
function validCode(code){return /^69\d{11}$/.test(String(code))}
function rateFor(name){const r=RATES.find(r=>normalize(r.name)===normalize(name)||r.id===name);if(!r)fail('事项类型未匹配贡献标准：'+name);return r}
function itemPoints(item){const r=rateFor(item.type);if(!Number.isInteger(item.qty)||item.qty<r.min||item.qty>10000)fail('数量不符合事项标准：'+r.name);const extra=item.extra||0;if(!Number.isInteger(extra)||extra<0||extra>10000||(!r.base&&extra))fail('超出张数无效');return Math.round((r.points*item.qty+r.extra*extra)*100)/100}
function parts(now=Date.now()){const d=new Date(now+8*3600000);return {year:d.getUTCFullYear(),month:String(d.getUTCMonth()+1).padStart(2,'0'),day:String(d.getUTCDate()).padStart(2,'0'),hour:d.getUTCHours()}}
function dayValues(now){const p=parts(now);return [Math.round((Date.UTC(p.year,Number(p.month)-1,Number(p.day))-Date.UTC(1899,11,30))/86400000),p.hour]}
function monthKey(now){const p=parts(now);return p.year+'-'+p.month}
function stamp(now){const p=parts(now);return String(p.year).slice(-2)+p.month+p.day+String(p.hour).padStart(2,'0')}
function total(t){return Math.round(t.items.reduce((a,i)=>a+itemPoints(i),0)*100)/100}
function elapsed(t,now=Date.now()){return (t.elapsedMs||0)+(t.runningSince?Math.max(0,now-t.runningSince):0)}
function inferredCategory(type,sheets=[]){
 const n=normalize(type);
 if(/六面|建模白底/.test(n))return 'six';
 if(/SKU/.test(n))return 'sku';
 if(/详情/.test(n))return 'detail';
 if(/视频/.test(n))return 'video';
 if(/创意图/.test(n))return 'creative';
 if(/主图/.test(n))return 'main';
 const exact=CATEGORIES.filter(c=>sheets.includes(c.name));if(exact.length)return exact.length===1?exact[0].id:null;
 const matches=CATEGORIES.filter(c=>sheets.some(sheet=>{const s=normalize(sheet);return c.id==='sku'?/sku/i.test(s):c.id==='detail'?/详情/.test(s):c.id==='six'?/六面/.test(s):c.id==='creative'?/创意图|创图/.test(s):c.id==='video'?/视频/.test(s):c.id==='project'?/工程/.test(s):/主图/.test(s)}));
 return matches.length===1?matches[0].id:null;
}
function own(actor,t){if(actor.role!=='designer'||actor.personId!==t.owner)fail('只能操作分配给自己的任务',403)}
function manager(actor){if(actor.role!=='manager')fail('此操作仅负责人可用',403)}
function transition(task,actor,action,payload={},now=Date.now()){
 const t=structuredClone(task),patch={};
 if(task.blocked)fail('此任务存在未恢复的文件同步，请先在连接与维护中重试');
 if(payload.version!==t.version)fail('任务已更新，请刷新后重试',409);
 const date=dayValues(now),stop=()=>{t.elapsedMs=elapsed(t,now);t.runningSince=null};
 switch(action){
  case 'rollback':
   manager(actor);if(t.state===0)fail('已在待分配，不能继续回退',409);
   if(payload.confirmed!==true)fail('请确认回退目标及清理内容');
   if(t.sealed){t.sealed=false;delete t.sealedAt;delete t.sealedFromVersion;break}
   stop();t.state--;t.pauseReason=null;
   if(task.state===4){
    resetArchive(t,task,now);patch.L4='';
   }
   t.completedAt=null;t.completedMonth=null;t.completionFromFolder=false;
   for(const key of ['confirmedBy','confirmationMethod','completionTimeSource'])delete t[key];
   for(const key of ['M4','N4'])patch[key]='';
   if(t.state<3){t.reviewAt=null;for(const key of ['J4','K4'])patch[key]=''}
   if(t.state===2)t.runningSince=now;
   if(t.state<2){t.startedAt=null;for(const key of ['H4','I4'])patch[key]='';t.receivedAt=null;t.readAt=null}
   if(t.state===0){t.owner=null;t.assignedAt=null;t.assignmentId=null;t.requestedDesigner='未分配';for(const key of ['E4','F4','G4'])patch[key]=''}
   break;
  case 'assign':
   manager(actor);
   if(t.state===4)fail('已完结任务不能改派');
   if(!PEOPLE.some(p=>p.id===payload.owner))fail('请选择有效设计师');
   if(t.owner===payload.owner&&t.state!==0)fail('该任务已分配给此设计师');
   if(t.state===2)stop();
   t.owner=payload.owner;t.assignedAt=now;t.assignmentId=crypto.randomUUID();t.receivedAt=null;t.readAt=null;t.state=1;t.pauseReason=null;
   t.startedAt=null;t.reviewAt=null;t.completedAt=null;t.completedMonth=null;t.runningSince=null;
   for(const field of ['H4','I4','J4','K4','M4','N4'])patch[field]='';
   [patch.E4,patch.F4]=date;patch.G4=PEOPLE.find(p=>p.id===t.owner).name;
   break;
  case 'start':
   own(actor,t);if(t.state!==1)fail('当前任务不能开始设计',409);
   t.state=2;t.startedAt??=now;t.runningSince=now;t.pauseReason=null;
   if(!task.startedAt)[patch.H4,patch.I4]=date;break;
  case 'pause':
   own(actor,t);if(t.state!==2||!t.runningSince)fail('任务未在计时',409);
   if(!['等待素材','等待需求补充','插单中断','暂时离开'].includes(payload.reason))fail('请选择暂停原因');
   stop();t.pauseReason=payload.reason;break;
  case 'resume':
   own(actor,t);if(t.state!==2||t.runningSince)fail('任务未暂停',409);
   t.runningSince=now;t.pauseReason=null;break;
  case 'review':
   own(actor,t);if(t.state!==2)fail('仅设计中的任务可以提交确认',409);
   stop();t.state=3;t.reviewAt=now;t.pauseReason=null;[patch.J4,patch.K4]=date;break;
  case 'rework':
   own(actor,t);if(t.state!==3)fail('任务不在待确认阶段',409);
   t.state=2;t.runningSince=now;t.pauseReason=null;t.reviewAt=null;t.completedAt=null;t.completedMonth=null;
   for(const field of ['J4','K4','M4','N4'])patch[field]='';break;
  case 'approve':
   manager(actor);if(t.state!==3)fail('仅待确认任务可以完结',409);
   if(payload.chatConfirmed!==true)fail('请确认运营已在聊天中确认完成');
   t.state=4;t.completedAt=now;t.completedMonth=monthKey(now);t.completionFromFolder=false;t.completionTimeSource='app-confirmed';t.confirmedBy=actor.personId;t.confirmationMethod='负责人记录运营聊天确认';[patch.M4,patch.N4]=date;break;
  default:fail('不支持的任务操作');
 }
 t.updatedAt=now;t.version++;return {task:t,patch};
}
module.exports={PEOPLE,STAGES,CATEGORIES,RATES,normalize,fail,safeName,validCode,rateFor,itemPoints,parts,dayValues,monthKey,stamp,total,elapsed,inferredCategory,own,manager,transition};
