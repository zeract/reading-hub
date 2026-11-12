// @vitest-environment jsdom
import {act,useRef} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {EntryWindow,entryWindowRange} from '../src/renderer/entry-window';
let container:HTMLDivElement,root:Root;
function Fixture({count=2000}:{count?:number}){const ref=useRef<HTMLDivElement>(null);return <div ref={ref}><EntryWindow ids={Array.from({length:count},(_,i)=>String(i))} scrollRef={ref} render={i=><button>Entry {i}</button>}/></div>;}
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 vi.stubGlobal('ResizeObserver',class{observe(){}unobserve(){}disconnect(){}});
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({width:320,height:600,top:0,left:0,right:320,bottom:600,x:0,y:0,toJSON(){}});
 vi.spyOn(HTMLElement.prototype,'clientHeight','get').mockReturnValue(600);vi.spyOn(HTMLElement.prototype,'clientWidth','get').mockReturnValue(320);
 vi.spyOn(HTMLElement.prototype,'offsetHeight','get').mockReturnValue(190);vi.spyOn(HTMLElement.prototype,'offsetWidth','get').mockReturnValue(320);
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('bounds a large list and exposes logical position/count to assistive technology',async()=>{
 await act(async()=>root.render(<Fixture/>));
 expect(container.querySelectorAll('button').length).toBeLessThan(30);
 const first=container.querySelector('[role=listitem]')!;
 expect(first.getAttribute('aria-posinset')).toBe('1');expect(first.getAttribute('aria-setsize')).toBe('2000');
 expect(container.querySelector('[data-index="1999"]')).not.toBeNull();
});
it('keeps small lists fully mounted and releases virtual observers on shrink',async()=>{
 await act(async()=>root.render(<Fixture/>));await act(async()=>root.render(<Fixture count={3}/>));expect(container.querySelectorAll('button')).toHaveLength(3);expect(container.querySelector('.is-virtual')).toBeNull();
});
it('pins focus neighbours and both native keyboard entry points without retaining intermediate rows',()=>{
 const range={startIndex:500,endIndex:510,count:2000,overscan:6};
 const rows=entryWindowRange(range,20);expect(rows).toContain(0);expect(rows).toContain(1999);expect(rows).toEqual(expect.arrayContaining([19,20,21]));expect(rows).not.toContain(300);expect(rows.length).toBeLessThan(30);
});

it.each([true,false])('preserves identity geometry when a prepended row is measured before read-back=%s',async(resizeFirst)=>{
 const {Virtualizer}=await import('@tanstack/virtual-core');
 let ids=Array.from({length:1000},(_,i)=>String(i)),report!:(offset:number,scrolling:boolean)=>void;
 const fakeWindow={performance,requestAnimationFrame:()=>1,cancelAnimationFrame:()=>{}};
 const element={scrollTop:0,scrollHeight:200000,clientHeight:800,ownerDocument:{defaultView:fakeWindow},addEventListener(){},removeEventListener(){}};
 const options=()=>({count:ids.length,getScrollElement:()=>element as any,estimateSize:()=>190,getItemKey:(i:number)=>ids[i],initialRect:{width:340,height:800},anchorTo:'end' as const,followOnAppend:false as const,scrollEndThreshold:0,
  observeElementRect:(_v:any,cb:any)=>{cb({width:340,height:800});return()=>{}},observeElementOffset:(_v:any,cb:any)=>{report=cb;return()=>{}},scrollToFn:(offset:number,{adjustments=0}:any)=>{element.scrollTop=offset+adjustments;},onChange:()=>{}});
 const virtualizer=new Virtualizer(options()),dispose=virtualizer._didMount();virtualizer._willUpdate();report(0,false);virtualizer.getVirtualItems();element.scrollTop=5000;report(5000,true);
 const saved=virtualizer.getVirtualItems().find(item=>item.end>5000)!,id=ids[saved.index],before=saved.start-element.scrollTop;
 ids=['new',...ids];virtualizer.setOptions(options());virtualizer.getVirtualItems();virtualizer._willUpdate();
 if(!resizeFirst)report(element.scrollTop,true);virtualizer.resizeItem(0,260);virtualizer.getVirtualItems();report(element.scrollTop,true);
 expect(virtualizer.getVirtualItems().find(item=>item.key===id)!.start-element.scrollTop).toBe(before);dispose();
});
it.each([true,false])('keeps the same row/within-row offset after an internal equal-length reorder with resize-before-readback=%s',async(resizeFirst)=>{
 const {Virtualizer}=await import('@tanstack/virtual-core');
 let ids=Array.from({length:1000},(_,i)=>String(i)),report!:(offset:number,scrolling:boolean)=>void,padding=0;
 const frames:Array<(time:number)=>void>=[],fakeWindow={performance,requestAnimationFrame:(callback:(time:number)=>void)=>{frames.push(callback);return frames.length;},cancelAnimationFrame:()=>{}};
 const element={scrollTop:0,scrollHeight:200000,clientHeight:800,ownerDocument:{defaultView:fakeWindow},addEventListener(){},removeEventListener(){}};
 const options=()=>({count:ids.length,getScrollElement:()=>element as any,estimateSize:()=>190,getItemKey:(i:number)=>ids[i],initialRect:{width:340,height:800},anchorTo:'end' as const,followOnAppend:false as const,scrollEndThreshold:0,scrollPaddingStart:padding,
  observeElementRect:(_v:any,cb:any)=>{cb({width:340,height:800});return()=>{}},observeElementOffset:(_v:any,cb:any)=>{report=cb;return()=>{}},scrollToFn:(offset:number,{adjustments=0}:any)=>{element.scrollTop=offset+adjustments;},onChange:()=>{}});
 const virtualizer=new Virtualizer(options()),dispose=virtualizer._didMount();virtualizer._willUpdate();report(0,false);virtualizer.getVirtualItems();element.scrollTop=5000;report(5000,true);
 const saved=virtualizer.getVirtualItems().find(item=>item.end>5000)!,id=ids[saved.index],inside=5000-saved.start,before=saved.start-element.scrollTop;
 const next=[...ids];next.splice(saved.index,1);next.splice(saved.index+4,0,id);ids=next;padding=-inside;
 virtualizer.setOptions(options());virtualizer.getVirtualItems();virtualizer.scrollToIndex(ids.indexOf(id),{align:'start'});
 if(!resizeFirst)report(element.scrollTop,true);virtualizer.resizeItem(0,260);virtualizer.getVirtualItems();report(element.scrollTop,true);
 for(let i=0;i<10&&frames.length;i++){const batch=frames.splice(0);batch.forEach(callback=>callback(performance.now()));report(element.scrollTop,false);}
 expect(virtualizer.getVirtualItems().find(item=>item.key===id)!.start-element.scrollTop).toBe(before);dispose();
});
