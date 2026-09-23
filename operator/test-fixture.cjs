const {zipSync,strToU8}=require('fflate');
function workbook(){
 const cells={A1:'需求表',A3:'阶段情况',B3:'需求日期',G3:'分配设计',L3:'文件位置',D5:'69码',J5:'质量打分',K5:'时效打分',J6:'',K6:'',B6:'九芝堂',C6:'西红花',D6:'6970855224163',F6:'单图任务（复杂元素替换）',G6:1,B4:46268,C4:11,D4:'王燕',E4:46268,F4:11,G4:'洪华',A4:'',H4:'',I4:'',J4:'',K4:'',L4:'',M4:'',N4:''};
 const rows=new Map();for(const [address,value] of Object.entries(cells)){const row=address.match(/\d+/)[0];if(!rows.has(row))rows.set(row,[]);rows.get(row).push(typeof value==='number'?'<c r="'+address+'"><v>'+value+'</v></c>':'<c r="'+address+'" t="inlineStr"><is><t>'+value+'</t></is></c>')}
 const xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
 const entries={
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
  '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
  'xl/workbook.xml':'<workbook xmlns="'+xmlns+'" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="【状态】" sheetId="1" r:id="rId1"/><sheet name="主图" sheetId="2" r:id="rId2"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
  'xl/styles.xml':'<styleSheet xmlns="'+xmlns+'"><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"><protection locked="0"/></xf></cellXfs></styleSheet>',
  'xl/worksheets/sheet1.xml':'<worksheet xmlns="'+xmlns+'"><sheetData>'+[...rows].sort((a,b)=>Number(a[0])-Number(b[0])).map(([r,c])=>'<row r="'+r+'">'+c.join('')+'</row>').join('')+'</sheetData><mergeCells count="1"><mergeCell ref="A3:A4"/></mergeCells></worksheet>',
  'xl/worksheets/sheet2.xml':'<worksheet xmlns="'+xmlns+'"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>保留需求内容</t></is></c></row></sheetData></worksheet>'
 };
 return Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k,v])=>[k,strToU8(v)]))));
}

module.exports={workbook};