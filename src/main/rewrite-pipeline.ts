import { throwIfAborted } from "./cancellation";
import { RewriteContentError, splitRewriteText } from "./rewrite-content";
import { REWRITE_STAGE_LABELS } from "../shared/rewrite";
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
  // Every structured stage uses the same bounded validation/retry contract.
  const structured = async <T>(stage: "plan" | "outline" | "review", location: string,
    material: Record<string, unknown>, parse: (raw: string) => T): Promise<T> => {
    let validationFeedback = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await call(stage, { ...material, validationFeedback });
      try { return parse(raw); } catch (error) {
        if (!(error instanceof RewriteStructureError)) throw error;
        if (attempt === 1) throw new RewriteContentError(`${location}“${REWRITE_STAGE_LABELS[stage]}”的响应格式不完整：${error.detail}已自动重试一次，已有改写仍保留。请重新生成。`);
        total++;
        validationFeedback = `上次响应未通过校验：${error.detail}请依据原始材料重新返回完整 JSON，修正上述字段；不要返回说明文字或省略其他字段。`;
      }
    }
    throw new Error("Unreachable structured response attempt");
  };
  const plans: Plan[] = [];
  for (const section of sections) {
    const plan = await structured("plan", `第 ${plans.length+1} 节`, { instruction: '阅读本节，提炼涵盖核心论点及限定条件的中文提纲（summary，目标300字以内，最多600字符），提取最多8个关键术语。source 最多80字符且须摘自本节，target 最多100字符，为统一中文译名（可保留英文缩写）；原文已有的中文术语直接保留，不另换称谓、不添加原文未给出的缩写。只输出 JSON：{"summary":"...","terms":[{"source":"...","target":"..."}]}', title, section }, raw => parsePlan(raw, section));
    plans.push(plan);
  }
  const sourceTerms = [...new Map(plans.flatMap(p => p.terms).map(t => [`${t.source}|${t.target}`,t])).values()].slice(0,64);
  const outline = await structured("outline", "全文", { instruction: '合并全文结构和术语冲突。原文已有中文术语直接保留，不另换称谓、不添加原文未给出的缩写。同一概念的单复数、大小写及其他词形使用相同译名，不为词形差异创建冲突译名。保持所有节的原始顺序及 ID，每节 summary 目标200字以内，最多600字符。术语仅从 candidates 中选取 source，每个 source 只有一个 target，最多64项。整个 JSON 最多9000字符，source 最多80字符，target 最多100字符。只输出 JSON：{"sections":[{"id":"S1","summary":"..."}],"terms":[{"source":"...","target":"..."}]}', title,
    sections: sections.map((s,i) => ({ id: s.id, summary: plans[i].summary })), candidates: sourceTerms }, raw => parseOutline(raw, sections, sourceTerms));
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
    const review = () => structured("review", `第 ${i+1} 节`, { instruction: '你是原文对照编辑，请独立审查，不要因稿件流畅而默认正确。逐个原文 block 检查论点、数字、否定/范围限定、因果、公式、引用是否保留或误解；同时检查统一术语与相邻稿的衔接；只报告有证据的实质问题，不把个人文风偏好、等义表达或原文本身重复的实验/论述算作错误，不要求添加原文没有的过渡结论。原文优先于提纲和术语表，若术语表有误应保留原文含义而非要求错误译名。允许首次出现时括注原词，不将此当作术语不一致。每个问题只能引用其 blockId 对应 block 的原文，不按稿件段落或观察序号推算 ID。coverage 必须逐个列出本节所有 blockId，不能漏项。问题 sourceQuote 必须逐字引用对应原文 block（衔接问题可为空），每个 sourceQuote 和 message 最多500字符，issues 最多24项。message 为具体修订建议。只输出 JSON：{"coverage":[{"blockId":"B1","covered":true}],"issues":[{"blockId":"B1","kind":"omission|meaning|number|term|cohesion","message":"...","sourceQuote":"..."}]}。没有问题时 issues 为 []。', title, outline, section: sections[i], draft: drafts[i],
          previousEnding: drafts[i-1]?.slice(-1000) || "", nextOpening: drafts[i+1]?.slice(0,1000) || "" }, raw => parseReview(raw, sections[i]));
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
class RewriteStructureError extends RewriteContentError {
  constructor(readonly detail: string) { super(`响应格式不完整：${detail}`); }
}
function invalid(detail = "字段缺失或类型不正确。"): never { throw new RewriteStructureError(detail); }
function json(text: string): any {
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
  let value: unknown;
  try { value = JSON.parse(fenced ? fenced[1] : text.trim()); }
  catch { return invalid("须返回完整、有效的 JSON 对象（不能带说明文字或截断内容）。"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("顶层须为 JSON 对象。");
  return value;
}
/** Whitespace/casing differences do not change term identity; quotes remain case-sensitive. */
function sourceMatch(source: string, text: string, ignoreCase = false): string | undefined {
  const pattern = source.trim().split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  return pattern ? new RegExp(pattern, ignoreCase ? "iu" : "u").exec(text)?.[0] : undefined;
}
function string(v: unknown, max: number): v is string { return typeof v === "string" && Boolean(v.trim()) && v.length <= max; }
function terms(v: unknown, max: number): Term[] {
  if(!Array.isArray(v) || v.length > max || v.some(t => !t || !string(t.source,80) || !string(t.target,100))) return invalid(`terms 须为数组，最多 ${max} 项；每项 source 为1至80字符、target 为1至100字符的字符串。`);
  const unique = new Map<string, Term>();
  for (const term of v) {
    const source = term.source.trim().replace(/\s+/gu, " ");
    const target = term.target.trim();
    const key = source.toLowerCase();
    if (unique.has(key) && unique.get(key)!.target !== target) return invalid("同一 source 存在冲突译名，请统一 target。");
    unique.set(key, {source, target});
  }
  return [...unique.values()];
}
function parsePlan(raw: string, section: Section): Plan {
  const value=json(raw); if(!string(value.summary,600)) return invalid("summary 须为1至600字符的字符串，请精简提纲而非截断原文。");
  const selected=terms(value.terms,8);
  const canonical = selected.map(term => {
    // Terminology identity is case-insensitive; persist the actual source spelling.
    const source = section.blocks.map(block => sourceMatch(term.source, block.text, true)).find(Boolean);
    if (!source) return invalid("terms.source 须摘自本节原文，不可使用未出现的词形、译文或概括；无法确认的术语可不列出。");
    return { source, target: term.target };
  });
  return { summary:value.summary,terms:canonical };
}
function parseOutline(raw: string, sections: Section[], candidates: Term[]) {
  const value=json(raw);
  if(!Array.isArray(value.sections) || value.sections.length!==sections.length || value.sections.some((s:any,i:number)=>!s || s.id!==sections[i].id)) return invalid("sections 须完整包含原始节 ID 且顺序一致，请勿遗漏或新建节。");
  value.sections.forEach((s:any,i:number) => {
    if (!string(s.summary,600)) invalid(`sections.${sections[i].id}.summary 须为1至600字符的字符串，请精简此节提纲。`);
  });
  const selected=terms(value.terms,64).map(term => {
    const source = candidates.find(c=>c.source.toLowerCase().replace(/\s+/gu," ")===term.source.toLowerCase())?.source;
    if (!source) return invalid("terms.source 只能选择 candidates 已有的 source，不可改写或合并名称。");
    return {source, target:term.target};
  });
  const result={sections:value.sections.map((s:any)=>({id:s.id,summary:s.summary})),terms:selected};
  if(JSON.stringify(result).length > 9000) return invalid("全文提纲 JSON 超过9000字符，请缩短各节 summary 和术语表，保留全部节 ID。");
  return result;
}
export function parseReview(raw: string, section: Section): Issue[] {
  const value=json(raw); const ids=section.blocks.map(b=>b.id);
  if(!Array.isArray(value.coverage) || value.coverage.length!==ids.length || new Set(value.coverage.map((c:any)=>c?.blockId)).size!==ids.length
    || value.coverage.some((c:any)=>!c || !ids.includes(c.blockId) || typeof c.covered!=="boolean") || !Array.isArray(value.issues) || value.issues.length>24) return invalid("coverage 须逐一包含本节全部 blockId 且不能重复，covered 须为布尔值；issues 须为数组且最多24项。");
  const issues: Issue[] = value.issues.map((issue:any)=> {
    const block=section.blocks.find(b=>b.id===issue?.blockId);
    if(!block || !ISSUE_KINDS.includes(issue.kind) || !string(issue.message,500) || typeof issue.sourceQuote!=="string" || issue.sourceQuote.length>500
      || (issue.kind!=="cohesion" && !issue.sourceQuote.trim())) return invalid("issues 须引用本节 blockId；kind 为 omission/meaning/number/term/cohesion 之一；message 为1至500字符，sourceQuote 最多500字符且非衔接问题不能为空。");
    const quote = issue.sourceQuote ? sourceMatch(issue.sourceQuote, block.text) : "";
    if (issue.sourceQuote && !quote) return invalid(`问题引文不属于原文段落 ${block.id}。`);
    return {blockId:issue.blockId,kind:issue.kind,message:issue.message,sourceQuote:quote!};
  });
  for(const coverage of value.coverage) if(!coverage.covered && !issues.some(i=>i.blockId===coverage.blockId)) issues.push({blockId:coverage.blockId,kind:"omission",message:"原文此段未完整覆盖，请补齐。",sourceQuote:section.blocks.find(b=>b.id===coverage.blockId)!.text.slice(0,240)});
  return issues;
}
function issueLabel(kind: string) { return ({omission:"遗漏",meaning:"含义偏差",number:"数字",term:"术语",cohesion:"衔接"} as Record<string,string>)[kind]; }
