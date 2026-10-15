'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const {execFile}=require('node:child_process'),{promisify}=require('node:util');
const exec=promisify(execFile),MIN_AGE_MS=120000;
const lockPath=file=>path.join(path.dirname(file),'~$'+path.basename(file));
async function statOrMissing(file){try{return await fs.lstat(file)}catch(e){if(e.code==='ENOENT')return null;throw e}}
let script;
async function windowsRecovery(file,root){
 script=script||await fs.readFile(path.join(__dirname,'windows-excel-lock.ps1'),'utf8');
 const systemRoot=process.env.SystemRoot||'C:\\Windows';
 const bootstrap='[Console]::InputEncoding = [Text.Encoding]::UTF8; & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))';
 let stdout;
 try{
  const operation=exec(path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),
   ['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(bootstrap,'utf16le').toString('base64')],
   {windowsHide:true,timeout:15000,maxBuffer:128*1024,env:{...process.env,DW_EXCEL_FILE:file,DW_EXCEL_ROOT:root}});
  operation.child.stdin.on('error',()=>{});operation.child.stdin.end(script,'utf8');
  ({stdout}=await operation);
 }
 catch(e){throw Error(e.killed?'Windows 占用检测超时，稍后将重试':e.code==='ENOENT'?'Windows 占用检测组件不可用':'Windows 占用检测未能完成')}
 const result=JSON.parse(stdout.trim());
 if(typeof result.locked!=='boolean'||typeof result.recovered!=='boolean')throw Error('占用检测未返回有效结果');
 return result;
}
function createLockChecker({platform=process.platform,runHelper=windowsRecovery,now=Date.now}={}){
 const pending=new Map(),recent=new Map();
 return async function hasWorkbookLock(file,root,{recover=true}={}){
  const lock=lockPath(file),stat=await statOrMissing(lock);
  if(!stat)return false;
  // Other platforms and final write checks retain the conservative owner-file check.
  if(!recover||platform!=='win32'||!root||!stat.isFile()||stat.isSymbolicLink()||stat.size>4096||now()-stat.mtimeMs<MIN_AGE_MS)return true;
  const rel=path.relative(path.resolve(root),path.resolve(file));
  if(rel===''||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw Error('需求表占用检测路径超出已连接目录');
  const original=await statOrMissing(file);
  if(!original||!original.isFile()||original.isSymbolicLink()||now()-original.mtimeMs<MIN_AGE_MS)return true;
  const signature=[root,stat.size,stat.mtimeMs,original.size,original.mtimeMs].join(':');
  const cached=recent.get(file);
  if(cached?.signature===signature&&now()-cached.at<15000){if(cached.error)throw Error(cached.error);return true}
  if(pending.has(file))return pending.get(file);
  const operation=(async()=>{
   try{
    const result=await runHelper(file,root);
    if(result.locked&&result.reason&&!['busy','recent','changed'].includes(result.reason))throw Error('无法确认需求表是否仍被占用，已保留占用记录：'+(result.error||result.reason));
    // Recheck by name: a new Excel session may have created a new owner file.
    const locked=result.locked||!!await statOrMissing(lock);
    if(locked){if(recent.size>=256)recent.delete(recent.keys().next().value);recent.set(file,{signature,at:now()})}
    else recent.delete(file);
    return locked;
   }catch(e){
    const message='需求表占用核对未完成，已保留原表和占用记录：'+e.message;
    if(recent.size>=256)recent.delete(recent.keys().next().value);
    recent.set(file,{signature,at:now(),error:message});throw Error(message);
   }finally{pending.delete(file)}
  })();
  pending.set(file,operation);return operation;
 };
}
const hasWorkbookLock=createLockChecker();
module.exports={hasWorkbookLock,lockPath,createLockChecker,MIN_AGE_MS};
