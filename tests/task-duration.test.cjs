'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const W=require('../core/work-calendar.cjs'),R=require('../core/rules.cjs'),{taskDuration}=require('../core/task-duration.cjs');
const at=value=>Date.parse(value+'+08:00'),H=W.HOUR;
function tracked(start,end,extra={}){return {id:'timed',owner:'hong',state:4,startedAt:at(start),reviewAt:at(end),completedAt:at(end)+H,timingTracked:true,elapsedMs:at(end)-at(start),workIntervals:[{owner:'hong',start:at(start),end:at(end)}],...extra}}

test('actual durations always exclude makeup Saturdays and Sundays while planning capacity stays policy-driven',()=>{
 const friday=at('2026-09-18T17:00:00'),monday=at('2026-09-21T10:00:00');
 assert.equal(W.dayInfo('2026-09-20').working,true);assert.equal(W.workingMs(friday,monday),10*H);assert.equal(W.actualWorkingMs(friday,monday),2*H);
 assert.equal(W.dayInfo('2026-10-10').working,true);assert.equal(W.actualWorkingMs(at('2026-10-09T17:00:00'),at('2026-10-12T10:00:00')),2*H);
 const policies={'2026-09':{...W.DEFAULT,exceptions:{'2026-09-19':true,'2026-09-20':true}}},from=at('2026-09-19T00:00:00'),to=at('2026-09-21T00:00:00');
 assert.equal(W.capacity(from,to,policies).hours,16);assert.equal(W.capacity(from,to,policies).points,12.8);assert.equal(W.actualWorkingMs(from,to,policies),0);assert.deepEqual(W.actualWorkSegments(from,to,policies),[]);
});

test('actual durations preserve statutory holidays, weekday company exceptions and month-specific working sessions',()=>{
 assert.equal(W.actualWorkingMs(at('2026-09-24T17:00:00'),at('2026-09-28T10:00:00')),2*H);
 assert.equal(W.actualWorkingMs(at('2026-09-25T09:00:00'),at('2026-09-25T18:00:00')),0);
 assert.equal(W.actualWorkingMs(at('2026-09-21T11:00:00'),at('2026-09-21T14:00:00')),2*H);
 const policies={'2026-09':{dailyPoints:6.4,sessions:[['10:00','12:00'],['14:00','17:00']],exceptions:{'2026-09-21':false}}};
 assert.equal(W.actualWorkingMs(at('2026-09-18T16:30:00'),at('2026-09-22T10:30:00'),policies),H);
 const company={'2026-09':{...W.DEFAULT,exceptions:{'2026-09-25':true,'2026-09-26':true}}};
 assert.equal(W.actualWorkingMs(at('2026-09-25T09:00:00'),at('2026-09-26T18:00:00'),company),8*H,'weekday company work override remains valid, Saturday never counts');
 const changed={'2026-09':{...W.DEFAULT},'2026-10':{dailyPoints:5,sessions:[['10:00','12:00']],exceptions:{}}};
 assert.equal(W.actualWorkingMs(at('2026-09-30T17:00:00'),at('2026-10-08T11:00:00'),changed),2*H);
});

test('Shanghai weekend boundaries do not use the host timezone and active weekend timers do not grow',()=>{
 const from=Date.parse('2026-09-18T09:00:00Z'),saturday=Date.parse('2026-09-19T04:00:00Z'),sunday=Date.parse('2026-09-20T04:00:00Z');
 const task={id:'running',state:2,owner:'hong',startedAt:from,runningSince:from,timingTracked:true,elapsedMs:0,workIntervals:[]};
 const first=taskDuration(task,{to:saturday}),later=taskDuration(task,{to:sunday});assert.equal(first.ms,H);assert.equal(later.ms,H);assert.equal(later.complete,true);assert.equal(later.source,'recorded');
 assert.equal(taskDuration(task,{to:at('2026-09-21T09:30:00')}).ms,1.5*H);
 assert(W.actualWorkSegments(from,at('2026-09-21T10:00:00')).every(segment=>!['2026-09-19','2026-09-20'].includes(segment.date)));
});

test('recorded pause/resume timing excludes weekends without altering raw counters, transition history or input data',()=>{
 const actor={role:'designer',personId:'hong'};let task={id:'raw',state:1,version:1,owner:'hong',items:[],elapsedMs:0};
 task=R.transition(task,actor,'start',{version:1},at('2026-09-18T17:00:00')).task;
 task=R.transition(task,actor,'pause',{version:2,reason:'暂时离开'},at('2026-09-21T10:00:00')).task;
 const before=structuredClone(task);assert.equal(task.elapsedMs,65*H);assert.equal(task.workIntervals[0].end-task.workIntervals[0].start,65*H);
 const result=taskDuration(task,{to:at('2026-09-21T15:00:00')});assert.equal(result.source,'recorded');assert.equal(result.ms,2*H);assert.equal(result.complete,true);assert.equal(W.taskTiming(task,0,at('2026-09-21T15:00:00')).ms,2*H);assert.deepEqual(task,before);
 task=R.transition(task,actor,'resume',{version:3},at('2026-09-21T15:00:00')).task;
 assert.equal(taskDuration(task,{to:at('2026-09-21T16:00:00')}).ms,3*H);
});

test('recorded task duration keeps second precision and period clipping before display conversion',()=>{
 const task=tracked('2026-09-18T17:59:30','2026-09-21T09:00:30'),result=taskDuration(task,{to:at('2026-09-21T12:00:00')});
 assert.equal(result.ms,60000);assert.equal(W.taskTiming(task,0,at('2026-09-21T12:00:00')).hours,.02);assert.equal(result.displayMs,60000);
 const clipped=taskDuration(task,{from:at('2026-09-21T09:00:00'),to:at('2026-09-21T09:00:30')});assert.equal(clipped.ms,30000);
 const weekend=tracked('2026-09-20T09:00:00','2026-09-20T18:00:00');assert.equal(taskDuration(weekend,{to:at('2026-09-21T12:00:00')}).ms,0,'a fully recorded weekend truly contributes zero effective duration');
});

test('partial interval evidence remains partial and never becomes complete actual time or an estimate over missing pauses',()=>{
 const task=tracked('2026-09-18T17:00:00','2026-09-21T10:00:00',{importedTiming:true,elapsedMs:80*H}),result=taskDuration(task,{to:at('2026-09-22T12:00:00')});
 assert.equal(result.source,'partial');assert.equal(result.ms,null);assert.equal(result.recordedMs,2*H);assert.equal(result.displayMs,2*H);assert.equal(result.estimatedMs,null);assert.equal(result.complete,false);assert.match(result.reason,/不代表完整/);
 const knownWeekend=taskDuration({...task,startedAt:at('2026-09-20T09:00:00'),reviewAt:at('2026-09-20T18:00:00'),workIntervals:[{owner:'hong',start:at('2026-09-20T09:00:00'),end:at('2026-09-20T18:00:00')}]},{to:at('2026-09-21T12:00:00')});assert.equal(knownWeekend.recordedMs,0);assert.equal(knownWeekend.ms,null);
});

test('external Excel start/end without real intervals is explicitly a working-span estimate, never recorded actual hours',()=>{
 const task={state:4,startedAt:at('2026-09-18T17:00:00'),completedAt:at('2026-09-21T10:00:00'),importedTiming:true,elapsedMs:65*H},before=structuredClone(task),result=taskDuration(task,{to:at('2026-09-21T16:00:00')});
 assert.equal(result.source,'span-estimate');assert.equal(result.estimatedMs,2*H);assert.equal(result.displayMs,2*H);assert.equal(result.ms,null);assert.equal(result.recordedMs,null);assert.equal(result.complete,false);assert.match(result.label,/推算/);assert.match(result.reason,/等待确认/);assert.deepEqual(task,before);
 const submitted=taskDuration({...task,reviewAt:at('2026-09-21T09:30:00')},{to:at('2026-09-21T16:00:00')});assert.equal(submitted.estimatedMs,1.5*H);assert.equal(submitted.spanTo,at('2026-09-21T09:30:00'));assert.match(submitted.reason,/提交时间/);
 const clipped=taskDuration(task,{from:at('2026-09-21T09:00:00'),to:at('2026-09-21T10:00:00')});assert.equal(clipped.estimatedMs,H);
});

test('date-only supplements, cumulative-only legacy timers and absent or invalid milestone times remain unknown',()=>{
 const to=at('2026-11-04T12:00:00'),unknowns=[{recordOnly:true,completedAt:at('2026-10-20T00:00:00'),elapsedMs:0},{elapsedMs:72*H},{startedAt:at('2026-10-20T09:00:00'),completedAt:at('2026-10-20T00:00:00'),completedTimePrecision:'day'},{startedAt:at('2026-10-21T09:00:00'),completedAt:at('2026-10-20T17:00:00')},{}];
 for(const task of unknowns){const result=taskDuration(task,{to});assert.equal(result.source,'unknown');assert.equal(result.ms,null);assert.equal(result.displayMs,null);assert.equal(result.recordedMs,null);assert.equal(result.estimatedMs,null)}
 assert.throws(()=>taskDuration(null,{to}),/无效/);assert.throws(()=>taskDuration({},{from:to+1,to}),/无效/);
 assert.deepEqual(W.actualWorkSegments(to,to),[]);assert.equal(W.actualWorkingMs(to,to-1),0);
});
