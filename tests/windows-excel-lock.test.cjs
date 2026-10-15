'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {spawn}=require('node:child_process');
const scriptFile=path.join(__dirname,'..','core','windows-excel-lock.ps1');
const windows=process.platform==='win32';
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const encoded=script=>Buffer.from(script,'utf16le').toString('base64');
function powershell(script,env={}){
 const child=spawn('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encoded(script)],{windowsHide:true,env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 return {child,done:new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('PowerShell test timed out'))},20000);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error('PowerShell failed: '+stderr));else resolve(stdout.trim())})})};
}
async function fixture(t){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-excel-lock-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'3.设计中');await fs.mkdir(dir);const file=path.join(dir,'26101211-CON-减肥双仓主图-王武臣-洪华.xlsx'),owner=path.join(dir,'~$'+path.basename(file));
 const bytes=Buffer.from('original workbook must never be changed'),ownerBytes=Buffer.alloc(165,65);await fs.writeFile(file,bytes);await fs.writeFile(owner,ownerBytes);const old=new Date(Date.now()-180000);await fs.utimes(file,old,old);await fs.utimes(owner,old,old);
 return {root,file,owner,bytes,ownerBytes};
}
async function probe(f,overrides={}){const code=await fs.readFile(scriptFile,'utf8'),p=powershell(code,{DW_EXCEL_ROOT:f.root,DW_EXCEL_FILE:f.file,...overrides});return JSON.parse(await p.done)}
async function hold(t,file,{access='ReadWrite',share='ReadWrite, Delete'}={}){
 const p=powershell("$ErrorActionPreference='Stop';$h=[IO.File]::Open($env:DW_HOLD_FILE,[IO.FileMode]::Open,[IO.FileAccess]::"+access+",[IO.FileShare] '"+share+"');try{[Console]::Out.WriteLine('READY');[Console]::Out.Flush();$null=[Console]::In.ReadLine()}finally{$h.Dispose()}",{DW_HOLD_FILE:file});
 const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Native file holder did not start')),10000);const onData=b=>{if(b.toString().includes('READY')){clearTimeout(timer);p.child.stdout.off('data',onData);resolve()}};p.child.stdout.on('data',onData);p.child.once('error',reject);p.done.catch(reject)});await ready;
 t.after(async()=>{if(p.child.exitCode===null)p.child.stdin.end('\n');await p.done});return p;
}
test('stale Excel owner moves with both native handles held and preserves workbook and recovery evidence',{skip:!windows},async t=>{
 const f=await fixture(t),originalStat=await fs.stat(f.file),r=await probe(f);assert.equal(r.locked,false);assert.equal(r.recovered,true);assert.equal(r.reason,'stale-owner-recovered');assert.ok(r.recoveryPath.startsWith(path.join(f.root,'_workbench-system','recovery','excel-locks')+path.sep));
 assert.deepEqual(await fs.readFile(f.file),f.bytes);assert.equal((await fs.stat(f.file)).mtimeMs,originalStat.mtimeMs);await assert.rejects(fs.stat(f.owner),{code:'ENOENT'});assert.deepEqual(await fs.readFile(r.recoveryPath),f.ownerBytes);
 const manifest=JSON.parse(await fs.readFile(path.join(path.dirname(r.recoveryPath),'manifest.json'),'utf8'));assert.equal(manifest.status,'recovered');assert.equal(manifest.source,f.owner);assert.equal(manifest.workbook,f.file);assert.equal(manifest.size,f.ownerBytes.length);assert.equal(manifest.sha256,digest(f.ownerBytes));assert.equal(manifest.workbookSha256,digest(f.bytes));assert.ok(Number.isFinite(Date.parse(manifest.at)));
});
test('a currently open workbook blocks stale-owner recovery even when its existing handle shares read write and delete',{skip:!windows},async t=>{
 const f=await fixture(t);await hold(t,f.file);const r=await probe(f);assert.equal(r.locked,true);assert.equal(r.reason,'busy');assert.equal(r.recovered,false);assert.deepEqual(await fs.readFile(f.owner),f.ownerBytes);assert.deepEqual(await fs.readFile(f.file),f.bytes);
});
test('a currently open owner blocks recovery even when the workbook is not open',{skip:!windows},async t=>{
 const f=await fixture(t);await hold(t,f.owner);const r=await probe(f);assert.equal(r.locked,true);assert.equal(r.reason,'busy');assert.equal(r.recovered,false);assert.deepEqual(await fs.readFile(f.owner),f.ownerBytes);
});
test('recent owner and recently saved workbook remain locked until both cooldowns pass',{skip:!windows},async t=>{
 const f=await fixture(t),now=new Date();await fs.utimes(f.owner,now,now);let r=await probe(f);assert.equal(r.locked,true);assert.equal(r.reason,'recent');const old=new Date(Date.now()-180000);await fs.utimes(f.owner,old,old);await fs.utimes(f.file,now,now);r=await probe(f);assert.equal(r.locked,true);assert.equal(r.reason,'recent');assert.deepEqual(await fs.readFile(f.owner),f.ownerBytes);
});
test('missing workbook or invalid root cannot clear the editing guard',{skip:!windows},async t=>{
 const f=await fixture(t);for(const overrides of [{DW_EXCEL_FILE:path.join(f.root,'missing.xlsx')},{DW_EXCEL_ROOT:path.join(f.root,'absent')},{DW_EXCEL_ROOT:'relative-root'},{DW_EXCEL_FILE:'relative.xlsx'}]){const r=await probe(f,overrides);assert.equal(r.locked,true);assert.equal(r.recovered,false)}assert.deepEqual(await fs.readFile(f.owner),f.ownerBytes);
});
test('workbook outside configured root is rejected and untouched',{skip:!windows},async t=>{
 const f=await fixture(t),other=await fixture(t);const r=await probe(f,{DW_EXCEL_FILE:other.file});assert.equal(r.locked,true);assert.deepEqual(await fs.readFile(other.owner),other.ownerBytes);
});
test('linked recovery directory is rejected without moving the owner',{skip:!windows},async t=>{
 const f=await fixture(t),other=await fixture(t);await fs.symlink(other.root,path.join(f.root,'_workbench-system'),'junction');const r=await probe(f);assert.equal(r.locked,true);assert.equal(r.recovered,false);assert.deepEqual(await fs.readFile(f.owner),f.ownerBytes);
});
test('no owner file returns unlocked without creating recovery files',{skip:!windows},async t=>{
 const f=await fixture(t);await fs.unlink(f.owner);const r=await probe(f);assert.equal(r.locked,false);assert.equal(r.recovered,false);assert.equal(r.reason,'no-owner-file');await assert.rejects(fs.stat(path.join(f.root,'_workbench-system')),{code:'ENOENT'});
});
test('unavailable network share fails closed without changing existing files',{skip:!windows},async t=>{
 const f=await fixture(t),networkRoot='\\\\localhost\\workbench-excel-lock-missing-'+process.pid;const r=await probe(f,{DW_EXCEL_ROOT:networkRoot,DW_EXCEL_FILE:networkRoot+'\\missing.xlsx'});assert.equal(r.locked,true);assert.equal(r.recovered,false);assert.equal(r.reason,'probe-failed');assert.deepEqual(await fs.readFile(f.owner),f.ownerBytes);
});
test('read-only owner permission failure keeps its file and does not masquerade as an editing session',{skip:!windows},async t=>{
 const f=await fixture(t);await powershell('[IO.File]::SetAttributes($env:DW_HOLD_FILE,[IO.FileAttributes]::ReadOnly)',{DW_HOLD_FILE:f.owner}).done;
 try{const r=await probe(f);assert.equal(r.locked,true);assert.equal(r.recovered,false);assert.equal(r.reason,'probe-failed');assert.deepEqual(await fs.readFile(f.owner),f.ownerBytes)}finally{await powershell('[IO.File]::SetAttributes($env:DW_HOLD_FILE,[IO.FileAttributes]::Normal)',{DW_HOLD_FILE:f.owner}).done}
});
test('native owner handle denies delete rename and overwrite until it closes',{skip:!windows},async t=>{
 const f=await fixture(t),source=await fs.readFile(scriptFile,'utf8'),native=source.match(/\$nativeSource = @'\r?\n([\s\S]*?)\r?\n'@/)[1];
 const code="$ErrorActionPreference='Stop';Add-Type -TypeDefinition @'\n"+native+"\n'@\n$h=[Workbench.ExcelLockNative]::OpenOwner($env:DW_HOLD_FILE);try{[Console]::Out.WriteLine('READY');[Console]::Out.Flush();$null=[Console]::In.ReadLine()}finally{$h.Dispose()}";
 const p=powershell(code,{DW_HOLD_FILE:f.owner});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Native owner holder did not start')),10000);const onData=b=>{if(b.toString().includes('READY')){clearTimeout(timer);p.child.stdout.off('data',onData);resolve()}};p.child.stdout.on('data',onData);p.done.catch(reject)});
 try{await assert.rejects(fs.unlink(f.owner));await assert.rejects(fs.rename(f.owner,f.owner+'.moved'));await assert.rejects(fs.writeFile(f.owner,'replacement'));await assert.rejects(fs.writeFile(f.owner,'replacement',{flag:'wx'}));assert.equal((await fs.stat(f.owner)).size,f.ownerBytes.length)}finally{p.child.stdin.end('\n');await p.done}
 assert.deepEqual(await fs.readFile(f.owner),f.ownerBytes);await fs.rename(f.owner,f.owner+'.moved');assert.deepEqual(await fs.readFile(f.owner+'.moved'),f.ownerBytes);
});
