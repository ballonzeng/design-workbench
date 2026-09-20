'use strict';
function isTemplateFile(name){const base=String(name).replace(/\.xlsx$/i,'').normalize('NFKC').trim();return !/^\d{8}\s*-/.test(base)&&/(模板|范本|样表)/.test(base);}
module.exports={isTemplateFile};
