import type { Entry, LibraryCounts, Source } from "../shared/types";
import type { LibraryView } from "./library-view";
import type { SourceGroup } from "./source-groups";
import { AppIcon, SourceIcon } from "./ui-icons";

export function SourceSidebar({ sources, groups, libraryView, activeSourceId, libraryCounts, collapsedGroups, onSelectLibrary, onSelectSource, onToggleGroup, onEditSource, onOpenSettings }: {
  sources: Source[];
  groups: SourceGroup[];
  libraryView: LibraryView;
  activeSourceId?: string;
  libraryCounts: LibraryCounts;
  collapsedGroups: Record<string, boolean>;
  onSelectLibrary: (view: LibraryView) => void;
  onSelectSource: (sourceId?: string) => void;
  onToggleGroup: (groupId: string) => void;
  onEditSource: (source: Source) => void;
  onOpenSettings: () => void;
}) {
  return <aside className="sidebar">
    <nav className="library-nav" aria-label="阅读分类">
      <div className="section-title">阅读</div>
      <button className={`library-filter ${libraryView === "today" && !activeSourceId ? "selected" : ""}`} onClick={() => onSelectLibrary("today")}><span><AppIcon name="today" />今日</span></button>
      <button className={`library-filter ${libraryView === "unread" && !activeSourceId ? "selected" : ""}`} onClick={() => onSelectLibrary("unread")}><span><AppIcon name="unread" />未读</span><em>{libraryCounts.unread}</em></button>
      <button className={`library-filter ${libraryView === "favorite" && !activeSourceId ? "selected" : ""}`} onClick={() => onSelectLibrary("favorite")}><span><AppIcon name="favorite" />收藏</span><em>{libraryCounts.favorite}</em></button>
    </nav>
    <section className="source-section" aria-labelledby="source-heading">
      <div className="section-title" id="source-heading">来源 <span>{sources.length}</span></div>
      <div className="source-list">
        {groups.map((group) => <section className="source-group" key={group.id}>
          <button type="button" className="source-group-heading" onClick={() => onToggleGroup(group.id)} aria-expanded={!collapsedGroups[group.id]}>
            <span className="source-group-label"><AppIcon name={collapsedGroups[group.id] ? "chevron-right" : "chevron-down"} /><AppIcon name="folder" /><span>{group.title}</span></span><em>{group.sources.length}</em>
          </button>
          {!collapsedGroups[group.id] && group.sources.map((source) => (
            <div className="source-row" key={source.id} onContextMenu={(event) => { event.preventDefault(); onEditSource(source); }}>
              <button className={`source-filter ${activeSourceId === source.id ? "selected" : ""}`} onClick={() => onSelectSource(source.id)} onKeyDown={(event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  event.preventDefault();
                  onEditSource(source);
                }
              }} title={`${source.title}（右键配置）`} aria-label={`查看 ${source.title}；右键打开来源设置`}>
                <SourceIcon source={source} /><span className="source-title">{source.title}</span>
              </button>
            </div>
          ))}
        </section>)}
        {!sources.length && <p className="empty-side">先添加一个公开 Feed 或网页。</p>}
      </div>
    </section>
    <footer className="sidebar-footer"><button type="button" className="sidebar-settings-button" onClick={onOpenSettings} aria-label="打开设置" title="设置"><AppIcon name="settings" /><span>设置</span></button></footer>
  </aside>;
}

export function Timeline({ activeSource, libraryView, entries, sourceById, readingEntryId, notice, busy, libraryCounts, onClearNotice, onUpdateEntry, onOpenEntry, onDismissEntry }: {
  activeSource?: Source;
  libraryView: LibraryView;
  entries: Entry[];
  sourceById: Map<string, Source>;
  readingEntryId?: string;
  notice?: string;
  busy: boolean;
  libraryCounts: LibraryCounts;
  onClearNotice: () => void;
  onUpdateEntry: (entry: Entry, field: "read" | "favorite", value: boolean) => Promise<boolean>;
  onOpenEntry: (entry: Entry) => void;
  onDismissEntry: (entry: Entry) => Promise<void>;
}) {
  const visibleEntries = entries.filter((entry) => {
    if (libraryView === "unread") return !entry.read;
    if (libraryView === "favorite") return entry.favorite;
    return true;
  });
  const title = activeSource?.title || ({ all: "最新文章", today: "今日更新", unread: "未读文章", favorite: "收藏文章" } satisfies Record<LibraryView, string>)[libraryView];
  const count = activeSource
    ? { value: entries.length, label: "篇内容" }
    : libraryView === "today"
      ? { value: libraryCounts.today, label: "篇更新" }
      : libraryView === "favorite"
        ? { value: libraryCounts.favorite, label: "篇收藏" }
        : { value: libraryCounts.unread, label: "未读" };

  return <section className="timeline" aria-label="文章列表">
    <header><div><p className="eyebrow">{activeSource ? "来源内容" : "阅读收件箱"}</p><h1>{title}</h1></div><span className="count">{count.value} {count.label}</span></header>
    {notice && <div className="notice">{notice}<button onClick={onClearNotice}>×</button></div>}
    <div className="entry-list">
      {visibleEntries.map((entry) => <EntryCard key={entry.id} entry={entry} source={sourceById.get(entry.sourceId)} selected={readingEntryId === entry.id} onRead={onUpdateEntry} onOpen={onOpenEntry} onDismiss={onDismissEntry} busy={busy} />)}
      {!visibleEntries.length && <div className="empty-state"><p className="eyebrow">READING DESK / 00</p><h2>{activeSource ? "该来源还没有内容" : libraryView === "today" ? "今天还没有更新" : libraryView === "unread" ? "没有未读文章" : libraryView === "favorite" ? "还没有收藏文章" : "还没有内容"}</h2><p>{activeSource ? "可以刷新来源，或使用“自动校准”重新识别内容列表。" : "添加 RSS、公开文章列表页，或粘贴小红书分享链接开始。"}</p></div>}
    </div>
  </section>;
}

function EntryCard({ entry, source, selected, onRead, onOpen, onDismiss, busy }: { entry: Entry; source?: Source; selected: boolean; onRead: (entry: Entry, field: "read" | "favorite", value: boolean) => Promise<boolean>; onOpen: (entry: Entry) => void; onDismiss: (entry: Entry) => Promise<void>; busy: boolean }) {
  const date = entry.publishedAt
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(entry.publishedAt)
    : entry.observedAt ? `收集于 ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(entry.observedAt)}` : "刚刚收集";
  const providers = [...new Set((entry.origins || []).map((origin) => origin.providerLabel || origin.providerId).filter((id) => id !== source?.connectorId))];
  return <article className={`entry-card ${entry.read ? "read" : ""}${selected ? " selected" : ""}`}>
    <button className="entry-main" type="button" onClick={() => onOpen(entry)} aria-label={`在应用内阅读：${entry.title}`}>
      <div className="entry-copy"><p className="entry-source">{source?.title || "已保存内容"} <span>·</span> {date}{providers.length ? <><span>·</span>{providers.join(" / ")}</> : null}</p><h2>{entry.title}</h2>{entry.summary && <p className="summary">{entry.summary}</p>}<p className="byline">{entry.author || "原文链接"}</p></div>
      {entry.imageUrl && <img src={entry.imageUrl} alt="" loading="lazy" />}
    </button>
    <div className="entry-actions"><button type="button" onClick={() => onOpen(entry)}>应用内阅读</button><button aria-label="标记已读" onClick={() => void onRead(entry, "read", !entry.read)}>{entry.read ? "未读" : "已读"}</button><button aria-label="收藏" onClick={() => void onRead(entry, "favorite", !entry.favorite)}>{entry.favorite ? "★" : "☆"}</button><button type="button" className="delete-entry" onClick={() => void onDismiss(entry)} disabled={busy}>删除</button></div>
  </article>;
}
