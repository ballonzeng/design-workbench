'use strict';
const W=require('./work-calendar.cjs');

// These are derived values. Never rewrite elapsedMs, timestamps or saved
// workIntervals: the raw records are needed for audit and future recalculation.
function taskDuration(task,{from=0,to=Date.now(),policies={}}={}){
 if(!task||typeof task!=='object'||!Number.isFinite(from)||!Number.isFinite(to)||to<from)throw Error('任务耗时的统计区间无效');
 const base={source:'unknown',complete:false,ms:null,recordedMs:null,estimatedMs:null,displayMs:null,intervals:[],spanFrom:null,spanTo:null,from,to,timezone:'Asia/Shanghai',excludesWeekends:true,label:'有效耗时未记录',reason:'缺少可还原的计时区间，不将未知耗时记为零'};
 if(task.recordOnly)return {...base,reason:'历史补录仅记录完成日期，未记录设计计时，不能推算真实耗时'};
 const timing=W.taskTiming(task,from,to,policies),tracked=W.trackedIntervals(task,to);
 const currentInterval=Number.isFinite(task.runningSince)&&task.runningSince<=to&&task.timingTracked===true;
 const complete=timing.complete&&(tracked.length>0||currentInterval||!(Number(task.elapsedMs)>0));
 if(complete)return {...base,source:'recorded',complete:true,ms:timing.ms,recordedMs:timing.ms,displayMs:timing.ms,intervals:timing.intervals,label:'有效设计耗时',reason:'仅统计软件计时区间内的工作时段，排除周六、周日、法定休假、午休及非工作时段'};
 if(tracked.length||currentInterval)return {...base,source:'partial',recordedMs:timing.ms,displayMs:timing.ms,intervals:timing.intervals,label:'已记录有效耗时（记录不完整）',reason:'仅显示已有区间，未记录的历史计时未知，不代表完整设计工时'};
 const start=task.startedAt;
 const preciseReview=Number.isFinite(task.reviewAt)&&Number.isFinite(start)&&task.reviewAt>=start;
 const preciseCompletion=task.completedTimePrecision!=='day'&&Number.isFinite(task.completedAt)&&Number.isFinite(start)&&task.completedAt>=start;
 const finish=preciseReview?task.reviewAt:preciseCompletion?task.completedAt:null;
 if(Number.isFinite(start)&&Number.isFinite(finish)){
  const estimatedMs=W.actualWorkingMs(Math.max(from,start),Math.min(to,finish),policies);
  return {...base,source:'span-estimate',estimatedMs,displayMs:estimatedMs,spanFrom:start,spanTo:finish,label:'工作时段历时（推算）',reason:preciseReview?'按开始至提交时间的工作时段推算，已排周末；暂停和实际投入未知，不能当作真实记录工时':'按开始至确认完成时间的工作时段推算，已排周末；可能含暂停和等待确认，不代表实际设计工时'};
 }
 return {...base,reason:Number(task.elapsedMs)>0?'仅有累计计时，缺少日期区间，无法扣除周末和休息时间，完整有效耗时未知':base.reason};
}

module.exports={taskDuration};
