const {app,BrowserWindow,ipcMain,session}=require('electron');
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..'),base=path.join(root,'dist/main/main');
const phase=process.argv[2],directory=process.argv[3];
const generic=process.env.READING_HUB_OFFLINE_GENERIC==='1';
app.setPath('userData',path.join(directory,'browser-'+phase));
const image='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const content='<h2>离线文档</h2><p>'+('离线保存正文。 '.repeat(40))+'</p><table><tr><th>字段</th><td>value</td></tr></table><pre><code>const offline = true;</code></pre><p>$x^2$</p><img src="https://example.com/one.gif"><img src="https://example.com/two.svg">';
let db,library,sync,window;
app.whenReady().then(async()=>{
 const {ReadingDatabase}=require(path.join(base,'database.js'));const {ArticleReader}=require(path.join(base,'article-reader.js'));
 const {ArticleLibrary}=require(path.join(base,'article-library.js'));const {RssConnector}=require(path.join(base,'connectors.js'));
 const {ConnectorRegistry}=require(path.join(base,'connector-registry.js'));const {SyncManager}=require(path.join(base,'sync-manager.js'));
 db=new ReadingDatabase(path.join(directory,'library.sqlite'));let network=0,removed=false;
 const http={getText:async url=>{network++;assert.equal(phase,'collect','Offline main process attempted network');if(generic&&url==='https://example.com/post')throw new (require(path.join(base,'access-challenge.js')).AccessChallengeError)();if(generic&&url==='https://example.com/blog')return {url,status:200,contentType:'text/html',text:'<link rel="alternate" type="application/rss+xml" href="https://example.com/feed">'};return {url,status:200,etag:'fixture',contentType:'application/rss+xml',text:'<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Fixture</title>'+(!removed?'<item><title>Stored fixture</title><link>https://example.com/post</link><content:encoded><![CDATA['+content+']]></content:encoded></item>':'')+'</channel></rss>'};},getImageDataUrl:async url=>{network++;assert.equal(phase,'collect','Offline image attempted network');return url.endsWith('.svg') ? "data:image/svg+xml;base64,"+require(path.join(base,"reader-svg-image.js")).sanitizeSvgImage(Buffer.from('<svg width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10" fill="blue"/></svg>')).toString("base64") : image;}};
 library=new ArticleLibrary(db,new ArticleReader(http,{render:async()=>{network++;throw new Error('No remote renderer allowed');}}),http);
 library.start();
 const until=async predicate=>{for(let i=0;i<100;i++){if(await predicate())return;await new Promise(r=>setTimeout(r,50));}throw new Error('Offline fixture did not settle');};
 if(phase==='collect'){
  const source=db.createSource({url:generic?'https://example.com/blog':'https://example.com/feed',title:'Fixture',kind:generic?'generic':'rss',pollingEnabled:true});const registry=new ConnectorRegistry();registry.register(new RssConnector(http));sync=new SyncManager(db,registry,undefined,undefined,library);
  if(generic){const {contentNormalizer}=require(path.join(base,'content-normalizer.js'));db.saveEntries([contentNormalizer.normalize({url:'https://example.com/post',title:'Stored fixture'},source)]);await library.read(db.listEntries(source.id)[0],source);}else await sync.syncSource(source.id);const entry=db.listEntries(source.id)[0];
  await until(()=>db.articles.image(entry.id,'https://example.com/two.svg'));
  assert.ok(db.articles.image(entry.id,'https://example.com/one.gif'));
  await library.worker;
  removed=true;if(!generic)await sync.syncSource(source.id);else{const before=network;await library.read(entry,source);assert.equal(network,before);}assert.ok(db.articles.read(entry.id));
  console.log('Collected structured Feed document and both images; Feed removal preserved them.');
 }else{
  const entry=db.listEntries()[0];const article=await library.read(entry,db.getSource(entry.sourceId));assert.ok(article.savedAt);
  let imageReads=0;
  ipcMain.handle('entry:load-image',(_event,id,url)=>{imageReads++;assert.equal(id,entry.id);return library.loadImage(entry,url);});
  ipcMain.handle('entry:cancel-image',()=>undefined);
  let browserNetwork=0;session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,callback)=>{browserNetwork++;callback({cancel:true});});
  const fixturePath=path.join(directory,'fixture.tsx');
  await fs.writeFile(fixturePath,`import React,{useRef} from ${JSON.stringify(path.join(root,'node_modules/react/index.js'))};
import {createRoot} from ${JSON.stringify(path.join(root,'node_modules/react-dom/client.js'))};
import {ArticleBody} from ${JSON.stringify(path.join(root,'src/renderer/article-body.tsx'))};
import {useReaderImages} from ${JSON.stringify(path.join(root,'src/renderer/use-reader-images.ts'))};
const article=${JSON.stringify(article)};
function Fixture(){const ref=useRef(null);useReaderImages(article.entryId,article,ref);return <ArticleBody document={article.document} bodyRef={ref}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`);
  await require('esbuild').build({entryPoints:[fixturePath],outfile:path.join(directory,'fixture.js'),bundle:true,platform:'browser',jsx:'automatic',nodePaths:[path.join(root,'node_modules')],define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  await fs.writeFile(path.join(directory,'fixture.html'),'<html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\' data: file:; script-src \'self\'; connect-src \'none\'"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  window=new BrowserWindow({show:false,width:1000,height:900,webPreferences:{preload:path.join(base,'preload.js'),contextIsolation:true,sandbox:true,nodeIntegration:false}});
  await window.loadFile(path.join(directory,'fixture.html'));
  await until(()=>window.webContents.executeJavaScript(`(async()=>{for(const img of document.querySelectorAll('img'))img.scrollIntoView();return document.querySelectorAll('img').length===2&&[...document.querySelectorAll('img')].every(i=>i.complete&&i.naturalWidth>0&&i.src.startsWith('data:image/'));})()`));
  await until(()=>imageReads===2);
  const dom=await window.webContents.executeJavaScript(`({text:document.body.textContent,table:document.querySelectorAll('table').length,code:document.querySelector('pre code')?.textContent,math:document.querySelectorAll('.katex').length,images:[...document.querySelectorAll('img')].map(i=>({width:i.naturalWidth,url:i.src}))})`);
  assert.ok(dom.text.includes('离线文档'));assert.equal(dom.table,1);assert.equal(dom.code,'const offline = true;');assert.equal(dom.math,1);assert.equal(dom.images.length,2);assert.equal(network,0);assert.equal(browserNetwork,0);
  console.log('Fresh Electron process, real ArticleBody/image hook: table/code/math and 2/2 images decoded with network disabled.');
 }
 await sync?.close();await library.close();db.close();window?.destroy();app.exit(0);
}).catch(async error=>{console.error(error);await sync?.close();await library?.close();db?.close();app.exit(1);});
