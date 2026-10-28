import {readerImageUrl,releaseReaderImage} from './reader-image-resource';
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
  let disposed=false,terminal=false,near=false,retained=true,epoch=0,job:Job|undefined,requestId:string|undefined,release:(()=>void)|undefined,objectUrl:string|undefined;
  const stop=()=>{
    epoch++;if(job){job.active=false;const index=queue.indexOf(job);if(index>=0)queue.splice(index,1);job=undefined;}
    if(requestId){void window.reader.cancelArticleImage(requestId).catch(()=>undefined);requestId=undefined;}
    release?.();release=undefined;
  };
  const evict=()=>{
    stop();
    if(objectUrl){
      // A tiny inert image retains the original intrinsic dimensions, so
      // eviction cannot collapse a figure or move the reader's scroll anchor.
      const w=element.naturalWidth||element.width||1,h=element.naturalHeight||element.height||1;
      loaded('data:image/svg+xml,'+encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"></svg>`));
      releaseReaderImage(objectUrl);objectUrl=undefined;
    }
  };
  const admit=()=>{
    if(disposed||terminal||job||objectUrl||!retained)return;
    const version=epoch;
    job={active:true,run:async()=>{
      if(disposed||version!==epoch)return;
      const id=`image-${crypto.randomUUID()}`;requestId=id;
      await new Promise<void>(resolve=>{
        release=resolve;
        void window.reader.loadArticleImage(entryId,url,id).then(resource=>{
          if(!disposed&&version===epoch){objectUrl=readerImageUrl(resource);loaded(objectUrl);}
        }).catch(error=>{if(!disposed&&version===epoch){terminal=true;failed(imageFailureCode(error));}})
          .finally(()=>{if(requestId===id){requestId=undefined;release=undefined;}resolve();});
      });
    }};
    queue.push(job);drain();
  };
  // rootMargin must expand the actual scrollport. With the window as root,
  // the nested reader's overflow clip defeats both retention/prefetch margins.
  const root=element.closest('.reader-scroll');
  const observer=typeof IntersectionObserver==="undefined" ? undefined : new IntersectionObserver(entries=>{
    near=entries.some(e=>e.isIntersecting);if(near)admit();
  },{root,rootMargin:"300px"});
  const retention=typeof IntersectionObserver==='undefined'?undefined:new IntersectionObserver(entries=>{
    retained=entries.some(e=>e.isIntersecting);if(!retained)evict();else if(near)admit();
  },{root,rootMargin:'1200px'});
  const decodeError=()=>{if(objectUrl&&!disposed){terminal=true;stop();releaseReaderImage(objectUrl);objectUrl=undefined;failed('DECODE');}};
  element.addEventListener('error',decodeError);
  retention?.observe(element);
  if(observer)observer.observe(element);else admit();
  return ()=>{
    disposed=true;observer?.disconnect();retention?.disconnect();element.removeEventListener('error',decodeError);stop();
    if(objectUrl){releaseReaderImage(objectUrl);objectUrl=undefined;}
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
