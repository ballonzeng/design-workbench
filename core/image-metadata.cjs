'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
// Read metadata only; never decode, resize or rewrite image content.
async function imageWidth(file){
 const h=await fs.open(file,'r');try{
  const b=Buffer.alloc(32);const read=async(pos,n)=>{const r=await h.read(b,0,n,pos);if(r.bytesRead!==n)throw Error('图片头不完整');return b};
  await read(0,24);if(b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return b.readUInt32BE(16);
  if(/^GIF8[79]a$/.test(b.subarray(0,6).toString('ascii')))return b.readUInt16LE(6);
  if(b[0]!==255||b[1]!==216)throw Error('无法读取 PNG/JPG/GIF 图片尺寸：'+path.basename(file));
  let pos=2;const size=(await h.stat()).size;
  while(pos<size){await read(pos++,1);if(b[0]!==255)throw Error('JPEG 标记损坏');do{await read(pos++,1)}while(b[0]===255);const marker=b[0];if(marker===217||marker===218)break;if(marker===1||marker>=208&&marker<=215)continue;
   await read(pos,2);const length=b.readUInt16BE(0);if(length<2||pos+length>size)throw Error('JPEG 数据损坏');if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){await read(pos+2,5);return b.readUInt16BE(3)}pos+=length;
  }throw Error('无法读取图片宽度：'+path.basename(file));
 }finally{await h.close()}
}
module.exports={imageWidth};
