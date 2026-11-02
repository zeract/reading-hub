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
