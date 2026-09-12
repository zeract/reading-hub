import { throwIfAborted } from "./cancellation";
import { RewriteContentError, splitRewriteText } from "./rewrite-content";
import type { RewriteRequestStage, RewriteQuality, RewriteIssue, RewriteReview } from "../shared/rewrite";

export type RewriteRunner = (stage: RewriteRequestStage, prompt: string, signal: AbortSignal) => Promise<string>;
type Block = { id: string; text: string };
type Section = { id: string; blocks: Block[] };
type Issue = Omit<RewriteIssue, "sectionId">;
const ISSUE_KINDS = ["omission", "meaning", "number", "term", "cohesion"];
const WRITE = "将本节完整改写为自然简体中文，保留所有论点、限定/否定条件、数字、公式、代码、原文链接和图片 Markdown；图片保留在原有正文位置，链接使用 [文字](<原始网址>)，图片使用 ![说明](<原始网址>)，不要修改网址或把中文标点写进网址，不添加原文没有的结论。参考已生成中文的用词，专业术语首次出现可保留英文括注，后文沿用同一译法。previousEnding 和 opening 仅用于术语与衔接，不重复输出；这是内部处理片段，允许列表跨节延续，不为每节另加开头或总结。只输出本节 Markdown，不输出内部 ID，不用摘要代替正文。原文中的重复论述也应保留。数学排版：已有 TeX 公式保留原式及分隔符；原文用普通字符或 Unicode 写出的数学表达式也须转为标准 TeX，行内使用 $...$，独立公式使用 $$ 换行包围。按原文语义保留下标和上下标分组（例如下一时刻的状态下标是整个 t+1），条件概率竖线、希腊字母和括号不得丢失；不要将公式降为无分隔符的普通文字。代码块、行内代码、网址和普通标识符不作公式转换。";
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
/** One request per section; checkpoints contain derived text only. No model review gates saving. */
export async function runRewritePipeline(text: string, title: string, run: RewriteRunner, signal: AbortSignal,
  progress: Progress = () => undefined,
  resume: { drafts?: string[]; save?(drafts: string[]): void } = {}) {
  const sections = makeRewriteSections(text);
  const drafts = [...(resume.drafts || [])];
  if (drafts.length > sections.length) throw new RewriteContentError("改写恢复记录与原文不一致。");
  drafts.forEach(assertDraft);
  let requests = 0;
  for (let i = drafts.length; i < sections.length; i++) {
    progress("write", i, sections.length);
    const draft = await request(run, "write", { instruction: WRITE, title, section: sections[i],
      opening: i > 1 ? drafts[0].slice(0, 1200) : "", previousEnding: drafts[i-1]?.slice(-1500) || "" }, signal);
    assertDraft(draft);
    if ([...drafts, draft].join("\n\n").length > 240_000) throw new RewriteContentError("改写超过保存上限，已有改写仍保留。");
    drafts.push(draft); requests++;
    resume.save?.([...drafts]);
    progress("write", i+1, sections.length);
  }
  const markdown = drafts.join("\n\n");
  if (markdown.length > 240_000) throw new RewriteContentError("改写超过保存上限，已有改写仍保留。");
  const quality: RewriteQuality = {version:1, reviewedSections:0, reviewedBlocks:0, repairedSections:0, requests, terms:[]};
  return { markdown, sections: drafts, quality };
}

/** Optional source comparison annotates the saved document, never changes or hides its text. */
export async function reviewRewrite(text: string, title: string, drafts: string[], run: RewriteRunner,
  signal: AbortSignal, progress: Progress = () => undefined): Promise<RewriteReview> {
  const sections = makeRewriteSections(text);
  if (sections.length !== drafts.length) throw new RewriteContentError("原文结构已变化，请重新生成改写后再检查。");
  const issues: RewriteIssue[] = [];
  let requests = 0;
  for (let i=0; i<sections.length; i++) {
    let feedback = "";
    for (let attempt=0; attempt<2; attempt++) {
      progress("review", i, sections.length);
      const raw = await request(run, "review", { instruction: '对照本节完整原文和中文稿，只报告有证据的遗漏、含义、数字、术语问题及本节开头与 previousEnding 的衔接问题。不要把个人文风偏好或原文重复当作错误，不要求修改相邻节。仅输出 JSON：{"coverage":[{"blockId":"B1","covered":true}],"issues":[{"blockId":"B1","kind":"omission|meaning|number|term|cohesion","message":"具体问题","sourceQuote":"对应 block 原文引文"}]}。coverage 必须恰好覆盖每个原文 blockId；covered 为 false 必须有对应 issues。issues 最多24项，message 与 sourceQuote 最多500字符，非衔接问题须有原文引文；无问题时 issues 为 []。', title, section: sections[i], draft: drafts[i], previousEnding: drafts[i-1]?.slice(-1000) || "", validationFeedback: feedback }, signal);
      requests++;
      try {
        issues.push(...parseReview(raw, sections[i]).map(issue => ({...issue, sectionId:sections[i].id})));
        break;
      } catch (error) {
        if (!(error instanceof RewriteStructureError)) throw error;
        if (attempt === 1) throw new RewriteContentError(`第 ${i+1} 节检查格式无效，检查未完成；已保存中文仍可阅读。`);
        feedback = error.detail;
      }
    }
    progress("review", i+1, sections.length);
  }
  return {checkedAt:Date.now(), reviewedSections:sections.length, requests, issues};
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
  for(const coverage of value.coverage) if(!coverage.covered && !issues.some(i=>i.blockId===coverage.blockId)) invalid(`原文段落 ${coverage.blockId} 被标为未覆盖，但 issues 未说明具体漏项。请给出明确修订建议及对应原文引文，不能仅标 false。`);
  return issues;
}
