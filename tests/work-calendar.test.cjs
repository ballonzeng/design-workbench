'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),W=require('../core/work-calendar.cjs'),R=require('../core/rules.cjs');
const at=s=>Date.parse(s+'+08:00');
test('official holiday, compensatory Sunday, monthly targets and unknown-year estimates',()=>{
 assert.equal(W.dayInfo('2026-09-20').working,true);assert.equal(W.dayInfo('2026-09-25').working,false);
 const sep=W.capacity(at('2026-09-01T00:00:00'),at('2026-10-01T00:00:00'));assert.equal(sep.workdays,22);assert.equal(sep.points,140.8);
 assert.equal(W.dayInfo('2027-01-04').verified,false);
 const pol={'2026-09':{...W.DEFAULT,exceptions:{'2026-09-20':false}}};assert.equal(W.capacity(at('2026-09-01T00:00:00'),at('2026-10-01T00:00:00'),pol).points,134.4);delete pol['2026-09'].exceptions['2026-09-20'];assert.equal(W.dayInfo('2026-09-20',pol).working,true);
});
test('working intervals exclude lunch, night, holiday; partial targets do not include future hours',()=>{
 assert.equal(W.workingMs(at('2026-09-21T11:00:00'),at('2026-09-21T14:00:00')),2*W.HOUR);
 assert.equal(W.workingMs(at('2026-09-24T17:00:00'),at('2026-09-28T10:00:00')),2*W.HOUR);
 const c=W.capacity(at('2026-09-21T00:00:00'),at('2026-09-22T00:00:00'),{},at('2026-09-21T12:30:00'));assert.equal(c.elapsedPoints,2.4);assert.equal(c.points,6.4);
});
test('calendar validation rejects overlap, impossible dates and corrupted overrides',()=>{
 assert.throws(()=>W.validatePolicy({...W.DEFAULT,sessions:[['09:00','13:00'],['12:00','18:00']]}),/重叠/);
 assert.throws(()=>W.validatePolicy({...W.DEFAULT,exceptions:{'2026-02-30':true}}),/有效日期/);
 assert.throws(()=>W.validatePolicy({...W.DEFAULT,dailyPoints:-1}));
});
test('tracked sessions preserve pauses and raw elapsed while valid intervals are filtered',()=>{
 let t={id:'a',state:1,version:1,owner:'hong',items:[],elapsedMs:0};const actor={role:'designer',personId:'hong'};
 t=R.transition(t,actor,'start',{version:1},at('2026-09-21T11:00:00')).task;
 t=R.transition(t,actor,'pause',{version:2,reason:'暂时离开'},at('2026-09-21T14:00:00')).task;
 assert.equal(t.elapsedMs,3*W.HOUR);const m=W.taskTiming(t,0,at('2026-09-21T18:00:00'));assert.equal(m.hours,2);assert.equal(m.complete,true);
 t=R.transition(t,actor,'resume',{version:3},at('2026-09-21T15:00:00')).task;
 assert.equal(W.taskTiming(t,0,at('2026-09-21T16:00:00')).hours,3);
 const legacy={...t,timingTracked:false,elapsedMs:1000,runningSince:at('2026-09-21T15:00:00')};assert.equal(W.taskTiming(legacy,0,at('2026-09-21T16:00:00')).complete,false);
});
test('overlapping tasks are unioned for a person rather than added as workhours',()=>{
 assert.equal(W.unionHours([{start:0,end:2*W.HOUR},{start:W.HOUR,end:3*W.HOUR}]),3);
});
