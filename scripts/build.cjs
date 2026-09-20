'use strict';
const {build,Platform,Arch}=require('electron-builder');const fs=require('node:fs');const path=require('node:path');
async function run(){
 const root=path.resolve(__dirname,'..');fs.mkdirSync(path.join(root,'ui/vendor'),{recursive:true});
 fs.copyFileSync(path.join(root,'node_modules/lucide/dist/umd/lucide.min.js'),path.join(root,'ui/vendor/lucide.min.js'));
 fs.copyFileSync(path.join(root,'node_modules/lucide/LICENSE'),path.join(root,'ui/vendor/lucide-LICENSE'));
 const roles=process.argv[2]?[process.argv[2]]:['manager','designer'];const target=process.argv[3]||'portable';
 if(!['portable','nsis'].includes(target))throw Error('Unknown build target');
 for(const role of roles){
  if(!['manager','designer'].includes(role))throw Error('Unknown client role');
  const label=role==='manager'?'负责人端':'设计端';
  await build({targets:Platform.WINDOWS.createTarget([target],Arch.x64),config:{
   appId:'local.kyuan.designworkbench.'+role,productName:'设计协作'+label,extraMetadata:{clientRole:role,name:'design-workbench-'+role},
   electronDist:path.join(root,'node_modules','electron','dist'),
   directories:{output:'release/'+role,buildResources:'assets'},
   files:['core/**/*','desktop/**/*','ui/**/*','assets/*.png','README.md','package.json'],
   asar:true,compression:'normal',win:{icon:'assets/icon-'+role+'.png',artifactName:'Design-Workbench-'+role+'-'+pkgVersion()+'-x64-'+(target==='portable'?'portable':'setup')+'.exe',signAndEditExecutable:true},
   portable:{requestExecutionLevel:'user',unpackDirName:'design-workbench-'+role+'-'+pkgVersion()},
   nsis:{guid:require('builder-util-runtime').UUID.v5('local.kyuan.designworkbench.isolated.'+role,'50e065bc-3134-11e6-9bab-38c9862bdaf3'),oneClick:false,perMachine:false,allowToChangeInstallationDirectory:true,createDesktopShortcut:true,createStartMenuShortcut:true,shortcutName:'设计协作'+label,deleteAppDataOnUninstall:false,runAfterFinish:false,installerLanguages:['zh_CN','en_US'],displayLanguageSelector:false}
  }});
 }
}
function pkgVersion(){return require('../package.json').version}
run().catch(error=>{console.error(error);process.exitCode=1});
