import {describe,it,expect} from "vitest";
import {decodeRewriteResult,bindRewriteBlock,validRewriteDocument,documentHash} from "../src/main/rewrite-document";
import {runRewritePipeline} from "../src/main/rewrite-pipeline";
import {rewriteModelResponse} from "./support/rewrite-model";
const legacy={markdown:"# 中文\n\n[说明](https://example.com/a)\n\n![图](https://example.com/a.png)",provider:"deepseek",model:"model",sourceUrl:"https://example.com",sourceTitle:"Article",sourceHash:"abc",createdAt:1,promptVersion:7};
describe("persistent rewrite structure",()=>{
 it("indexes old prose losslessly and never invents source bindings",()=>{
  const result=decodeRewriteResult(JSON.stringify(legacy));
  expect(result.markdown).toBe(legacy.markdown);expect(result.document?.provenance).toBe("derived-only");
  expect(result.document?.blocks.every(b=>!b.sourceHash)).toBe(true);
  expect(decodeRewriteResult(JSON.stringify(result))).toEqual(result);
 });
 it("rejects incompatible versions and corrupt records without interpreting them",()=>{
  expect(()=>decodeRewriteResult('{')).toThrow();expect(()=>decodeRewriteResult(JSON.stringify({...legacy,schemaVersion:99}))).toThrow("更新版本");
 });
 it("rejects stale offsets and rebuilds only a derived index",()=>{
  const block=bindRewriteBlock("B1","S1","Original",legacy.markdown,0);
  const result=decodeRewriteResult(JSON.stringify({...legacy,document:{version:1,provenance:"source-bound",blocks:[{...block,hash:"wrong"}]}}));
  expect(result.document?.provenance).toBe("derived-only");
 });
 it("persists generation ownership without storing source prose and resumes without a model call",async()=>{
  const source="# Original heading\n\nSome original prose with [a link](https://example.com/a) and $x_1$.";
  let checkpoint:any;
  const result=await runRewritePipeline(source,"Title",async(_stage,prompt)=>rewriteModelResponse(prompt,"write"),new AbortController().signal,undefined,{save:(drafts,document)=>{checkpoint={drafts,document};}});
  expect(validRewriteDocument(result.document,result.markdown)).toBe(true);
  expect(result.document.blocks.every(b=>Boolean(b.sourceHash))).toBe(true);
  expect(JSON.stringify(result.document)).not.toContain("Some original prose");
  expect(result.document.blocks[1].assets.some(a=>a.destination==="https://example.com/a")).toBe(true);
  const resumed=await runRewritePipeline(source,"Title",async()=>{throw Error("unexpected model call");},new AbortController().signal,undefined,checkpoint);
  expect(resumed.document).toEqual(result.document);expect(resumed.markdown).toBe(result.markdown);
 });
 it("keeps pre-upgrade checkpoint prose without guessing ownership or spending tokens",async()=>{
  const result=await runRewritePipeline("Original paragraph","Title",async()=>{throw Error("unexpected model call");},new AbortController().signal,undefined,{drafts:["已有中文"]});
  expect(result.markdown).toBe("已有中文");expect(result.document.provenance).toBe("derived-only");expect(result.document.blocks[0].hash).toBe(documentHash("已有中文"));
 });
});
