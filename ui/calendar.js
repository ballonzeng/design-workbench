'use strict';
(()=>{
const dialog=document.createElement('dialog');dialog.className='date-picker';dialog.setAttribute('aria-label','选择日期');document.body.append(dialog);
const content=document.createElement('div');content.className='calendar-content';dialog.append(content);
let cursor,chosen,mode,callback,trigger;
const key=d=>d.toISOString().slice(0,10),parse=s=>new Date(s+'T12:00:00Z');
function draw(focus){
 const y=cursor.getUTCFullYear(),m=cursor.getUTCMonth(),monthly=mode==='month',first=new Date(Date.UTC(y,m,1,12));
 const offset=(first.getUTCDay()+6)%7,start=new Date(+first-offset*86400000),selected=parse(chosen),weekStart=+selected-((selected.getUTCDay()+6)%7)*86400000;
 content.innerHTML='<div class="calendar-head"><button type="button" data-step="-1" aria-label="上一'+(monthly?'年':'月')+'">‹</button><h2>'+y+' 年'+(monthly?'':' '+(m+1)+' 月')+'</h2><button type="button" data-step="1" aria-label="下一'+(monthly?'年':'月')+'">›</button></div>'+
 (monthly?'<div class="calendar-months">'+Array.from({length:12},(_,i)=>{const value=y+'-'+String(i+1).padStart(2,'0')+'-01';return '<button type="button" data-date="'+value+'" aria-pressed="'+(chosen.slice(0,7)===value.slice(0,7))+'">'+(i+1)+' 月</button>'}).join('')+'</div>':'<div class="calendar-weekdays" aria-hidden="true">'+['一','二','三','四','五','六','日'].map(v=>'<span>'+v+'</span>').join('')+'</div><div class="calendar-days">'+Array.from({length:42},(_,i)=>{const d=new Date(+start+i*86400000),value=key(d),active=mode==='week'?+d>=weekStart&&+d<weekStart+7*86400000:value===chosen;return '<button type="button" data-date="'+value+'" class="'+(d.getUTCMonth()===m?'':'outside')+'" aria-label="'+value+'" aria-pressed="'+active+'" tabindex="'+(value===(focus||chosen)?0:-1)+'">'+d.getUTCDate()+'</button>'}).join('')+'</div>')+
 '<div class="calendar-footer"><span>'+(mode==='week'?'选择整周 · 周一至周日':monthly?'选择月份':'选择日期')+'</span><button type="button" data-today>今天</button><button type="button" data-close>取消</button></div>';
 const target=dialog.querySelector('[data-date="'+(focus||(monthly?chosen.slice(0,7)+'-01':chosen))+'"]')||dialog.querySelector('[data-date]');if(target){target.tabIndex=0;target.focus()}
}
function close(){dialog.close();trigger?.focus({preventScroll:true})}
function select(value){const done=callback;close();done(value)}
dialog.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-close'))close();else if(b.hasAttribute('data-today'))select(new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));else if(b.dataset.date)select(b.dataset.date);else if(b.dataset.step){cursor=new Date(Date.UTC(cursor.getUTCFullYear()+(mode==='month'?Number(b.dataset.step):0),cursor.getUTCMonth()+(mode==='month'?0:Number(b.dataset.step)),1,12));draw()}});
dialog.addEventListener('keydown',e=>{if(!e.target.dataset.date)return;const moves={ArrowLeft:-1,ArrowRight:1,ArrowUp:mode==='month'?-3:-7,ArrowDown:mode==='month'?3:7};if(!(e.key in moves))return;e.preventDefault();const d=parse(e.target.dataset.date);if(mode==='month')d.setUTCMonth(d.getUTCMonth()+moves[e.key]);else d.setUTCDate(d.getUTCDate()+moves[e.key]);cursor=d;draw(key(d))});
dialog.addEventListener('cancel',e=>{e.preventDefault();close()});
dialog.addEventListener('click',e=>{if(e.target!==dialog)return;const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)close()});
window.workbenchCalendar={open(options){chosen=options.value;cursor=parse(chosen);mode=options.mode;callback=options.onChange;trigger=document.activeElement;dialog.showModal();draw();if(options.animate!==false&&!matchMedia('(prefers-reduced-motion:reduce)').matches)content.animate([{opacity:0},{opacity:1}],{duration:180,easing:'cubic-bezier(.23,1,.32,1)'})}};
})();
