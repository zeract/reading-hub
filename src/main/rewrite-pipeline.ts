import { bindRewriteBlock, validRewriteDocument, indexLegacyRewrite } from "./rewrite-document";
import type { RewriteBlockRelation, RewriteDocument } from "../shared/rewrite";
import { protectRewriteSection, restoreRewriteBlocks, RewriteProtocolError, rewriteModelText, isFixedRewriteBlock } from "./rewrite-assets";
import { throwIfAborted } from "./cancellation";
import { RewriteContentError, splitRewriteText } from "./rewrite-content";
import type { RewriteRequestStage, RewriteQuality } from "../shared/rewrite";

export type RewriteRunner = (stage: RewriteRequestStage, prompt: string, signal: AbortSignal) => Promise<string>;
type Block = { id: string; text: string };
type Section = { id: string; blocks: Block[] };
const WRITE = "将本节完整改写为自然简体中文，保留所有论点、限定/否定条件、数字、公式、代码、原文链接和图片 Markdown；资产保留在原有正文位置，链接目标由程序依据 ID 恢复，不生成或修改网址，不添加原文没有的结论。参考已生成中文的用词，专业术语首次出现可保留英文括注，后文沿用同一译法。previousEnding 和 opening 仅用于术语与衔接，不重复输出；这是内部处理片段，允许列表跨节延续，不为每节另加开头或总结。正文使用 Markdown，不用摘要代替正文；只返回规定的 JSON 对象，不加说明。原文中的重复论述也应保留。数学排版：已有 TeX 公式保留原式及分隔符；原文用普通字符或 Unicode 写出的数学表达式也须转为标准 TeX，行内使用 $...$，独立公式使用 $$ 换行包围。按原文语义保留下标和上下标分组（例如下一时刻的状态下标是整个 t+1），条件概率竖线、希腊字母和括号不得丢失；不要将公式降为无分隔符的普通文字。代码块、行内代码、网址和普通标识符不作公式转换。";
type Progress = (stage: RewriteRequestStage, completed: number, total: number) => void;

function assertDraft(text: string) {
  if (!text.trim() || text.length > 13_000) throw new RewriteContentError("改写响应为空或超过完整保存上限；已完成分段和已有改写仍保留。");
}
async function request(run: RewriteRunner, stage: RewriteRequestStage, material: unknown, signal: AbortSignal) {
  throwIfAborted(signal);
  const prompt = JSON.stringify(material);
  if (prompt.length > 29_000) throw new RewriteContentError("改写上下文超过安全上限，已有改写仍保留。");
  const answer = await run(stage, prompt, signal);
  throwIfAborted(signal);
  if (!answer.trim() || answer.length >= 39_999) throw new RewriteContentError("模型响应不完整或超过上限，已有改写仍保留。");
  return answer.trim();
}
/** At most one request per section; immutable blocks stay local. No model review gates saving. */
export async function runRewritePipeline(text: string, title: string, run: RewriteRunner, signal: AbortSignal,
  progress: Progress = () => undefined,
  resume: { drafts?: string[]; document?: RewriteDocument; save?(drafts: string[], document: RewriteDocument): void } = {}) {
  const sections = makeRewriteSections(text);
  const drafts = [...(resume.drafts || [])];
  if (drafts.length > sections.length) throw new RewriteContentError("改写恢复记录与原文不一致。");
  drafts.forEach(assertDraft);
  // Retain old derived checkpoints without spending tokens or guessing source ownership.
  const savedText=drafts.join("\n\n");
  const blocks: RewriteBlockRelation[] = !drafts.length ? []
    : validRewriteDocument(resume.document,savedText) ? [...resume.document.blocks]
    : indexLegacyRewrite(savedText).blocks;
  const provenance = blocks.some(b=>!b.sourceHash) ? "derived-only" as const : "source-bound" as const;
  let requests = 0;
  for (let i = drafts.length; i < sections.length; i++) {
    throwIfAborted(signal);
    progress("write", i, sections.length);
    const allMaterials = protectRewriteSection(sections[i].blocks);
    const materials=allMaterials.filter(block=>!isFixedRewriteBlock(block));
    let generated:string[]=[];
    if(materials.length) {
      const answer = await request(run, "write", { instruction: WRITE + '输出格式为 {"blocks":[{"id":"原块ID","text":"本块中文 Markdown"}]}。逐一返回 section.blocks 中的所有块，每个 ID 恰好一次；不要输出任何段落边界标记。JSON 字符串里的换行、引号、反斜杠按 JSON 规范转义。保留块内标题级别、列表嵌套、表格行列和引用结构。链接格式是 [中文锚文本](链接ID)，例如 [使用指南](B1_L1)，只翻译原有锚文本并自然融入句子，不添加（链接）、来源或裸网址；目标 ID 由程序替换成原网址。独立的 ⟦...A...⟧ 是不可改写资产，须留在所属块中，每个恰好一次；也接受与原文完全相同的 Markdown 资产，二者只能选一个。不能改变、重复或借用其他块的资产。assets 是只读理解上下文，其中未出现在 section.blocks 中的完整代码、图片或公式块由程序原位保留，不输出这些块或其内容。', title, section: {...sections[i], blocks: materials.map(b=>({id:b.id,text:rewriteModelText(b.material)}))}, assets:allMaterials.flatMap(b=>b.material.atoms.map(a=>({id:a.id,kind:a.kind,source:a.source,blockId:b.id}))),
        opening: i > 1 ? drafts[0].slice(0, 1200) : "", previousEnding: drafts[i-1]?.slice(-1500) || "" }, signal);
      try {
        generated=restoreRewriteBlocks(answer,materials);
      }
      catch(error){
        if(error instanceof RewriteProtocolError)throw new RewriteContentError(`第 ${i+1}/${sections.length} 节：${error.message}`);
        throw error;
      }
      requests++;
    }
    let generatedIndex=0;
    const restored=allMaterials.map((block,j)=>isFixedRewriteBlock(block) ? sections[i].blocks[j].text : generated[generatedIndex++]);
    const draft = restored.join("\n\n");
    let offset = drafts.length ? drafts.join("\n\n").length + 2 : 0;
    restored.forEach((target,j) => {
      const source=sections[i].blocks[j];
      blocks.push(bindRewriteBlock(source.id,sections[i].id,source.text,target,offset));
      offset += target.length + 2;
    });
    assertDraft(draft);
    if ([...drafts, draft].join("\n\n").length > 240_000) throw new RewriteContentError("改写超过保存上限，已有改写仍保留。");
    throwIfAborted(signal);
    drafts.push(draft);
    resume.save?.([...drafts], {version:1,provenance,blocks:[...blocks]});
    progress("write", i+1, sections.length);
  }
  const markdown = drafts.join("\n\n");
  if (markdown.length > 240_000) throw new RewriteContentError("改写超过保存上限，已有改写仍保留。");
  const quality: RewriteQuality = {version:1, reviewedSections:0, reviewedBlocks:0, repairedSections:0, requests, terms:[]};
  return { markdown, sections: drafts, quality, schemaVersion:1 as const, document:{version:1 as const,provenance,blocks} };
}

export function makeRewriteSections(text: string): Section[] {
  // Use the same paragraph/fence-aware splitter for both section and block identities.
  const blocks = splitRewriteText(text, 9000, true).map((text,i)=>({ id: `B${i+1}`, text }));
  const sections: Section[] = []; let group: Block[] = []; let length = 0;
  for (const block of blocks) {
    if (group.length && (length + block.text.length > 6000 || group.length >= 24)) {
      sections.push({ id: `S${sections.length+1}`, blocks: group }); group=[]; length=0;
    }
    group.push(block); length += block.text.length;
  }
  if(group.length) sections.push({ id:`S${sections.length+1}`, blocks:group });
  if(!sections.length || sections.length > 48) throw new RewriteContentError("文章结构超出本次改写上限，请在原文中阅读。");
  return sections;
}
