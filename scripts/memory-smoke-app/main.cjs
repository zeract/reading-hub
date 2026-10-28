// Native, deterministic lifetime regression. No user data or remote requests.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..');
const until=async predicate=>{for(let i=0;i<100;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Memory lifetime condition timed out');};
let directory,window,pool,host;
app.on("window-all-closed",()=>{});
const deadline=setTimeout(()=>{console.error("Native memory smoke timed out");app.exit(1);},90_000);
app.whenReady().then(async()=>{
 directory=await fs.mkdtemp(path.join(os.tmpdir(),'reading-hub-memory-smoke-'));app.setPath('userData',path.join(directory,'browser'));
 const {RenderSessionPool}=require(path.join(root,'dist/main/main/render-session-pool.js'));
 host=new BrowserWindow({show:false});
 pool=new RenderSessionPool();const contexts=new Set(),samples=[];
 const memory=async label=>{global.gc?.();samples.push({label,...await process.getProcessMemoryInfo(),threads:execFileSync('ps',['-M','-p',String(process.pid)],{encoding:'utf8'}).trim().split('\n').length-1});};
 for(let round=0;round<40;round++){
  await Promise.all([0,1].map(async()=>{
   const lease=await pool.acquire(new AbortController().signal),ses=lease.session;
   if(!contexts.has(ses))ses.protocol.handle('https',()=>new Response('<html><body>Isolated memory fixture</body></html>',{headers:{'Content-Type':'text/html'}}));
   contexts.add(ses);
   assert.equal((await ses.cookies.get({})).length,0,'Cookies leaked into a reused context');
   const view=new BrowserWindow({show:false,webPreferences:{session:ses,sandbox:true,nodeIntegration:false,contextIsolation:true}});
   try{
    await view.loadURL('https://memory-fixture.example/article');
    assert.equal(await view.webContents.executeJavaScript('localStorage.length'),0,'Storage leaked into a reused context');
    await view.webContents.executeJavaScript("localStorage.setItem('previous','secret');sessionStorage.setItem('previous','secret')");
    await ses.cookies.set({url:'https://memory-fixture.example',name:'previous',value:'secret',secure:true});
   }finally{view.destroy();await lease.release();}
   assert.equal(await ses.getCacheSize(),0);
  }));
  if([4,19,39].includes(round)){await memory(`${(round+1)*2} renders`);console.log("Render progress",(round+1)*2);}
 }
 assert.equal(contexts.size,2);await pool.close();
 const fixture=path.join(directory,'fixture.ts');
 await fs.writeFile(fixture,`import {observeReaderImage} from ${JSON.stringify(path.join(root,'src/renderer/reader-image-loader.ts'))};
import {retainReaderImage} from ${JSON.stringify(path.join(root,'src/renderer/reader-image-resource.ts'))};
let created=0,revoked=0;const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=blob=>{created++;return create(blob)};URL.revokeObjectURL=url=>{revoked++;return revoke(url)};
const scroll=document.createElement('div');scroll.className='reader-scroll';scroll.style.cssText='height:600px;overflow:auto';document.body.append(scroll);
const cleanups=[];for(let i=0;i<40;i++){const figure=document.createElement('figure');figure.style.height='500px';figure.innerHTML='<img width="480" height="240"><figcaption>Image '+i+'</figcaption>';scroll.append(figure);const img=figure.querySelector('img');cleanups.push(observeReaderImage(img,'fixture','https://example.com/'+i+'.svg',src=>img.src=src,code=>{throw new Error(code)}));}
window.metrics=()=>({created,revoked,live:created-revoked,scrollHeight:scroll.scrollHeight,loaded:[...document.images].filter(i=>i.src.startsWith('blob:')&&i.complete&&i.naturalWidth>0).length});
window.scrollToImage=i=>document.images[i].scrollIntoView({block:'center'});
window.pin=()=>{const img=document.images[0];window.previewUrl=img.src;const release=retainReaderImage(img.src);const preview=new Image();preview.src=img.src;window.preview=preview;window.unpin=release;};
window.dispose=()=>cleanups.forEach(c=>c());`);
 await require('esbuild').build({entryPoints:[fixture],outfile:path.join(directory,'fixture.js'),bundle:true,platform:'browser',logLevel:'silent'});
 await fs.writeFile(path.join(directory,'index.html'),'<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'unsafe-inline\'; img-src blob: data:"></head><body><script src="fixture.js"></script></body></html>');
 let imageReads=0,network=0;
 ipcMain.handle('entry:load-image',()=>{imageReads++;return {mime:'image/svg+xml',bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="480" height="240"><rect width="480" height="240" fill="blue"/></svg>')};});
 ipcMain.handle('entry:cancel-image',()=>{});
 window=new BrowserWindow({show:false,width:1000,height:900,webPreferences:{preload:path.join(root,'dist/main/main/preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
 window.webContents.session.webRequest.onBeforeRequest((details,callback)=>{if(/^https?:/.test(details.url)){network++;callback({cancel:true});}else callback({});});
 await window.loadFile(path.join(directory,'index.html'));
 const evaluate=code=>window.webContents.executeJavaScript(code);
 await until(()=>evaluate('window.metrics?.().loaded>0'));
 const before=await evaluate('metrics()');await evaluate('pin()');const scroll=[];
 for(const index of [10,20,30,39,0]){
  await evaluate(`scrollToImage(${index})`);
  await until(()=>evaluate(`document.images[${index}].src.startsWith('blob:')&&document.images[${index}].complete&&document.images[${index}].naturalWidth===480`));
  await new Promise(r=>setTimeout(r,100));const stats=await evaluate('metrics()');scroll.push({index,...stats});
  assert.equal(stats.scrollHeight,before.scrollHeight,'Eviction changed the article height');assert.ok(stats.live<=10,'Distant image resources accumulated');
  assert.ok(await evaluate('preview.complete&&preview.naturalWidth===480'),'Offscreen eviction invalidated zoom preview');
 }
 await evaluate('unpin();dispose()');const after=await evaluate('metrics()');assert.equal(after.live,0);assert.equal(network,0);
 console.log(JSON.stringify({contexts:contexts.size,renders:80,samples,imageReads,network,scroll,after},null,2));
 window.destroy();host.destroy();clearTimeout(deadline);await fs.rm(directory,{recursive:true,force:true});app.exit(0);
}).catch(async error=>{console.error(error);clearTimeout(deadline);window?.destroy();host?.destroy();await pool?.close();if(directory)await fs.rm(directory,{recursive:true,force:true});app.exit(1);});
