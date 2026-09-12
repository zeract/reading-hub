// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { useArticleRewrite } from "../src/renderer/use-article-rewrite";
import { RewriteVersion,RewrittenArticle } from "../src/renderer/article-rewrite";
import { RewriteSettingsCard } from "../src/renderer/rewrite-settings";
const settings={provider:"deepseek" as const,model:"future",effort:"default"};
const record={entryId:"one",jobId:"job",status:"complete" as const,settings,completedChunks:1,totalChunks:1,updatedAt:1,result:{markdown:"## 中文正文\n\n本地结果",provider:"deepseek" as const,model:"future",createdAt:1,sourceUrl:"https://example.com/one",sourceTitle:"Article",sourceHash:"hash",promptVersion:1}};
let root:Root,container:HTMLDivElement;let get:ReturnType<typeof vi.fn>,generate:ReturnType<typeof vi.fn>;
function View({id}:{id:string}){const state=useArticleRewrite(id);return <><RewriteVersion state={state} onSelect={state.setVisible}/><RewrittenArticle state={state}/></>;}
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);get=vi.fn().mockResolvedValue(record);generate=vi.fn().mockResolvedValue({...record,status:"queued"});Object.defineProperty(window,"reader",{configurable:true,value:{getArticleRewrite:get,generateArticleRewrite:generate,cancelArticleRewrite:vi.fn().mockResolvedValue({...record,status:"cancelled"}),removeArticleRewrite:vi.fn().mockResolvedValue(undefined),getRewriteSettings:vi.fn().mockResolvedValue(settings),configureRewrite:vi.fn(async s=>s),listAiModels:vi.fn().mockResolvedValue({models:[],stale:false})}});container=document.createElement("div");document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();vi.unstubAllGlobals();});
async function click(text:string){await act(async()=>[...container.querySelectorAll("button")].find(b=>b.textContent===text)!.click());}
async function select(value:string){await act(async()=>{const el=container.querySelector('select')!;el.value=value;el.dispatchEvent(new Event('change',{bubbles:true}));});}
it("shows only the saved title and Chinese body without notices, metadata or action buttons",async()=>{
 await act(async()=>root.render(<View id="one"/>));await select("rewrite");expect(generate).not.toHaveBeenCalled();
 expect(container.querySelector(".reader-rewritten h1")?.textContent).toBe("Article");
 for(const text of ["AI 中文改写","本地保存","理解偏差","未进行额外","重新生成改写","删除改写","检查改写","future"])expect(container.textContent).not.toContain(text);
 expect(container.querySelector(".reader-rewritten button")).toBeNull();
 await select("original");expect(container.querySelector(".reader-rewritten")).toBeNull();
});
it("ignores a late article response after switching entries",async()=>{
 let finish!:(v:any)=>void;get.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue(undefined);
 await act(async()=>root.render(<View id="one"/>));await act(async()=>root.render(<View id="two"/>));await act(async()=>finish(record));expect(container.querySelector(".reader-rewritten")).toBeNull();expect(generate).not.toHaveBeenCalled();
});
it("polls background completion without regenerating and releases polling on unmount",async()=>{
 vi.useFakeTimers();get.mockResolvedValueOnce({...record,status:"running"}).mockResolvedValue(record);
 await act(async()=>root.render(<View id="one"/>));await act(async()=>vi.advanceTimersByTimeAsync(2000));expect(container.textContent).toContain("中文改写");expect(generate).not.toHaveBeenCalled();const calls=get.mock.calls.length;await act(async()=>vi.advanceTimersByTimeAsync(6000));expect(get).toHaveBeenCalledTimes(calls);
});
it("saves rewrite settings independently of question settings",async()=>{
 const api=window.reader;const providers=[{id:"deepseek" as const,label:"DeepSeek",model:"learning-model",configured:true,requiresApiKey:true}];
 await act(async()=>root.render(<RewriteSettingsCard providers={providers}/>));
 const input=container.querySelector<HTMLInputElement>('input')!;
 await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")!.set!.call(input,"new-rewrite-model");input.dispatchEvent(new Event("input",{bubbles:true}));});
 await click("保存改写模型");expect(api.configureRewrite).toHaveBeenCalledWith({...settings,model:"new-rewrite-model"});expect(container.textContent).toContain("改写模型已保存");
});

it("lets users select the missing Chinese version without automatically generating",async()=>{
 get.mockResolvedValue(undefined);await act(async()=>root.render(<View id="one"/>));await select("rewrite");
 expect(container.textContent).toContain("生成中文改写");expect(generate).not.toHaveBeenCalled();
 expect(container.querySelector("select")?.value).toBe("rewrite");
 await select("original");expect(container.querySelector(".reader-rewritten")).toBeNull();
});
it("keeps Chinese readable with review issues and failed background checks",async()=>{
 get.mockResolvedValue({...record,status:"failed",error:"检查未完成",result:{...record.result,review:{checkedAt:1,reviewedSections:1,requests:1,issues:[{sectionId:"S16",blockId:"B1",kind:"cohesion",message:"衔接建议",sourceQuote:""}]}}});
 await act(async()=>root.render(<View id="one"/>));await select("rewrite");
 expect(container.textContent).not.toContain("检查未完成");expect(container.textContent).not.toContain("第 16 节");expect(container.querySelector(".article-body")).not.toBeNull();
 expect(container.textContent).not.toContain("改写设置");
});
