import { expect,it,vi } from "vitest";
const handlers=vi.hoisted(()=>new Map<string,(...args:any[])=>any>());
vi.mock("electron",()=>({ipcMain:{handle:(name:string,callback:any)=>handlers.set(name,callback),removeHandler:(name:string)=>handlers.delete(name)},BrowserWindow:{},dialog:{},shell:{}}));
import { registerIpcHandlers } from "../src/main/ipc-handlers";
import { IPC_CHANNELS } from "../src/shared/ipc";
it("accepts only entry identifiers and non-secret model settings for durable background jobs",async()=>{
 const rewrites={enqueue:vi.fn(()=>({status:"queued"})),configure:vi.fn(s=>s),cancel:vi.fn(),remove:vi.fn()};const drain=registerIpcHandlers({rewrites,database:{}} as never);
 try{
 const generate=handlers.get(IPC_CHANNELS.rewrite.generate)!;
 expect(()=>generate({sender:{}},{url:"https://example.com"})).toThrow();
 await generate({sender:{}} ,"entry");expect(rewrites.enqueue).toHaveBeenCalledWith("entry");
 const review=handlers.get(IPC_CHANNELS.rewrite.review)!;
 expect(()=>review({sender:{}},{body:"never-send"})).toThrow();
 await review({sender:{}},"entry");expect(rewrites.enqueue).toHaveBeenCalledWith("entry","review");
 const configure=handlers.get(IPC_CHANNELS.rewrite.configure)!;
 await configure({sender:{}},{provider:"deepseek",model:"future",effort:"default",apiKey:"never-store",body:"never-send"});
 expect(rewrites.configure).toHaveBeenCalledWith({provider:"deepseek",model:"future",effort:"default"});
 expect(()=>configure({sender:{}},{provider:"unknown",model:"future",effort:"default"})).toThrow();
 }finally{await drain();}
});
