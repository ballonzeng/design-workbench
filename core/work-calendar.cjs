'use strict';
// Shanghai civil dates; no dependency on the host computer's timezone.
const DAY=86400000,HOUR=3600000,TZ=8*HOUR;
const SOURCE='https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html';
const HOLIDAYS=[['2026-01-01','2026-01-03'],['2026-02-15','2026-02-23'],['2026-04-04','2026-04-06'],['2026-05-01','2026-05-05'],['2026-06-19','2026-06-21'],['2026-09-25','2026-09-27'],['2026-10-01','2026-10-07']];
const MAKEUP=new Set(['2026-01-04','2026-02-14','2026-02-28','2026-05-09','2026-09-20','2026-10-10']);
const DEFAULT={dailyPoints:6.4,sessions:[['09:00','12:00'],['13:00','18:00']],exceptions:{}};
const dayKey=at=>new Date(at+TZ).toISOString().slice(0,10);
const midnight=date=>Date.parse(date+'T00:00:00+08:00');
const round=n=>Math.round(n*100)/100;
function validDate(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(midnight(value))&&dayKey(midnight(value))===value}
function minutes(value){if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))throw Error('有效时段请使用 HH:MM 格式');return Number(value.slice(0,2))*60+Number(value.slice(3))}
function validatePolicy(input){
 if(!input||typeof input!=='object'||!Number.isFinite(input.dailyPoints)||input.dailyPoints<=0||input.dailyPoints>1000)throw Error('每日目标点数须大于 0，且不超过 1000');
 if(!Array.isArray(input.sessions)||!input.sessions.length||input.sessions.length>6)throw Error('请填写 1 至 6 个有效工作时段');
 let previous=-1;for(const pair of input.sessions){if(!Array.isArray(pair)||pair.length!==2)throw Error('工作时段格式无效');const a=minutes(pair[0]),b=minutes(pair[1]);if(a>=b||a<previous)throw Error('工作时段不能重叠、倒序或跨天');previous=b}
 const exceptions=input.exceptions||{};if(typeof exceptions!=='object'||Array.isArray(exceptions)||Object.keys(exceptions).length>366)throw Error('工作日例外格式无效');
 for(const [date,working]of Object.entries(exceptions))if(!validDate(date)||typeof working!=='boolean')throw Error('工作日例外须填写有效日期及是否上班');
 return {dailyPoints:round(input.dailyPoints),sessions:input.sessions.map(p=>[...p]),exceptions:{...exceptions}};
}
function policyFor(date,policies={}){const key=Object.keys(policies).filter(k=>/^\d{4}-\d{2}$/.test(k)&&k<=date.slice(0,7)).sort().at(-1);return key?policies[key]:DEFAULT}
function dayInfo(date,policies={}){
 const policy=policyFor(date,policies),weekday=new Date(midnight(date)+TZ).getUTCDay(),known=date.startsWith('2026-'),override=Object.hasOwn(policy.exceptions||{},date);
 const holiday=HOLIDAYS.some(([a,b])=>date>=a&&date<=b),makeup=MAKEUP.has(date);
 const working=override?policy.exceptions[date]:known?(makeup||!holiday&&weekday!==0&&weekday!==6):weekday!==0&&weekday!==6;
 const hours=working?policy.sessions.reduce((n,[a,b])=>n+(minutes(b)-minutes(a))/60,0):0;
 return {date,working,hours,points:working?policy.dailyPoints:0,verified:known||override,reason:override?'公司调整':makeup?'调休上班':holiday?'法定放假安排':working?'工作日':'周末',policy};
}
function workSegments(from,to,policies={}){
 if(!Number.isFinite(from)||!Number.isFinite(to)||to<=from)return [];
 if(to-from>DAY*366*10)throw Error('统计时段过长');
 const result=[];for(let at=midnight(dayKey(from));at<to;at+=DAY){const day=dayInfo(dayKey(at),policies);if(!day.working)continue;for(const [a,b]of day.policy.sessions){const start=Math.max(from,at+minutes(a)*60000),end=Math.min(to,at+minutes(b)*60000);if(end>start)result.push({start,end,verified:day.verified,date:day.date})}}
 return result;
}
function workingMs(from,to,policies={}){return workSegments(from,to,policies).reduce((n,s)=>n+s.end-s.start,0)}
// Actual durations always exclude Shanghai Saturdays and Sundays. The planning
// calendar remains independent: a makeup weekend can still carry planned points.
function actualWorkSegments(from,to,policies={}){return workSegments(from,to,policies).filter(segment=>{const weekday=new Date(midnight(segment.date)+TZ).getUTCDay();return weekday!==0&&weekday!==6})}
function actualWorkingMs(from,to,policies={}){return actualWorkSegments(from,to,policies).reduce((n,s)=>n+s.end-s.start,0)}
function capacity(from,to,policies={},cutoff=to){
 const days=[];for(let at=midnight(dayKey(from));at<to;at+=DAY){const info=dayInfo(dayKey(at),policies),start=Math.max(at,from),end=Math.min(at+DAY,to),ms=workingMs(start,end,policies),elapsed=workingMs(start,Math.min(end,cutoff),policies),normal=info.hours*HOUR;days.push({date:info.date,working:info.working,verified:info.verified,reason:info.reason,hours:round(ms/HOUR),points:round(normal?info.points*ms/normal:0),elapsedHours:round(elapsed/HOUR),elapsedPoints:round(normal?info.points*elapsed/normal:0)})}
 const sum=key=>round(days.reduce((n,d)=>n+d[key],0));return {days,workdays:days.filter(d=>d.working).length,hours:sum('hours'),points:sum('points'),elapsedHours:sum('elapsedHours'),elapsedPoints:sum('elapsedPoints'),verified:days.every(d=>d.verified),source:SOURCE,timezone:'Asia/Shanghai'};
}
function trackedIntervals(task,cutoff){const entries=(task.workIntervals||[]).map(s=>({...s}));if(task.runningSince&&task.timingTracked)entries.push({start:task.runningSince,end:cutoff,owner:task.owner});return entries.filter(s=>Number.isFinite(s.start)&&Number.isFinite(s.end)&&s.end>s.start).map(s=>({...s,end:Math.min(s.end,cutoff)})).filter(s=>s.end>s.start)}
function taskTiming(task,from,to,policies={}){const intervals=task.recordOnly?[]:trackedIntervals(task,to).flatMap(s=>actualWorkSegments(Math.max(from,s.start),Math.min(to,s.end),policies).map(w=>({...w,owner:s.owner,taskId:task.id}))),ms=intervals.reduce((n,s)=>n+s.end-s.start,0);return {ms,hours:round(ms/HOUR),complete:!task.recordOnly&&task.timingTracked===true&&!task.timingIncomplete&&!task.importedTiming&&!task.externalTiming,intervals}}
function unionHours(intervals){let end=-Infinity,ms=0;for(const s of [...intervals].sort((a,b)=>a.start-b.start)){if(s.end>end){ms+=s.end-Math.max(s.start,end);end=s.end}}return round(ms/HOUR)}
module.exports={DEFAULT,SOURCE,DAY,HOUR,dayKey,midnight,validDate,validatePolicy,policyFor,dayInfo,workSegments,workingMs,actualWorkSegments,actualWorkingMs,capacity,trackedIntervals,taskTiming,unionHours};
