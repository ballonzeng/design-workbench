'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
test('window controls handle minimize, maximize, restore and close only from their main frame',()=>{
 let handler,maximized=false,closed=false,minimized=false;const events=new Map(),frame={},contents={mainFrame:frame,send:()=>{}};
 const win={webContents:contents,on:(name,fn)=>events.set(name,fn),isMaximized:()=>maximized,maximize:()=>{maximized=true},unmaximize:()=>{maximized=false},minimize:()=>{minimized=true},close:()=>{closed=true}};
 require('../core/window-chrome.cjs')(win,{handle:(_name,fn)=>{handler=fn}});const sender={sender:contents,senderFrame:frame};
 assert.deepEqual(handler(sender,'maximize'),{maximized:true});assert.deepEqual(handler(sender,'maximize'),{maximized:false});handler(sender,'minimize');handler(sender,'close');assert(minimized&&closed);assert.throws(()=>handler({sender:contents,senderFrame:{}},'close'),/无权限/);assert.throws(()=>handler(sender,'arbitrary'),/不支持/);
});
