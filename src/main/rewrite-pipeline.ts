import { throwIfAborted } from "./cancellation";
import { RewriteContentError, splitRewriteText } from "./rewrite-content";
import type { RewriteStage, RewriteQuality } from "../shared/rewrite";

export type RewriteRunner = (stage: RewriteStage, prompt: string, signal: AbortSignal) => Promise<string>;
type Block = { id: string; text: string };
type Section = { id: string; blocks: Block[] };
type Term = { source: string; target: string };
type Plan = { summary: string; terms: Term[] };
type Issue = { blockId: string; kind: string; message: string; sourceQuote: string };
const ISSUE_KINDS = ["omission", "meaning", "number", "term", "cohesion"];
const WRITE = "根据全文提纲、统一术语和上下文，将本节完整改写为自然简体中文。保留全部事实、限定/否定条件、数字（沿用原始数字写法）、公式和必要代码，不添加原文没有的论断。只输出本节 Markdown，不输出内部段落 ID，不复制相邻节，不另加总结。原文本身的重复实验或重复论述仍需保留，不因相邻内容相似而删减本节。";

/** All sections share one plan. Reviews see source blocks and actual neighbouring drafts. */
export async function runRewritePipeline(text: string, title: string, run: RewriteRunner, signal: AbortSignal,
  progress: (stage: RewriteStage, completed: number, total: number) => void = () => undefined) {
  const sections = makeRewriteSections(text);
  let completed = 0;
  let total = sections.length * 3 + 1;
  let requests = 0;
  const call = async (stage: RewriteStage, material: unknown): Promise<string> => {
    throwIfAborted(signal);
    progress(stage, completed, total);
    const prompt = JSON.stringify(material);
    if (prompt.length > 29_000) throw new RewriteContentError("改写上下文超过安全上限，已有改写仍保留。");
    const answer = await run(stage, prompt, signal);
    throwIfAborted(signal);
    if (!answer.trim() || answer.length >= 39_999) throw new RewriteContentError("改写响应不完整或超过上限，已有改写仍保留。");
    requests++; completed++;
    progress(stage, completed, total);
    return answer.trim();
  };
  const plans: Plan[] = [];
  for (const section of sections) {
    const raw = await call("plan", { instruction: '阅读本节，提炼涵盖核心论点及限定条件的中文提纲（summary，不超过300字），提取最多8个关键术语。source 必须逐字出自本节，target 为统一中文译名（可保留英文缩写）；原文已有的中文术语直接保留，不另换称谓、不添加原文未给出的缩写。只输出 JSON：{"summary":"...","terms":[{"source":"...","target":"..."}]}', title, section });
    plans.push(parsePlan(raw, section));
  }
  const sourceTerms = [...new Map(plans.flatMap(p => p.terms).map(t => [`${t.source}|${t.target}`,t])).values()].slice(0,64);
  const outlineRaw = await call("outline", { instruction: '合并全文结构和术语冲突。原文已有中文术语直接保留，不另换称谓、不添加原文未给出的缩写。同一概念的单复数、大小写及其他词形使用相同译名，不为词形差异创建冲突译名。保持所有节的原始顺序及 ID，每节 summary 不超过200字。术语仅从 candidates 中选取 source，每个 source 只有一个 target，最多64项。只输出 JSON：{"sections":[{"id":"S1","summary":"..."}],"terms":[{"source":"...","target":"..."}]}', title,
    sections: sections.map((s,i) => ({ id: s.id, summary: plans[i].summary })), candidates: sourceTerms });
  const outline = parseOutline(outlineRaw, sections, sourceTerms);
  const drafts: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    drafts.push(await call("write", { instruction: WRITE, title, outline, section: sections[i],
      previousEnding: drafts[i-1]?.slice(-1000) || "", nextSummary: outline.sections[i+1]?.summary || "" }));
    assertDraftSize(drafts[i]);
  }
  let repairs = 0;
  // Forward review: a later section sees the already repaired previous ending.
  // Revisions cannot change another section, so its source coverage stays valid.
  for (let i = 0; i < sections.length; i++) {
    const review = async () => {
      let validationFeedback = "";
      for (let attempt = 0; attempt < 2; attempt++) {
        const raw = await call("review", { instruction: '你是原文对照编辑，请独立审查，不要因稿件流畅而默认正确。逐个原文 block 检查论点、数字、否定/范围限定、因果、公式、引用是否保留或误解；同时检查统一术语与相邻稿的衔接；只报告有证据的实质问题，不把个人文风偏好、等义表达或原文本身重复的实验/论述算作错误，不要求添加原文没有的过渡结论。原文优先于提纲和术语表，若术语表有误应保留原文含义而非要求错误译名。允许首次出现时括注原词，不将此当作术语不一致。每个问题只能引用其 blockId 对应 block 的原文，不按稿件段落或观察序号推算 ID。coverage 必须逐个列出本节所有 blockId，不能漏项。问题 sourceQuote 必须逐字引用对应原文 block（衔接问题可为空），message 为具体修订建议。只输出 JSON：{"coverage":[{"blockId":"B1","covered":true}],"issues":[{"blockId":"B1","kind":"omission|meaning|number|term|cohesion","message":"...","sourceQuote":"..."}]}。没有问题时 issues 为 []。', title, outline, section: sections[i], draft: drafts[i], validationFeedback,
          previousEnding: drafts[i-1]?.slice(-1000) || "", nextOpening: drafts[i+1]?.slice(0,1000) || "" });
        try { return parseReview(raw, sections[i]); } catch (error) {
          if (attempt === 1 || !(error instanceof RewriteContentError)) throw error;
          total++;
          validationFeedback = "上次检查的 JSON 未通过验证：" + error.message + "。请重新完整检查所有原文 block，确保 ID 与逐字引文一一匹配。";
        }
      }
      return invalid();
    };
    let issues = await review();
    if (issues.length) {
      total += 2;
      const revised = await call("revise", { instruction: `${WRITE} 仅修复 issues 指出的问题，并保留稿件中正确的内容；修订后会重新对照原文检查。`, title, outline, section: sections[i], draft: drafts[i], issues,
        previousEnding: drafts[i-1]?.slice(-1000) || "", nextSummary: outline.sections[i+1]?.summary || "" });
      assertDraftSize(revised);
      drafts[i] = revised; repairs++;
      issues = await review();
      if (issues.length) throw new RewriteContentError(`第 ${i+1} 节修订后仍有 ${issues.length} 项对照问题（${[...new Set(issues.map(issue => issueLabel(issue.kind)))].join("、")}），未替换已有改写。可更换模型后重试。`);
    }
  }
  const markdown = drafts.join("\n\n");
  if (markdown.length > 240_000) throw new RewriteContentError("改写超过保存上限，已有改写仍保留。");
  const quality: RewriteQuality = { version: 1, reviewedSections: sections.length, reviewedBlocks: sections.reduce((n,s)=>n+s.blocks.length,0), repairedSections: repairs, requests, terms: outline.terms };
  return { markdown, quality };
}

function assertDraftSize(text: string) {
  if (text.length > 13_000) throw new RewriteContentError("单节改写过长，无法完整对照检查；已有改写仍保留。");
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
function invalid(detail = ""): never { throw new RewriteContentError(`模型返回的提纲或对照检查格式不完整，未替换已有改写；请重试或更换模型。${detail}`); }
function json(text: string): any {
  try { const v=JSON.parse(text.replace(/^```(?:json)?\s*\n/i, "").replace(/\n```\s*$/, "")); if(!v || typeof v!=="object" || Array.isArray(v)) return invalid(); return v; }
  catch { return invalid(); }
}
function string(v: unknown, max: number): v is string { return typeof v === "string" && Boolean(v.trim()) && v.length <= max; }
function terms(v: unknown, max: number): Term[] {
  if(!Array.isArray(v) || v.length > max || v.some(t => !t || !string(t.source,80) || !string(t.target,100))) return invalid();
  if(new Set(v.map(t=>t.source.toLocaleLowerCase())).size !== v.length) return invalid();
  return v.map(t=>({source:t.source.trim(),target:t.target.trim()}));
}
function parsePlan(raw: string, section: Section): Plan {
  const value=json(raw); if(!string(value.summary,300)) return invalid();
  const selected=terms(value.terms,8);
  const canonical = selected.map(term => {
    // Terminology identity is case-insensitive; persist the actual source spelling.
    const pattern = new RegExp(term.source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu");
    const source = section.blocks.map(block => pattern.exec(block.text)?.[0]).find(Boolean);
    if (!source) return invalid();
    return { source, target: term.target };
  });
  return { summary:value.summary,terms:canonical };
}
function parseOutline(raw: string, sections: Section[], candidates: Term[]) {
  const value=json(raw);
  if(!Array.isArray(value.sections) || value.sections.length!==sections.length || value.sections.some((s:any,i:number)=>!s || s.id!==sections[i].id || !string(s.summary,300))) return invalid();
  const selected=terms(value.terms,64).map(term => {
    const source = candidates.find(c=>c.source.toLowerCase()===term.source.toLowerCase())?.source;
    if (!source) return invalid();
    return {source, target:term.target};
  });
  const result={sections:value.sections.map((s:any)=>({id:s.id,summary:s.summary})),terms:selected};
  if(JSON.stringify(result).length > 9000) return invalid();
  return result;
}
export function parseReview(raw: string, section: Section): Issue[] {
  const value=json(raw); const ids=section.blocks.map(b=>b.id);
  if(!Array.isArray(value.coverage) || value.coverage.length!==ids.length || new Set(value.coverage.map((c:any)=>c?.blockId)).size!==ids.length
    || value.coverage.some((c:any)=>!c || !ids.includes(c.blockId) || typeof c.covered!=="boolean") || !Array.isArray(value.issues) || value.issues.length>24) return invalid();
  const issues: Issue[] = value.issues.map((issue:any)=> {
    const block=section.blocks.find(b=>b.id===issue?.blockId);
    if(!block || !ISSUE_KINDS.includes(issue.kind) || !string(issue.message,500) || typeof issue.sourceQuote!=="string" || issue.sourceQuote.length>500
      || (issue.kind!=="cohesion" && !issue.sourceQuote.trim())) return invalid();
    if (issue.sourceQuote && !block.text.includes(issue.sourceQuote)) return invalid(`问题引文不属于原文段落 ${block.id}。`);
    return {blockId:issue.blockId,kind:issue.kind,message:issue.message,sourceQuote:issue.sourceQuote};
  });
  for(const coverage of value.coverage) if(!coverage.covered && !issues.some(i=>i.blockId===coverage.blockId)) issues.push({blockId:coverage.blockId,kind:"omission",message:"原文此段未完整覆盖，请补齐。",sourceQuote:section.blocks.find(b=>b.id===coverage.blockId)!.text.slice(0,240)});
  return issues;
}
function issueLabel(kind: string) { return ({omission:"遗漏",meaning:"含义偏差",number:"数字",term:"术语",cohesion:"衔接"} as Record<string,string>)[kind]; }
