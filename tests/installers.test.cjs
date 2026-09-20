'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {AppInfo}=require('app-builder-lib/out/appInfo');const {getWindowsInstallationDirName}=require('app-builder-lib/out/targets/targetUtil');
test('manager and designer installers have distinct directories and registrations while retaining display names',async()=>{
 const configs=[],source=fs.readFileSync(path.join(__dirname,'../scripts/build.cjs'),'utf8');const fakeFs={mkdirSync(){},copyFileSync(){}};
 const context=vm.createContext({__dirname:path.join(__dirname,'../scripts'),console,process:{argv:['node','build'],exitCode:0},require:name=>name==='electron-builder'?{build:async options=>configs.push(options.config),Platform:{WINDOWS:{createTarget:()=>[]}},Arch:{x64:'x64'}}:name==='node:fs'?fakeFs:name==='../package.json'?require('../package.json'):require(name)});vm.runInContext(source.replace('run().catch','globalThis.finished=run().catch'),context);await context.finished;assert.equal(configs.length,2);
 const directories=configs.map(config=>getWindowsInstallationDirName(new AppInfo({config,metadata:{...require('../package.json'),...config.extraMetadata},framework:{defaultAppIdPrefix:'test.'}}),true));assert.deepEqual(directories,['design-workbench-manager','design-workbench-designer']);assert.notEqual(configs[0].nsis.guid,configs[1].nsis.guid);assert.equal(configs[0].productName,'设计协作负责人端');assert.equal(configs[1].productName,'设计协作设计端');assert.equal(configs[0].nsis.deleteAppDataOnUninstall,false);
});
