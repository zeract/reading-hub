import {expect,it} from "vitest";
import {protectRewriteAssets,restoreRewriteAssets} from "../src/main/rewrite-assets";
import {runRewritePipeline} from "../src/main/rewrite-pipeline";

it("translates anchor text while keeping signed balanced URLs, images and numbered equations exact",()=>{
 const source=String.raw`Read [the report](<https://example.com/a_(b)?sig=$x&v=2>). ![figure](<https://example.com/plot.png>)

$$
x_{t+1}=y\tag{7}
$$

Use INLINECODE and [7](<https://example.com/p#eq7>).`.replace("INLINECODE",()=>"`$literal$`");
 const p=protectRewriteAssets(source);
 expect(p.text).not.toContain('https://');expect(p.text).not.toContain('x_{t+1}');
 const output=restoreRewriteAssets(p.text.replace('the report','研究报告'),p);
 expect(output).toBe(source.replace('the report','研究报告'));
 expect(p.atoms.map(a=>a.kind)).toEqual(['image','formula','code','reference']);
});
it("preserves escaped anchor brackets and nested destination parentheses",()=>{
 const source=String.raw`See [label \[one\]](https://example.com/a_(b)).`;
 const p=protectRewriteAssets(source);expect(p.links).toHaveLength(1);
 expect(restoreRewriteAssets(p.text,p)).toBe(String.raw`See [label \[one\]](<https://example.com/a_(b)>).`);
});
it("does not interpret Markdown or TeX inside code",()=>{
 const text='```python\n[code](https://example.com)\n\n$x$\n```';
 const p=protectRewriteAssets(text);expect(p.atoms).toHaveLength(1);expect(p.links).toHaveLength(0);expect(restoreRewriteAssets(p.text,p)).toBe(text);
});
it.each(['missing','duplicate','empty','unclosed'])("rejects %s structural data before replacing a saved section",kind=>{
 const p=protectRewriteAssets('[report](<https://example.com>) $x$');
 let answer=p.text;
 if(kind==='missing')answer=answer.replace(`⟦${p.atoms[0].id}⟧`,'');
 if(kind==='duplicate')answer+=`⟦${p.atoms[0].id}⟧`;
 if(kind==='empty')answer=answer.replace('report','');
 if(kind==='unclosed')answer=answer.replace(`⟦/${p.links[0].id}⟧`,'');
 expect(()=>restoreRewriteAssets(answer,p)).toThrow('未完整保留');
});
it("restores protected assets before checkpointing in one model call",async()=>{
 const saved:string[][]=[];let calls=0;
 const r=await runRewritePipeline('Read [a report](<https://example.com/a>) and $x_1$.','Test',async(_stage,prompt)=>{
  calls++;const material=JSON.parse(prompt);return material.section.blocks.map((b:any)=>b.text).join('\n\n').replace('a report','一份报告');
 },new AbortController().signal,undefined,{save:d=>saved.push(d)});
 expect(calls).toBe(1);expect(r.markdown).toBe('Read [一份报告](<https://example.com/a>) and $x_1$.');expect(saved[0][0]).toBe(r.markdown);expect(r.markdown).not.toContain('⟦RH');
});
it("protects formulas inside translated link labels",()=>{
 const p=protectRewriteAssets(String.raw`See [policy $\pi_\theta$](<https://example.com/p>)`);
 const result=restoreRewriteAssets(p.text.replace('policy','策略'),p);expect(result).toBe(String.raw`See [策略 $\pi_\theta$](<https://example.com/p>)`);
});
