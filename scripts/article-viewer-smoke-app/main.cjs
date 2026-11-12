// Native lifecycle regression for the production original-page helper. All
// profiles are temporary, remote requests are blocked, no user library loads.
const {app,BrowserWindow}=require('electron');
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises'),syncFs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),base=path.join(root,'dist/main/main');
const directory=syncFs.mkdtempSync(path.join(os.tmpdir(),'reading-hub-viewer-smoke-'));
app.setPath('userData',path.join(directory,'host'));app.on('window-all-closed',()=>{});
const watchdog=setTimeout(()=>{console.error('Original-page lifecycle timed out');app.exit(1);},45000);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check){for(let i=0;i<200;i++){if(await check())return;await wait(20);}throw new Error('Native helper condition timed out');}
let viewer,host;
app.whenReady().then(async()=>{
 host=new BrowserWindow({show:false});
 const wrapper=path.join(directory,'helper.cjs');
 await fs.writeFile(wrapper,`const {app,BrowserWindow}=require('electron');
const send=message=>{if(process.connected)process.send(message);};
app.on('browser-window-created',(_event,window)=>{
 window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>callback({cancel:true}));
 for(const method of ['clearStorageData','clearCache','clearAuthCache','closeAllConnections']){
  const original=window.webContents.session[method].bind(window.webContents.session);
  window.webContents.session[method]=(...args)=>{send({type:'cleanup',method});return original(...args);};
 }
});
process.on('message',message=>{
 const window=BrowserWindow.getAllWindows()[0];
 if(message.type==='inspect'&&window)send({type:'metrics',name:app.getName(),dockVisible:app.dock?.isVisible(),windows:BrowserWindow.getAllWindows().length,preferences:window.webContents.getLastWebPreferences()});
 if(message.type==='keyboard-quit'&&window){window.focus();window.webContents.focus();window.webContents.sendInputEvent({type:'keyDown',keyCode:'Q',modifiers:[process.platform==='darwin'?'meta':'control']});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Q',modifiers:[process.platform==='darwin'?'meta':'control']});}
 if(message.type==='close-window'&&window)window.close();
 if(message.type==='hang-cleanup'&&window){window.webContents.session.clearStorageData=()=>{send({type:'cleanup',method:'clearStorageData'});return new Promise(()=>{});};window.close();}
});
require(${JSON.stringify(path.join(base,'article-viewer-entry.js'))});`);
 const {workerEnvironment}=require(path.join(base,'render-worker-protocol.js'));
 const records=[];
 const launcher=profile=>{
  const child=spawn(process.execPath,[wrapper],{env:workerEnvironment(profile),stdio:['ignore','ignore','pipe','ipc']});
  const record={child,profile,messages:[],exited:false,stderr:''};records.push(record);
  child.on('message',message=>record.messages.push(message));child.stderr.on('data',bytes=>record.stderr+=bytes.toString());child.once('close',()=>record.exited=true);return child;
 };
 const {InAppArticleViewer}=require(path.join(base,'in-app-article-viewer.js'));
 viewer=new InAppArticleViewer(launcher,1000);
 await viewer.open('https://example.com/fixture','Fixture');await until(()=>records.length===1);
 records[0].child.send({type:'inspect'});await until(()=>records[0].messages.some(m=>m.type==='metrics'));
 const metrics=records[0].messages.find(m=>m.type==='metrics');assert.equal(metrics.name,'Reading Hub');assert.equal(metrics.windows,1);
 if(process.platform==='darwin')assert.equal(metrics.dockVisible,false,'Original helper introduced a second Dock identity');
 assert.equal(metrics.preferences.nodeIntegration,false);assert.equal(metrics.preferences.contextIsolation,true);assert.equal(metrics.preferences.sandbox,true);assert.equal(metrics.preferences.preload,undefined);
 let quitRequests=0;app.quit=()=>quitRequests++;
 records[0].child.send({type:'keyboard-quit'});await until(()=>quitRequests===1);
 records[0].child.send({type:'close-window'});await until(()=>records[0].exited);await until(async()=>!syncFs.existsSync(records[0].profile));
 assert.deepEqual(records[0].messages.filter(m=>m.type==='cleanup').map(m=>m.method).sort(),['clearStorageData','clearCache','clearAuthCache','closeAllConnections'].sort());
 await viewer.open('https://example.com/hung','Hung cleanup');records[1].child.send({type:'hang-cleanup'});await until(()=>records[1].exited);
 await viewer.open('https://example.com/remaining','Remaining');await viewer.close();
 assert.ok(records.every(record=>record.exited));assert.ok(records.every(record=>!syncFs.existsSync(record.profile)));
 console.log('Original-page helper: isolated preferences, accessory identity, keyboard quit, four native cleanup paths, hung-process recovery and owner shutdown passed');
}).then(async()=>{clearTimeout(watchdog);host?.destroy();await fs.rm(directory,{recursive:true,force:true});app.exit();}).catch(async error=>{console.error(error);await viewer?.close();host?.destroy();await fs.rm(directory,{recursive:true,force:true});app.exit(1);});
