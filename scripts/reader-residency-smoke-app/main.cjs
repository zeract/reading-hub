// Bounded DOM/heap regression. Optional baseline is a local Git revision;
// optional real-library body is read-only and never sent over the network.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('node:fs/promises'),syncFs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),base=path.join(root,'dist/main');
const directory=syncFs.mkdtempSync(path.join(os.tmpdir(),'reading-hub-residency-'));
app.setPath('userData',path.join(directory,'browser'));app.on('window-all-closed',()=>{});
const deadline=setTimeout(()=>{console.error('Residency audit timed out');app.exit(1);},120000);
let host,window,sql;const metrics=[];
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const until=async condition=>{for(let i=0;i<100;i++){if(await condition())return;await wait(40);}throw new Error('DOM condition timed out');};
const evaluate=code=>window.webContents.executeJavaScript(code);
async function measure(label){
 await window.webContents.debugger.sendCommand('HeapProfiler.collectGarbage');await wait(50);
 const heap=await window.webContents.debugger.sendCommand('Runtime.getHeapUsage');
 const dom=await window.webContents.debugger.sendCommand('Memory.getDOMCounters');
 const footprint=execFileSync('vmmap',['-summary',String(window.webContents.getOSProcessId())],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).match(/^Physical footprint:\s+([^\n]+)/m)?.[1];
 const result={label,heapBytes:heap.usedSize,nodes:dom.nodes,documents:dom.documents,footprint};metrics.push(result);console.log('Measured',JSON.stringify(result));return result;
}
app.whenReady().then(async()=>{
 host=new BrowserWindow({show:false});
 const baseline=process.env.READING_HUB_BENCHMARK_BASE;
 const baselineSource=baseline?execFileSync('git',['show',`${baseline}:src/renderer/library-pane.tsx`],{cwd:root,encoding:'utf8'}):undefined;
 const fixture=path.join(directory,'fixture.tsx');
 await fs.writeFile(fixture,`import React,{useState} from ${JSON.stringify(path.join(root,'node_modules/react/index.js'))};
import {createRoot} from ${JSON.stringify(path.join(root,'node_modules/react-dom/client.js'))};
import {Timeline} from ${JSON.stringify(path.join(root,'src/renderer/library-pane.tsx'))};
${baseline?'import {Timeline as Baseline} from "baseline:timeline";':''}
import {ReaderView} from ${JSON.stringify(path.join(root,'src/renderer/reader-view.tsx'))};
import {ReaderPreferencesProvider} from ${JSON.stringify(path.join(root,'src/renderer/reader-preferences-context.tsx'))};
const mode=new URLSearchParams(location.search).get('mode');
const source={id:'source',title:'Fixture',kind:'rss'};
const initial=Array.from({length:4000},(_,i)=>({id:String(i),sourceId:'source',url:'https://example.com/'+i,canonicalUrl:'https://example.com/'+i,title:'Technical article '+i+' · '+('中文技术标题 English '.repeat(i%3+1)),summary:'Variable summary '.repeat(i%4+1),author:'Author',contentHash:String(i),read:false,favorite:false,createdAt:1}));
function Fixture(){const [entries,setEntries]=useState(initial);const [search,setSearch]=useState('');const [selected,setSelected]=useState();
const Component=${baseline?"mode==='baseline'?Baseline:Timeline":"Timeline"};
window.dropFirst=()=>setEntries(current=>current.slice(1));window.prepend=()=>setEntries(current=>[{...initial[0],id:'new'},...current]);window.resetQuery=()=>setSearch('new query');
if(mode==='reader')return <ReaderPreferencesProvider><ReaderView entry={window.card} onUpdateEntry={async()=>true} favoriteUpdating={false} readerOnly={false} onToggleReaderOnly={()=>{}} onOpenSettings={()=>{}}/></ReaderPreferencesProvider>;
return <Component entries={entries} sourceById={new Map([['source',source]])} libraryView="all" entrySearch={search} readingEntryId={selected} hasMoreEntries loadingEntries={false} loadFailed={false} busy={false} loadingMoreEntries={false} onLoadMore={()=>{}} onReload={()=>{}} onAddSource={()=>{}} onClearNotice={()=>{}} onEntrySearchChange={setSearch} isEntryUpdating={()=>false} onDismissEntry={async entry=>setEntries(current=>current.filter(e=>e.id!==entry.id))} onOpenEntry={entry=>setSelected(entry.id)} onUpdateEntry={async(entry,field,value)=>{setEntries(current=>current.map(e=>e.id===entry.id?{...e,[field]:value}:e));return true;}}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`);
 await require('esbuild').build({entryPoints:[fixture],outfile:path.join(directory,'fixture.js'),bundle:true,platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},nodePaths:[path.join(root,'node_modules')],logLevel:'silent',plugins:[{name:'chunk-url',setup(build){build.onResolve({filter:/\?chunk-url$/},()=>({path:'ai',namespace:'chunk-url'}));build.onLoad({filter:/.*/,namespace:'chunk-url'},()=>({contents:'export default \"./unused-ai.js\"',loader:'js'}));}},...(baseline?[{name:'baseline',setup(build){build.onResolve({filter:/^baseline:/},args=>({path:args.path,namespace:'baseline'}));build.onLoad({filter:/.*/,namespace:'baseline'},()=>({contents:baselineSource,loader:'tsx',resolveDir:path.join(root,'src/renderer')}));}}]:[])]});
 const css=(await fs.readFile(path.join(root,'src/renderer/styles.css'),'utf8')).replaceAll('./fonts/',new URL('file://'+path.join(root,'src/renderer/fonts/')).href);
 await fs.writeFile(path.join(directory,'fixture.html'),'<html><head><style>'+css+' .timeline{height:100vh;width:340px;box-sizing:border-box}.reader-view{width:100vw;height:100vh}</style></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
 const newWindow=async(mode,card)=>{
  window=new BrowserWindow({show:false,width:1024,height:800,webPreferences:{preload:path.join(base,'main/preload.js'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  window.webContents.session.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(_details,cb)=>cb({cancel:true}));
  window.webContents.on('console-message',event=>{if(event.level==='error')console.log('Fixture console:',event.message.slice(0,160));});
  window.webContents.debugger.attach('1.3');
  console.log('Opening',mode);
  if(card){const html=await fs.readFile(path.join(directory,'fixture.html'),'utf8');await fs.writeFile(path.join(directory,'reader.html'),html.replace('<script src=', '<script>window.card='+JSON.stringify(card).replace(/</g,'\\u003c')+';</script><script src='));}
  await window.loadFile(path.join(directory,card?'reader.html':'fixture.html'),{query:{mode}});console.log('Loaded',mode);
  await evaluate('document.fonts.ready');await wait(150);
 };
 for(const mode of baseline?['baseline','virtual']:['virtual']){
  await newWindow(mode);await until(()=>evaluate('document.querySelectorAll(".entry-card").length>0'));
  const count=await evaluate('document.querySelectorAll(".entry-card").length');
  if(mode==='baseline')assert.equal(count,4000);else assert.ok(count<40);
  console.log('List',mode,count);await measure(mode);
  if(mode==='virtual'){
   await evaluate('document.querySelector(".timeline").scrollTop=document.querySelector(".timeline").scrollHeight/2');
   await until(()=>evaluate('[...document.querySelectorAll("[data-index]")].some(e=>+e.dataset.index>1000&&+e.dataset.index<3000)'));
   await wait(100);
   const anchor=await evaluate(`(()=>{const sc=document.querySelector('.timeline').getBoundingClientRect();const row=[...document.querySelectorAll('[data-index]')].find(e=>e.getBoundingClientRect().top>=sc.top&&e.getBoundingClientRect().top<sc.bottom-200);return {id:row.dataset.entryId,top:row.getBoundingClientRect().top};})()`);
   await evaluate('dropFirst()');await wait(150);
   const top=await evaluate(`document.querySelector('[data-entry-id="${anchor.id}"]').getBoundingClientRect().top`);
   assert.ok(Math.abs(top-anchor.top)<3,`Deletion moved scroll anchor: ${top-anchor.top}`);
   window.webContents.focus();
   await evaluate('prepend()');await wait(150);
   const prependedTop=await evaluate(`document.querySelector('[data-entry-id="${anchor.id}"]').getBoundingClientRect().top`);
   assert.ok(Math.abs(prependedTop-top)<3,'Prepend moved scroll anchor');
   await evaluate(`document.querySelector('[data-entry-id="${anchor.id}"] .entry-main').focus()`);await wait(50);
   await evaluate(`document.querySelector('[data-entry-id="${anchor.id}"] .entry-actions button:last-child').focus()`);
   window.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});window.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});await wait(100);
   assert.equal(await evaluate('document.activeElement.closest("[data-entry-id]")?.dataset.entryId'),String(Number(anchor.id)+1));
   await evaluate('document.querySelector(".timeline").style.width="260px"');window.webContents.setZoomFactor(1.25);await wait(250);
   assert.ok(await evaluate(`(()=>{const rows=[...document.querySelectorAll('[data-index]')].map(e=>({index:+e.dataset.index,rect:e.getBoundingClientRect()})).sort((a,b)=>a.index-b.index);return rows.every((row,i)=>!i||row.index!==rows[i-1].index+1||Math.abs(row.rect.top-rows[i-1].rect.bottom)<2);})()`),'Resized dynamic rows overlap or leave gaps');
   window.webContents.setZoomFactor(1);await evaluate('document.querySelector(".timeline").style.width="340px"');await wait(150);
   await evaluate('document.querySelector(".timeline").scrollTop=document.querySelector(".timeline").scrollHeight');await wait(150);
   assert.ok(await evaluate('document.querySelectorAll(".entry-card").length<40'));
   await evaluate('resetQuery()');await wait(100);assert.equal(await evaluate('document.querySelector(".timeline").scrollTop'),0);
   console.log('Virtual scroll, focus neighbours, deletion anchor and query reset passed');
  }
  window.webContents.debugger.detach();window.destroy();window=undefined;
 }
 // Real stored document + synthetic derived tree; no model and no user writes.
 console.log('Preparing reader fixture');
 const Database=require(path.join(root,'node_modules/better-sqlite3'));
 const file=process.env.READING_HUB_RESIDENCY_DB;
 let article,store,card;
 if(file){
  sql=new Database(file,{readonly:true,fileMustExist:true});
  const row=sql.prepare("SELECT entry_id FROM article_documents WHERE variant='' AND quality>=2 LIMIT 1").get();assert.ok(row);
  store=new(require(path.join(base,'main/persistence/article-store.js')).ArticleStore)(sql);article=store.read(row.entry_id);
  card={...sql.prepare('SELECT id,title,original_url AS url FROM entries WHERE id=?').get(row.entry_id),sourceId:'source',canonicalUrl:article.url,contentHash:'fixture',read:true,favorite:false,createdAt:1};
 }else{
  const document=require(path.join(base,'main/article-document.js')).articleDocumentFromHtml('<h2>Local document</h2>'+Array.from({length:1200},(_,i)=>'<p>Paragraph '+i+' · '+('Structured document text. '.repeat(5))+'</p>').join(''));
  article={entryId:'local',title:'Local document',url:'https://example.com/local',renderProfile:'standard',document,contentHtml:require(path.join(base,'shared/article-document.js')).articleDocumentHtml(document)};
  card={id:'local',sourceId:'source',title:article.title,url:article.url,canonicalUrl:article.url,contentHash:'fixture',read:true,favorite:false,createdAt:1};
 }
 console.log('Reader fixture prepared');
 const project=require(path.join(base,'shared/reader-presentation.js')).readerPresentation;
 let fullReads=0,metadataReads=0,bodyReads=0;
 const rewrite={entryId:card.id,jobId:'fixture',status:'complete',settings:{provider:'deepseek',model:'fixture',effort:'default'},completedChunks:1,totalChunks:1,updatedAt:1,hasResult:true};
 ipcMain.handle('entry:read-content',()=>{bodyReads++;return {kind:'article',article:project(article)};});
 ipcMain.handle('entry:cancel-read',()=>{});
 ipcMain.handle('rewrite:get',(_event,_id,metadataOnly)=>{if(metadataOnly){metadataReads++;return rewrite;}fullReads++;return {...rewrite,result:{content:{...article.document,provenance:'rewrite'},sourceUrl:article.url,sourceTitle:article.title,provider:'deepseek',model:'fixture',createdAt:1,sourceHash:'fixture',promptVersion:13}};});
 ipcMain.handle('entry:load-image',(_event,id,url)=>{const data=store?.imageBytes(id,url);if(!data)throw new Error('[IMAGE_MISSING]');return data;});ipcMain.handle('entry:cancel-image',()=>{});
 await newWindow('reader',card);await until(()=>evaluate('!!document.querySelector(".article-body")'));
 assert.equal(fullReads,0);await measure('original-only');
 for(let i=0;i<10;i++){
  await evaluate('document.querySelectorAll("[role=tab]")[1].click()');await until(()=>evaluate('!!document.querySelector(".reader-rewritten .article-body")'));
  await evaluate('document.querySelectorAll("[role=tab]")[0].click()');await until(()=>evaluate('!!document.querySelector(".reader-article:not(.reader-rewritten) .article-body")'));
  assert.equal(await evaluate('document.querySelectorAll(".article-body").length'),1);
  if(i===0||i===9)await measure(`round-trip-${i+1}`);
 }
 assert.equal(fullReads,10);assert.equal(bodyReads,11);
 const firstRound=metrics.find(item=>item.label==='round-trip-1'),lastRound=metrics.find(item=>item.label==='round-trip-10');
 assert.ok(lastRound.nodes<=firstRound.nodes+100);assert.equal(lastRound.documents,1);
 console.log(JSON.stringify({metrics,bodyReads,fullReads,metadataReads,payloadBefore:Buffer.byteLength(JSON.stringify(article)),payloadAfter:Buffer.byteLength(JSON.stringify(project(article))),realLibrary:Boolean(file)},null,2));
 window.webContents.debugger.detach();window.destroy();host.destroy();sql?.close();clearTimeout(deadline);await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});app.exit(0);
}).catch(async error=>{console.error(error);window?.destroy();host?.destroy();sql?.close();clearTimeout(deadline);await fs.rm(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>console.error("Temporary profile cleanup failed"));app.exit(1);});
