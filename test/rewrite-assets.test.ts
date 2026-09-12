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
  calls++;const material=JSON.parse(prompt);return JSON.stringify({blocks:material.section.blocks}).replace('a report','一份报告');
 },new AbortController().signal,undefined,{save:d=>saved.push(d)});
 expect(calls).toBe(1);expect(r.markdown).toBe('Read [一份报告](<https://example.com/a>) and $x_1$.');expect(saved[0][0]).toBe(r.markdown);expect(r.markdown).not.toContain('⟦RH');
});
it("protects formulas inside translated link labels",()=>{
 const p=protectRewriteAssets(String.raw`See [policy $\pi_\theta$](<https://example.com/p>)`);
 const result=restoreRewriteAssets(p.text.replace('policy','策略'),p);expect(result).toBe(String.raw`See [策略 $\pi_\theta$](<https://example.com/p>)`);
});
it("accepts literal inline code only with the same parsed value and multiplicity in its own block",()=>{
 const source='Use ` intent.md ` and ` intent/ `.';const p=protectRewriteAssets(source,'B44');
 const answer=p.text.replace(`⟦${p.atoms[0].id}⟧`,'`intent.md`').replace(`⟦${p.atoms[1].id}⟧`,'``intent/``');
 expect(restoreRewriteAssets(answer,p)).toBe(source);expect(p.atoms[0].id).toBe('B44_A1');
});
it("restores repeated identical inline code occurrences without changing their count",()=>{
 const p=protectRewriteAssets('Use `intent.md`, then review `intent.md`.','B48');
 const answer=p.text.replace(`⟦${p.atoms[0].id}⟧`,'`intent.md`');
 expect(restoreRewriteAssets(answer,p)).toBe('Use `intent.md`, then review `intent.md`.');
 expect(()=>restoreRewriteAssets(answer+' `intent.md`',p)).toThrow('duplicate');
});
it.each(['spec.md','plain','foreign','doubled','inside-fence'])("does not guess a replacement for %s code",kind=>{
 const p=protectRewriteAssets('Use ` intent.md `.','B44');
 const replacement=kind==='spec.md'?'`spec.md`':kind==='plain'?'intent.md':kind==='foreign'?'⟦B48_A1⟧':kind==='doubled'?'`intent.md` `intent.md`':'```\nintent.md\n```';
 expect(()=>restoreRewriteAssets(p.text.replace(`⟦${p.atoms[0].id}⟧`,replacement),p)).toThrow('未完整保留');
});
it("diagnoses exactly which source-owned asset is missing without including source text",()=>{
 const p=protectRewriteAssets('[report](https://example.com) and `private_identifier`.','B44');
 try{restoreRewriteAssets(p.text.replace(`⟦${p.atoms[0].id}⟧`,''),p);throw Error('accepted');}catch(error){expect((error as Error).message).toContain('B44_A1，code，missing');expect((error as Error).message).not.toContain('private_identifier');}
});
it("keeps nested anchor code conservative and unchanged explicit source code readable",()=>{
 const p=protectRewriteAssets('[use `x`](https://example.com)','B44');expect(restoreRewriteAssets(p.text,p)).toBe('[use `x`](<https://example.com>)');
});
it.each(['```ts\nconst x = 1;\n```','![original](<https://example.com/a.png>)','$$\nx_1=1\n$$'])("accepts an exact literal asset without accepting changes or duplicates: %s",source=>{
 const p=protectRewriteAssets(source,'B49');expect(restoreRewriteAssets(source,p)).toBe(source);
 expect(()=>restoreRewriteAssets(source+'\n\n'+source,p)).toThrow('duplicate');
 expect(()=>restoreRewriteAssets(source.replace(/1|original/,'changed'),p)).toThrow('未完整保留');
});

it("accepts source-owned link IDs and exact signed URLs, including nested inline assets",()=>{
 const source='Read [guide `$x[a]$`](<https://example.com/a_(b)?sig=x%2By&v=2#part>) and [equation $x_1$](<https://example.com/eq>).';
 const p=protectRewriteAssets(source,'B114');
 const answer='阅读 [指南 `$x[a]$`](B114_L1) 和 [公式 '+`⟦${p.atoms[1].id}⟧`+'](<https://example.com/eq>)。';
 expect(restoreRewriteAssets(answer,p,true)).toBe('阅读 [指南 `$x[a]$`](<https://example.com/a_(b)?sig=x%2By&v=2#part>) 和 [公式 $x_1$](<https://example.com/eq>)。');
});
it("restores repeated targets and source order without duplicating explicitly identified occurrences",()=>{
 const p=protectRewriteAssets('[first](https://example.com) and [second](https://example.com)','B4');
 expect(restoreRewriteAssets('[第二处](https://example.com) 与 [第一处](B4_L1)',p,true)).toBe('[第二处](<https://example.com>) 与 [第一处](<https://example.com>)');
});
it.each(['missing','wrong-url','foreign-id','duplicate','empty-label','bare-url','extra-image','extra-marker'])("rejects %s without inventing or borrowing link ownership",kind=>{
 const p=protectRewriteAssets('See [guide](https://example.com/guide).','B114');
 let draft='参考 [指南](B114_L1)。';
 if(kind==='missing')draft='参考指南。';
 if(kind==='wrong-url')draft='参考 [指南](https://example.com/guide?modified=1)。';
 if(kind==='foreign-id')draft='参考 [指南](B113_L1)。';
 if(kind==='duplicate')draft+=' [指南](https://example.com/guide)';
 if(kind==='empty-label')draft='参考 [](B114_L1)。';
 if(kind==='bare-url')draft='参考 https://example.com/guide。';
 if(kind==='extra-image')draft+=' ![extra](https://example.com/extra.png)';
 if(kind==='extra-marker')draft+=' ⟦B113_A1⟧';
 expect(()=>restoreRewriteAssets(draft,p,true)).toThrow('未完整保留');
});
it("keeps links inside code opaque and numbered references bound to their original target",()=>{
 const p=protectRewriteAssets('Code `[x](https://example.com/x)` then [7](https://example.com/#eq7), [guide](https://example.com/g).','B5');
 const text=p.text.replace(`⟦${p.links[0].id}⟧guide⟦/${p.links[0].id}⟧`,'[指南](B5_L1)');
 expect(restoreRewriteAssets(text,p,true)).toContain('`[x](https://example.com/x)` then [7](https://example.com/#eq7), [指南](<https://example.com/g>)');
});
