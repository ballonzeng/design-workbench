'use strict';
const fs=require('node:fs'),path=require('node:path'),asar=require('@electron/asar');
const root=path.resolve(__dirname,'..'),version=require('../package.json').version;
const files=['core/automatic-names.cjs','core/image-metadata.cjs','core/naming.cjs','core/assets.cjs','core/client.cjs','core/delivery.cjs','core/nas.cjs','core/products.cjs','core/report.cjs','core/service.cjs','core/store.cjs','core/rules.cjs','core/workbook.cjs','core/requirements-sync.cjs','desktop/main.cjs','desktop/preload.cjs','desktop/notifications.cjs','desktop/delivery.cjs','ui/calendar.js','ui/index.html','ui/app.js','ui/style.css','assets/icon-manager.png','assets/icon-designer.png','README.md'];
const roles=process.argv[2]?[process.argv[2]]:['manager','designer'];
if(roles.some(role=>!['manager','designer'].includes(role)))throw Error('Unknown role');
const results=roles.map(role=>{
 const archive=path.join(root,'release',role,'win-unpacked','resources','app.asar');
 const pkg=JSON.parse(asar.extractFile(archive,'package.json'));
 if(pkg.version!==version||pkg.clientRole!==role)throw Error('Packaged role/version mismatch: '+role);
 for(const file of files)if(!asar.extractFile(archive,file).equals(fs.readFileSync(path.join(root,file))))throw Error('Packaged file differs from source: '+role+'/'+file);
 return {role,version,matchedFiles:files.length,passed:true};
});
fs.writeFileSync(path.join(root,'checks','package-'+version+'.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
