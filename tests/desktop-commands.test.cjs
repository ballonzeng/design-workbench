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
