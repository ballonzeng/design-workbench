'use strict';
const https=require('node:https');const crypto=require('node:crypto');const fs=require('node:fs');const {Transform}=require('node:stream');const {pipeline}=require('node:stream/promises');
function decodeCode(code){
 if(typeof code!=='string'||!code.startsWith('DW1.')||code.length>12000)throw new Error('连接码格式不正确');
 let value;try{value=JSON.parse(Buffer.from(code.slice(4).trim(),'base64url').toString('utf8'))}catch{throw new Error('连接码格式不正确')}
 if(!/^[a-zA-Z0-9.-]{1,253}$/.test(value.host)||!Number.isInteger(value.port)||value.port<1||value.port>65535||typeof value.cert!=='string'||!value.cert.includes('BEGIN CERTIFICATE')||!/^[a-zA-Z0-9_-]{43}$/.test(value.secret))throw new Error('连接码格式不正确');
 return value;
}
class Client{
 constructor(connection){this.connection=connection;this.eventRequest=null;this.retry=null;this.closed=false}
 options(route,method='GET'){
  const c=this.connection;
  return {host:c.host,port:c.port,path:route,method,servername:'design-workbench.local',ca:c.cert,rejectUnauthorized:true,minVersion:'TLSv1.2',headers:c.token?{Authorization:'Bearer '+c.token}:{},timeout:30000};
 }
 async request(route,data=null,timeout=30000){
  const options=this.options(route,data?'POST':'GET'),bytes=data?Buffer.from(JSON.stringify(data)):null;
  options.timeout=timeout;
  if(bytes)options.headers={...options.headers,'Content-Type':'application/json','Content-Length':bytes.length};
  return new Promise((resolve,reject)=>{
   const req=https.request(options,res=>{const chunks=[];let length=0;res.on('data',b=>{length+=b.length;if(length>64*1024*1024){req.destroy(new Error('返回内容过大'));return}chunks.push(b)});res.on('end',()=>{const b=Buffer.concat(chunks);if(res.statusCode>=400){let message='服务暂不可用';try{message=JSON.parse(b.toString()).error||message}catch{}const e=new Error(message);e.status=res.statusCode;reject(e)}else if(res.headers['content-type']?.includes('application/json')){try{resolve(JSON.parse(b.toString()))}catch{reject(new Error('服务返回内容无效'))}}else resolve(b)})});
   req.on('timeout',()=>req.destroy(new Error('连接超时，请检查负责人端和公司内网')));req.on('error',reject);if(bytes)req.write(bytes);req.end();
  });
 }
 async pair(){const r=await this.request('/pair',{secret:this.connection.secret});this.connection={host:this.connection.host,port:this.connection.port,cert:this.connection.cert,token:r.token,person:r.person,role:r.role||'designer'};return this.connection}
 rpc(command,payload={},requestId=crypto.randomUUID()){return this.request('/rpc',{command,payload,requestId},['archive-commit','archive-finish'].includes(command)?30*60*1000:30000)}
 events(onChange,onStatus){
  this.closed=false;let delay=1000;
  const connect=()=>{
   if(this.closed)return;
   const req=https.request(this.options('/events'),res=>{
    if(res.statusCode!==200){res.resume();onStatus(false,res.statusCode===401?'设备绑定已失效，请重新连接':'负责人端暂不可用');res.on('end',schedule);return}
    delay=1000;onStatus(true);let buffer='';
    res.setEncoding('utf8');res.on('data',chunk=>{buffer+=chunk;if(buffer.length>64000){req.destroy();return}let end;while((end=buffer.indexOf('\n\n'))>=0){const event=buffer.slice(0,end);buffer=buffer.slice(end+2);if(event.startsWith('data: ')){let message;try{message=JSON.parse(event.slice(6))}catch{req.destroy();return}onChange(message)}}});
    res.on('end',schedule);res.on('error',schedule);
   });
   const schedule=()=>{if(this.closed||this.retry)return;onStatus(false,'连接中断，正在重连');this.retry=setTimeout(()=>{this.retry=null;connect()},delay);delay=Math.min(delay*2,15000)};
   req.setTimeout(45000,()=>req.destroy());req.on('error',schedule);req.end();this.eventRequest=req;
  };connect();
 }
 async upload(id,file,localPath,onProgress){
  const options=this.options('/upload/'+id+'/'+file.id,'PUT');options.timeout=30*60*1000;options.headers={...options.headers,'Content-Type':'application/octet-stream','Content-Length':file.size};
  return new Promise((resolve,reject)=>{
   let loaded=0,last=0;const meter=new Transform({transform(chunk,_enc,cb){loaded+=chunk.length;if(Date.now()-last>150){last=Date.now();onProgress?.(loaded,file.size)}cb(null,chunk)}});
   const req=https.request(options,res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>{let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{return reject(new Error('上传响应无效'))}if(res.statusCode>=400)reject(new Error(data.error));else{onProgress?.(file.size,file.size);resolve(data)}})});
   req.on('error',reject);req.on('timeout',()=>req.destroy(new Error('上传超时')));
   pipeline(fs.createReadStream(localPath),meter,req).catch(reject);
  });
 }
 close(){this.closed=true;clearTimeout(this.retry);this.retry=null;this.eventRequest?.destroy()}
}
module.exports={Client,decodeCode};
