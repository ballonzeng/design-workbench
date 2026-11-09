'use strict';
// fflate normally inserts the current ZIP mtime. Normalize it so a reviewed
// workbook patch has the same digest when the plan is rebuilt for apply.
const {unzipSync,zipSync}=require('fflate');
const {patchWorkbook}=require('../core/workbook.cjs');
function patchWorkbookStable(bytes,changes){return Buffer.from(zipSync(unzipSync(patchWorkbook(bytes,changes)),{level:6,mtime:new Date('2000-01-01T00:00:00Z')}))}
module.exports={patchWorkbookStable};
