'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../desktop/main.cjs'),'utf8').replace(/\r\n/g,'\n');

// Execute the desktop's own allowlist, handle, invoke and IPC registration. Keep
// Electron windows, networking and the service boundary stubbed, not the router.
function desktopRouter(remoteManager=false){
 const calls=[],handlers=new Map(),manager={role:'manager',personId:'zeng'},mainFrame={url:'file:///test/ui/index.html'},webContents={mainFrame};
 const context=vm.createContext({
  role:'manager',settings:{remoteManager},manager,crypto,connectionError:'',appURL:mainFrame.url,win:{webContents},
  service:{server:{listening:true},call:async(actor,command,payload,requestId)=>{calls.push({transport:'local',actor,command,payload,requestId});return {routed:'local'}}},
  client:{rpc:async(command,payload)=>{calls.push({transport:'remote',command,payload});return {routed:'remote'}}},
  ipcMain:{handle:(name,handler)=>handlers.set(name,handler)}
 });
 const invokeStart=source.indexOf('async function invoke('),invokeEnd=source.indexOf('\nasync function refresh(',invokeStart);
 const handleStart=source.indexOf('const COMMANDS='),handleEnd=source.indexOf('\nasync function finishSmoke(',handleStart);
 assert.ok(invokeStart>=0&&invokeEnd>invokeStart&&handleStart>=0&&handleEnd>handleStart,'desktop router source boundaries');
 vm.runInContext(source.slice(invokeStart,invokeEnd)+'\n'+source.slice(handleStart,handleEnd),context);
 const registerStart=source.indexOf("ipcMain.handle('workbench:call'"),registerEnd=source.indexOf('\n',registerStart);
 assert.ok(registerStart>=0&&registerEnd>registerStart,'desktop IPC registration source boundary');
 vm.runInContext(source.slice(registerStart,registerEnd),context);
 const invoke=(command,payload={},event={sender:webContents,senderFrame:mainFrame})=>handlers.get('workbench:call')(event,command,payload);
 return {calls,invoke,manager};
}

test('desktop calibration preview passes the real IPC allowlist and routes to the local manager service',async()=>{
 const desktop=desktopRouter(),payload={taskId:'task-id',version:7,preview:true},result=await desktop.invoke('calibrate-contribution',payload);
 assert.equal(result.ok,true);assert.equal(result.value.routed,'local');assert.equal(desktop.calls.length,1);
 const call=desktop.calls[0];assert.equal(call.actor,desktop.manager);assert.equal(call.command,'calibrate-contribution');assert.equal(call.payload,payload);assert.match(call.requestId,/^[0-9a-f-]{36}$/);
});

test('desktop calibration confirmation routes to remote RPC with the reviewed workbook hash',async()=>{
 const desktop=desktopRouter(true),payload={taskId:'task-id',version:7,expectedHash:'a'.repeat(64)},result=await desktop.invoke('calibrate-contribution',payload);
 assert.equal(result.ok,true);assert.equal(result.value.routed,'remote');assert.deepEqual(desktop.calls,[{transport:'remote',command:'calibrate-contribution',payload}]);
});

test('desktop unknown commands and untrusted renderer sources never reach either backend',async()=>{
 for(const remote of [false,true]){
  const desktop=desktopRouter(remote),result=await desktop.invoke('unsupported-command');
  assert.equal(result.ok,false);assert.match(result.error,/不支持的操作/);assert.equal(desktop.calls.length,0);
  await assert.rejects(desktop.invoke('calibrate-contribution',{}, {sender:{},senderFrame:{}}),/无效来源/);assert.equal(desktop.calls.length,0);
 }
});

test('calendar preview and save pass the desktop allowlist for local and remote managers',async()=>{
 for(const remote of [false,true])for(const command of ['work-calendar-preview','work-policy-save']){const desktop=desktopRouter(remote),payload={month:'2026-09',revision:0};assert.equal((await desktop.invoke(command,payload)).ok,true);assert.equal(desktop.calls[0].command,command);assert.equal(desktop.calls[0].transport,remote?'remote':'local')}
});

test('task review passes the real desktop IPC allowlist and preserves date filters for local and remote managers',async()=>{
 for(const remote of [false,true]){
  const desktop=desktopRouter(remote),payload={frequency:'custom',start:'2026-10-01',end:'2026-10-31',basis:'completed',personId:'hong',state:'unsealed',query:'主图'};
  const result=await desktop.invoke('task-review',payload);
  assert.equal(result.ok,true);assert.equal(result.value.routed,remote?'remote':'local');assert.equal(desktop.calls.length,1);
  assert.equal(desktop.calls[0].command,'task-review');assert.equal(desktop.calls[0].payload,payload);
  if(!remote){assert.equal(desktop.calls[0].actor,desktop.manager);assert.match(desktop.calls[0].requestId,/^[0-9a-f-]{36}$/)}
  await assert.rejects(desktop.invoke('task-review',payload,{sender:{},senderFrame:{}}),/无效来源/);
  assert.equal(desktop.calls.length,1);
 }
});

test('period-only review exclusion and restore preserve their scope through local and remote desktop IPC',async()=>{
 for(const remote of [false,true])for(const command of ['task-review-exclude','task-review-restore']){
  const desktop=desktopRouter(remote),payload={taskId:'long-running-task',frequency:'month',anchor:'2026-10-01',reason:'跨月长期任务'};
  const result=await desktop.invoke(command,payload);
  assert.equal(result.ok,true);assert.equal(result.value.routed,remote?'remote':'local');assert.equal(desktop.calls.length,1);
  assert.equal(desktop.calls[0].command,command);assert.equal(desktop.calls[0].payload,payload);
  if(!remote){assert.equal(desktop.calls[0].actor,desktop.manager);assert.match(desktop.calls[0].requestId,/^[0-9a-f-]{36}$/)}
  await assert.rejects(desktop.invoke(command,payload,{sender:{},senderFrame:{}}),/无效来源/);
  assert.equal(desktop.calls.length,1);
 }
});
