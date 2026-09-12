import {expect,it} from "vitest";
import {repairLegacyRewrite} from "../src/main/rewrite-legacy-repair";
const source='Read [the report](<https://example.com/report>). ![Equation (7)](<https://example.com/eq.png>)';
it("anchors only an exact Chinese phrase backed by the same original link and restores source images",async()=>{
 const result=await repairLegacyRewrite(source,['他们发表了研究报告 (https://example.com/report)。\n\n(https://example.com/eq.png)'],async(_stage,prompt)=>{
  const p=JSON.parse(prompt);return JSON.stringify(p.paragraphs.flatMap((x:any)=>x.links.map((l:any)=>({id:l.id,anchor:'研究报告',label:'研究报告'}))));
 },new AbortController().signal);
 expect(result.markdown).toContain('[研究报告](<https://example.com/report>)');expect(result.markdown).toContain('![Equation (7)](<https://example.com/eq.png>)');expect(result.markdown).not.toContain('(链接)');expect(result.report).toMatchObject({linked:1,images:1,unknown:0,requests:1});
});
it("does not guess ambiguous repeated phrases or modify code and existing named links",async()=>{
 const text='研究报告与研究报告 (https://example.com/report)。 `https://example.com/report` [已有标签](https://example.com/report)';
 const result=await repairLegacyRewrite(source,[text],async(_s,p)=>JSON.stringify([{id:JSON.parse(p).paragraphs[0].links[0].id,anchor:'研究报告',label:'原报告'}]),new AbortController().signal);
 expect(result.markdown).toContain('研究报告与研究报告 [原报告]');expect(result.markdown).toContain('`https://example.com/report`');expect(result.markdown).toContain('[已有标签](<https://example.com/report>)');expect(result.report.fallback).toBe(1);
});
it("keeps unknown links and rejects an aborted repair without returning a replacement",async()=>{
 const controller=new AbortController();await expect(repairLegacyRewrite(source,['报告 (https://example.com/report)'],async()=>{controller.abort();return '[]';},controller.signal)).rejects.toThrow();
 const r=await repairLegacyRewrite(source,['https://other.example/unknown'],async()=>{throw Error('must not call');},new AbortController().signal);expect(r.markdown).toBe('https://other.example/unknown');expect(r.report.unknown).toBe(1);
});
it("restores an explicit formula number only from a unique matching source equation",async()=>{
 const run=async()=>{throw Error('not needed');};
 const r=await repairLegacyRewrite('$$\nx=y\\tag{7}\n$$',['$$\nx=y\n$$'],run,new AbortController().signal);
 expect(r.markdown).toContain('\\tag{7}');expect(r.report.formulas).toBe(1);
 const ambiguous=await repairLegacyRewrite('$$\nx=y\\tag{7}\n$$\n\n$$\nx=y\\tag{8}\n$$',['$$\nx=y\n$$'],run,new AbortController().signal);expect(ambiguous.markdown).not.toContain('tag');
});
it("repairs a whitespace-broken URL only against a complete declared source URL",async()=>{
 const r=await repairLegacyRewrite('[report](<https://example.com/report>)',['报告 URL https://example. com/report end'],async(_s,p)=>JSON.stringify([{id:JSON.parse(p).paragraphs[0].links[0].id,anchor:'报告',label:'报告'}]),new AbortController().signal);
 expect(r.markdown).toContain('[报告](<https://example.com/report>)');expect(r.report.unknown).toBe(0);
});
