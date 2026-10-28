// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {observeReaderImage} from '../src/renderer/reader-image-loader';
import {retainReaderImage} from '../src/renderer/reader-image-resource';
import {blobUrls,imageResource} from './reader-image-fixture';
let observers:{callback:IntersectionObserverCallback;options:IntersectionObserverInit}[],urls:ReturnType<typeof blobUrls>,load:ReturnType<typeof vi.fn>,cancel:ReturnType<typeof vi.fn>;
const cleanups:(()=>void)[]=[];
beforeEach(()=>{
  urls=blobUrls();observers=[];
  load=vi.fn().mockResolvedValue(imageResource());cancel=vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window,'reader',{configurable:true,value:{loadArticleImage:load,cancelArticleImage:cancel}});
  vi.stubGlobal('IntersectionObserver',class{constructor(callback:IntersectionObserverCallback,options:IntersectionObserverInit){observers.push({callback,options});}observe(){}disconnect(){}});
});
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup();vi.unstubAllGlobals();});
async function intersect(index:number,visible:boolean){observers[index].callback([{isIntersecting:visible}] as IntersectionObserverEntry[],{} as IntersectionObserver);await new Promise(resolve=>setTimeout(resolve,0));}
function image(){const element=document.createElement('img');element.width=480;element.height=240;
 const failed=vi.fn();cleanups.push(observeReaderImage(element,'entry','https://example.com/image.png',src=>{element.src=src;},failed));return {element,failed};}
it('loads only nearby images, evicts distant data without collapsing layout, reloads locally and pins a preview',async()=>{
 const {element}=image();expect(load).not.toHaveBeenCalled();
 expect(observers.map(o=>o.options.rootMargin)).toEqual(['300px','1200px']);
 await intersect(0,true);const initial=element.src;expect(initial).toBe('blob:fixture-1');
 const release=retainReaderImage(initial);
 await intersect(1,false);
 expect(element.src).toContain('data:image/svg+xml,');expect(decodeURIComponent(element.src)).toContain('width="480" height="240"');
 expect(urls.revoke).not.toHaveBeenCalled();
 await intersect(1,true);expect(element.src).toBe('blob:fixture-2');expect(load).toHaveBeenCalledTimes(2);
 release();release();expect(urls.revoke.mock.calls).toEqual([[initial]]);
 cleanups.pop()!();expect(urls.revoke.mock.calls).toEqual([[initial],['blob:fixture-2']]);
});
it('uses the nested reader scrollport so overflow clipping cannot defeat retention margins',()=>{
 const scroll=document.createElement('div');scroll.className='reader-scroll';
 const element=document.createElement('img');scroll.append(element);
 cleanups.push(observeReaderImage(element,'entry','https://example.com/image.png',()=>{},()=>{}));
 expect(observers.every(observer=>observer.options.root===scroll)).toBe(true);
});
it('cancels an evicted request and ignores its late result after a new request starts',async()=>{
 let finish!:(resource:ReturnType<typeof imageResource>)=>void;
 load.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));const {element}=image();
 await intersect(0,true);await intersect(1,false);expect(cancel).toHaveBeenCalledTimes(1);
 await intersect(1,true);expect(load).toHaveBeenCalledTimes(2);const current=element.src;
 finish(imageResource());await Promise.resolve();expect(element.src).toBe(current);expect(urls.create).toHaveBeenCalledTimes(1);
});
it('rejects invalid binary resources and does not retry permanent failures during scroll',async()=>{
 load.mockResolvedValue({mime:'text/html',bytes:new Uint8Array([1])});const {failed}=image();
 await intersect(0,true);expect(failed).toHaveBeenCalledWith('LOAD');expect(urls.create).not.toHaveBeenCalled();
 await intersect(1,false);await intersect(1,true);expect(load).toHaveBeenCalledTimes(1);
});
