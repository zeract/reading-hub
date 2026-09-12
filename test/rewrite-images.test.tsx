// @vitest-environment jsdom
import {act} from "react";
import {createRoot,type Root} from "react-dom/client";
import {beforeEach,afterEach,it,expect,vi} from "vitest";
import {AiMarkdownContent} from "../src/renderer/ai-markdown";
let root:Root,host:HTMLDivElement;
const load=vi.fn(),cancel=vi.fn();
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);load.mockReset();cancel.mockReset().mockResolvedValue(undefined);Object.defineProperty(window,"reader",{configurable:true,value:{loadArticleImage:load,cancelArticleImage:cancel,openExternal:vi.fn().mockResolvedValue(undefined)}});host=document.createElement('div');document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it("loads through the main-process image proxy and cancels stale article requests",async()=>{
 let late!:(s:string)=>void;load.mockImplementationOnce(()=>new Promise(r=>{late=r;})).mockResolvedValue('data:image/png;base64,new');
 const text='![图](<https://example.com/$s_!signed!/image_(1).png>)';
 await act(async()=>root.render(<AiMarkdownContent entryId="one" text={text}/>));
 expect(load.mock.calls[0][0]).toBe('one');expect(host.querySelector('img')?.getAttribute('src')).toBeNull();
 await act(async()=>root.render(<AiMarkdownContent entryId="two" text={text}/>));
 expect(cancel).toHaveBeenCalledWith(load.mock.calls[0][2]);await act(async()=>late('data:image/png;base64,old'));
 expect(host.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,new');
});
it("does not load images in question answers, and exposes a safe fallback on failure",async()=>{
 load.mockRejectedValue(new Error('network'));const text='![图](https://example.com/image.png)';
 await act(async()=>root.render(<AiMarkdownContent text={text}/>));expect(load).not.toHaveBeenCalled();
 await act(async()=>root.render(<AiMarkdownContent entryId="one" text={text}/>));expect(host.querySelector('.reader-image-failure')).not.toBeNull();expect(host.querySelector('img')).toBeNull();
});
it("does not admit offscreen images and bounds a long article before IPC",async()=>{
 const observations:Array<{element:Element; callback:IntersectionObserverCallback}>=[];
 vi.stubGlobal("IntersectionObserver",class {constructor(readonly callback:IntersectionObserverCallback){} observe(element:Element){observations.push({element,callback:this.callback});} disconnect(){} });
 load.mockImplementation(()=>new Promise(()=>undefined));
 const text=Array.from({length:71},(_,i)=>`![图 ${i}](https://example.com/${i}.png)`).join('\n\n');
 await act(async()=>root.render(<AiMarkdownContent entryId="long" text={text}/>));expect(load).not.toHaveBeenCalled();
 await act(async()=>{for(const o of observations)o.callback([{target:o.element,isIntersecting:true} as IntersectionObserverEntry],{} as IntersectionObserver);});
 expect(load).toHaveBeenCalledTimes(4);
 await act(async()=>root.render(<AiMarkdownContent text="另一篇"/>));expect(cancel).toHaveBeenCalledTimes(4);
 await act(async()=>{});expect(load).toHaveBeenCalledTimes(4);
});
