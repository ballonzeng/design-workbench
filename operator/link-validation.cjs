'use strict';
const PREFIX='https://detail.tmall.com/item.htm?id=';
function validateLinks(items){const reasons=[];for(const item of items){const value=String(item.linkId||'').trim();if(!value||value==='无')continue;if(!/^https:\/\/detail\.tmall\.com\/item\.htm\?id=[0-9]{11,20}$/.test(value))reasons.push('第'+item.row+'行（E'+item.row+'，当前链接ID）：请填写 '+PREFIX+' 加11～20位数字，不要带skuId等额外参数。');}if(reasons.length){const e=Error('上传失败，当前链接ID格式不符合规则');e.reasons=reasons;throw e;}}
module.exports={validateLinks};
