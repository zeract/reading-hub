import type { Source } from "../shared/types";

export type SourceGroup = { id: string; title: string; sources: Source[]; custom: boolean };

const DEFAULT_GROUPS: Array<{ id: string; title: string }> = [
  { id: "web", title: "网页与订阅" },
  { id: "platform", title: "平台动态" },
  { id: "academic", title: "学术追踪" }
];

function defaultGroup(source: Source): { id: string; title: string } {
  if (source.kind === "academic") return DEFAULT_GROUPS[2];
  if (source.config?.sourceProvider === "rsshub") return DEFAULT_GROUPS[1];
  if (source.kind === "zhihu" || source.kind === "zhihu_follow" || source.kind === "x") return DEFAULT_GROUPS[1];
  return DEFAULT_GROUPS[0];
}

/** Groups are a local presentation/folder layer and never alter connector behaviour. */
export function groupSources(sources: Source[]): SourceGroup[] {
  const groups = new Map<string, SourceGroup>();
  for (const source of sources) {
    const customTitle = source.category?.trim();
    const fallback = defaultGroup(source);
    const id = customTitle ? `custom:${customTitle.toLocaleLowerCase("zh-CN")}` : fallback.id;
    const group = groups.get(id) || { id, title: customTitle || fallback.title, sources: [], custom: Boolean(customTitle) };
    group.sources.push(source);
    groups.set(id, group);
  }
  return [...groups.values()]
    .sort((left, right) => {
      const leftDefault = DEFAULT_GROUPS.findIndex((group) => group.id === left.id);
      const rightDefault = DEFAULT_GROUPS.findIndex((group) => group.id === right.id);
      if (leftDefault >= 0 || rightDefault >= 0) return (leftDefault < 0 ? 99 : leftDefault) - (rightDefault < 0 ? 99 : rightDefault);
      return left.title.localeCompare(right.title, "zh-CN");
    })
    .map((group) => ({ ...group, sources: [...group.sources].sort((left, right) => left.title.localeCompare(right.title, "zh-CN")) }));
}
