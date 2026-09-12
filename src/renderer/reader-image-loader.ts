/** Shared admission for original-image fallback and rewritten images. Offscreen
 * elements never enter IPC; visible work is bounded before the main-process pool. */
type Job = { active: boolean; run(): Promise<void> };
const queue: Job[]=[]; let running=0;
function drain() {
  while(running<4 && queue.length) {
    const job=queue.shift()!; if(!job.active)continue;
    running++;
    void job.run().finally(()=>{running--;drain();});
  }
}
export function observeReaderImage(element: HTMLImageElement, entryId: string, url: string,
  loaded: (data:string)=>void, failed:(code:string)=>void): () => void {
  let disposed=false, admitted=false, requestId:string|undefined, release: (()=>void)|undefined;
  const job:Job={active:true,run:async()=>{
    if(disposed)return;
    requestId=`image-${crypto.randomUUID()}`;
    await new Promise<void>(resolve=>{
      release=resolve;
      void window.reader.loadArticleImage(entryId,url,requestId!).then(data=>{if(!disposed)loaded(data);},
        error=>{if(!disposed)failed(imageFailureCode(error));}).finally(()=>{requestId=undefined;resolve();});
    });
  }};
  const admit=()=>{if(disposed || admitted)return;admitted=true;queue.push(job);drain();};
  const observer=typeof IntersectionObserver==="undefined" ? undefined : new IntersectionObserver(entries=>{
    if(entries.some(e=>e.isIntersecting)){observer!.disconnect();admit();}
  },{rootMargin:"300px"});
  if(observer)observer.observe(element);else admit();
  return ()=>{
    disposed=true;job.active=false;observer?.disconnect();
    const index=queue.indexOf(job);if(index>=0)queue.splice(index,1);
    if(requestId)void window.reader.cancelArticleImage(requestId).catch(()=>undefined);
    release?.();
  };
}
export function imageFailureCode(error:unknown):string {
  const text=error instanceof Error ? error.message : "";
  return /\[IMAGE_([A-Z_0-9]+)\]/.exec(text)?.[1] || "LOAD";
}
export const IMAGE_FAILURE_LABEL="图片未能加载 · 在浏览器中查看原文";
export function replaceReaderImageFailure(image:HTMLImageElement, originalUrl:string, code="DECODE") {
  if(!image.isConnected || image.dataset.readerImageUnavailable==="1")return;
  image.dataset.readerImageUnavailable="1";
  const fallback=document.createElement("a");
  fallback.href=originalUrl;fallback.className="reader-image-failure";
  fallback.dataset.imageFailure=code;fallback.textContent=IMAGE_FAILURE_LABEL;
  image.replaceWith(fallback);
}
