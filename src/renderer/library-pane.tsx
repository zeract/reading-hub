import type { EntryMutationPending } from "./use-entry-mutations";
import { TimelineEmptyState } from "./timeline-empty-state";
import { useRef, type ReactNode } from "react";
import type { Entry, LibraryCounts, Source } from "../shared/types";
import type { LibraryView } from "./library-view";
import type { SourceGroup } from "./source-groups";
import { sourceHealthLabel } from "../shared/source-capabilities";
import { AppIcon, SourceIcon, type AppIconName } from "./ui-icons";
import { isUnclaimedEscape } from "./keyboard-events";

function LibraryCount({ value, stale, title }: { value: number | ""; stale: boolean; title?: string }) {
  return <em title={stale ? "计数暂未更新，请重新载入。" : title} aria-label={stale ? "计数暂未更新" : undefined}>{stale ? "—" : value}</em>;
}

function LibraryFilter({ view, currentView, label, icon, onSelect, children }: {
  view: LibraryView; currentView?: LibraryView; label: string; icon: AppIconName; onSelect: (view: LibraryView) => void; children?: ReactNode;
}) {
  const selected = view === currentView;
  return <button type="button" className={`library-filter ${selected ? "selected" : ""}`} aria-current={selected ? "page" : undefined} onClick={() => onSelect(view)}>
    <span><AppIcon name={icon} />{label}</span>{children}
  </button>;
}

function SourceNavigationRow({ source, selected, onSelect, onEdit }: {
  source: Source; selected: boolean; onSelect: (sourceId: string) => void; onEdit: (source: Source) => void;
}) {
  const archived = source.subscribed === false;
  return <div className="source-row" onContextMenu={(event) => { event.preventDefault(); onEdit(source); }} onKeyDown={(event) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault(); onEdit(source);
    }
  }}>
    <button type="button" className={`source-filter ${selected ? "selected" : ""}`} aria-current={selected ? "page" : undefined} onClick={() => onSelect(source.id)} title={`${source.title} · ${sourceHealthLabel(source)}（右键配置）`} aria-label={`查看 ${source.title}；右键打开来源设置`}>
      <SourceIcon source={source} /><span className="source-title">{source.title}</span>{!archived && source.status !== "active" && <span className="source-health-indicator" aria-label={sourceHealthLabel(source)}>•</span>}
    </button>
    {archived && <button type="button" className="action-button source-settings-shortcut" onClick={() => onEdit(source)} aria-label={`打开 ${source.title} 的来源设置`} title="来源设置"><AppIcon name="settings" /></button>}
  </div>;
}

export function SourceSidebar({ sources, groups, libraryView, activeSourceId, libraryCounts, countsStale, collapsedGroups, onSelectLibrary, onSelectSource, onToggleGroup, onEditSource, onOpenSettings }: {
  sources: Source[];
  groups: SourceGroup[];
  libraryView: LibraryView;
  activeSourceId?: string;
  libraryCounts: LibraryCounts;
  countsStale: boolean;
  collapsedGroups: Record<string, boolean>;
  onSelectLibrary: (view: LibraryView) => void;
  onSelectSource: (sourceId?: string) => void;
  onToggleGroup: (groupId: string) => void;
  onEditSource: (source: Source) => void;
  onOpenSettings: () => void;
}) {
  const archivedSources = sources.filter((source) => source.subscribed === false);
  const navigation = { currentView: activeSourceId ? undefined : libraryView, onSelect: onSelectLibrary };
  return <aside className="sidebar">
    <nav className="library-nav" aria-label="阅读分类">
      <div className="section-title">阅读</div>
      <LibraryFilter {...navigation} view="collected" label="新收集" icon="today"><LibraryCount value={libraryCounts.newArrivals || ""} stale={countsStale} title="自上次启动以来收集的新内容，不含历史回填" /></LibraryFilter>
      <LibraryFilter {...navigation} view="all" label="全部内容" icon="folder" />
      <LibraryFilter {...navigation} view="today" label="今日发布" icon="today" />
      <LibraryFilter {...navigation} view="unread" label="未读" icon="unread"><LibraryCount value={libraryCounts.unread} stale={countsStale} /></LibraryFilter>
      <LibraryFilter {...navigation} view="favorite" label="收藏" icon="favorite"><LibraryCount value={libraryCounts.favorite} stale={countsStale} /></LibraryFilter>
      <LibraryFilter {...navigation} view="history" label="历史回填" icon="folder" />
      <LibraryFilter {...navigation} view="trash" label="最近删除" icon="folder" />
    </nav>
    <section className="source-section" aria-labelledby="source-heading">
      <div className="section-title" id="source-heading">来源 <span>{sources.length - archivedSources.length}</span></div>
      <div className="source-list">
        {groups.map((group) => <section className="source-group" key={group.id}>
          <button type="button" className="source-group-heading" onClick={() => onToggleGroup(group.id)} aria-expanded={!collapsedGroups[group.id]}>
            <span className="source-group-label"><AppIcon name={collapsedGroups[group.id] ? "chevron-right" : "chevron-down"} /><AppIcon name="folder" /><span title={group.title}>{group.title}</span></span><em>{group.sources.length}</em>
          </button>
          {!collapsedGroups[group.id] && group.sources.map((source) => <SourceNavigationRow key={source.id} source={source} selected={activeSourceId === source.id} onSelect={onSelectSource} onEdit={onEditSource} />)}
        </section>)}
        {archivedSources.length > 0 && <details className="archived-sources"><summary>已取消订阅</summary>{archivedSources.map((source) => <SourceNavigationRow key={source.id} source={source} selected={activeSourceId === source.id} onSelect={onSelectSource} onEdit={onEditSource} />)}</details>}
        {!sources.length && <p className="empty-side">先添加一个公开 Feed 或网页。</p>}
      </div>
    </section>
    <footer className="sidebar-footer"><button type="button" className="sidebar-settings-button" onClick={onOpenSettings} aria-label="打开设置" title="设置"><AppIcon name="settings" /><span>设置</span></button></footer>
  </aside>;
}

export function Timeline({ loadingEntries, loadFailed, onReload, onAddSource, activeSource, libraryView, entrySearch, entries, hasMoreEntries, loadingMoreEntries, paginationError, sourceById, readingEntryId, notice, busy, onUndo, onEditSource, onClearNotice, onEntrySearchChange, onUpdateEntry, isEntryUpdating, onOpenEntry, onDismissEntry, onRestoreEntry, onLoadMore }: {
  loadingEntries: boolean;
  loadFailed: boolean;
  onReload: () => void;
  onAddSource: () => void;
  activeSource?: Source;
  libraryView: LibraryView;
  entrySearch: string;
  entries: Entry[];
  hasMoreEntries: boolean;
  loadingMoreEntries: boolean;
  paginationError?: string;
  sourceById: Map<string, Source>;
  readingEntryId?: string;
  notice?: string;
  busy: boolean;
  onUndo?: () => void;
  onEditSource?: (source: Source) => void;
  onClearNotice: () => void;
  onEntrySearchChange: (search: string) => void;
  onUpdateEntry: (entry: Entry, field: "read" | "favorite", value: boolean) => Promise<boolean>;
  isEntryUpdating: EntryMutationPending;
  onOpenEntry: (entry: Entry) => void;
  onDismissEntry: (entry: Entry) => Promise<void>;
  onRestoreEntry: (entry: Entry) => Promise<void>;
  onLoadMore: () => void;
}) {
  const searchInput = useRef<HTMLInputElement>(null);
  function clearSearch() { onEntrySearchChange(""); searchInput.current?.focus(); }
  const visibleEntries = entries.filter((entry) => {
    if (libraryView === "unread") return !entry.read;
    if (libraryView === "favorite") return entry.favorite;
    return true;
  });
  const title = activeSource?.title || ({ trash: "最近删除", all: "全部内容", collected: "新收集", history: "历史回填", today: "今日发布", unread: "未读文章", favorite: "收藏文章" } satisfies Record<LibraryView, string>)[libraryView];
  const visibleCount = visibleEntries.length;
  const count = { value: hasMoreEntries ? `${visibleCount}+` : visibleCount, label: entrySearch.trim() ? "篇匹配" : "篇内容" };

  return <section className="timeline" aria-label="文章列表">
    <header><div><p className="eyebrow">{activeSource ? "来源内容" : "阅读收件箱"}</p><h1 title={title}>{title}</h1></div><span className="count">{count.value} {count.label}</span></header>
    {<form className="entry-search" role="search" onSubmit={(event) => event.preventDefault()}>
      <AppIcon name="search" />
      <input
        ref={searchInput}
        type="search"
        value={entrySearch}
        maxLength={160}
        autoComplete="off"
        spellCheck={false}
        aria-label={`搜索 ${activeSource?.title || "当前列表"} 中的帖子`}
        placeholder={`搜索 ${activeSource?.title || "当前列表"} 中的帖子`}
        onChange={(event) => onEntrySearchChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (isUnclaimedEscape(event.nativeEvent)) {
            event.preventDefault();
            clearSearch();
          }
        }}
      />
      {entrySearch && <button type="button" className="entry-search-clear" onClick={clearSearch} aria-label="清除关键词">×</button>}
    </form>}
    {notice && <div className="notice">
      <p className="notice-message" role="status" tabIndex={0}>{notice}</p>
      <button type="button" className="notice-close" aria-label="关闭通知" title="关闭通知" onClick={onClearNotice}>×</button>
      {onUndo && <div className="notice-actions"><button type="button" className="action-button" disabled={busy} onClick={onUndo}>撤销删除</button></div>}
    </div>}
    <div className="entry-list">
      {visibleEntries.map((entry) => <EntryCard key={entry.id} entry={entry} source={sourceById.get(entry.sourceId)} selected={readingEntryId === entry.id} onRead={onUpdateEntry} isEntryUpdating={isEntryUpdating} onOpen={onOpenEntry} onDismiss={onDismissEntry} onRestore={onRestoreEntry} deleted={libraryView === "trash"} busy={busy} />)}
      {!visibleCount && <TimelineEmptyState loading={loadingEntries} failed={loadFailed} hasMore={hasMoreEntries} source={activeSource} hasSources={sourceById.size > 0} view={libraryView} search={entrySearch} onClearSearch={clearSearch} onRetry={onReload} onAddSource={onAddSource} onEditSource={onEditSource} />}
      {hasMoreEntries && <div className="entry-load-more">
        <p>已显示 {visibleCount} 篇内容</p>
        {paginationError && <p className="entry-pagination-error" role="alert" tabIndex={0}>暂时无法加载更多：{paginationError}</p>}
        <button type="button" onClick={onLoadMore} disabled={busy || loadingMoreEntries || loadingEntries}>{loadingMoreEntries ? "正在加载…" : paginationError ? "重试加载" : "加载更多"}</button>
      </div>}
    </div>
  </section>;
}

function EntryCard({ entry, source, selected, onRead, isEntryUpdating, onOpen, onDismiss, onRestore, busy, deleted }: { isEntryUpdating: EntryMutationPending; deleted: boolean; entry: Entry; source?: Source; selected: boolean; onRead: (entry: Entry, field: "read" | "favorite", value: boolean) => Promise<boolean>; onOpen: (entry: Entry) => void; onDismiss: (entry: Entry) => Promise<void>; onRestore: (entry: Entry) => Promise<void>; busy: boolean }) {
  const date = entry.publishedAt
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(entry.publishedAt)
    : entry.observedAt ? `收集于 ${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(entry.observedAt)}` : "刚刚收集";
  const providers = [...new Set((entry.origins || []).map((origin) => origin.providerLabel || origin.providerId).filter((id) => id !== source?.connectorId))];
  const sourceFacets = source
    ? entry.origins?.find((origin) => origin.sourceId === source.id)?.facets
    : entry.facets;
  const facets = (sourceFacets ?? entry.facets ?? []).slice(0, 3);
  return <article className={`entry-card ${entry.read ? "read" : ""}${selected ? " selected" : ""}`}>
    <button className="entry-main" type="button" disabled={deleted} onClick={() => onOpen(entry)} aria-label={`在应用内阅读：${entry.title}`}>
      <div className="entry-copy"><p className="entry-source">{source?.title || "已保存内容"} <span>·</span> {date}{providers.length ? <><span>·</span>{providers.join(" / ")}</> : null}</p><h2>{entry.title}</h2>{entry.summary && <p className="summary">{entry.summary}</p>}{facets.length > 0 && <p className="entry-facets" aria-label="文章分类">{facets.map((facet) => <span key={`${facet.scheme}\u0000${facet.key}`}>{facet.label}</span>)}</p>}<p className="byline">{entry.author || "原文链接"}</p></div>
      {entry.imageUrl && <img src={entry.imageUrl} alt="" loading="lazy" />}
    </button>
    <div className="entry-actions">
      {!deleted && <>
        <button type="button" className="action-button" onClick={() => onOpen(entry)}>应用内阅读</button>
        <button type="button" className="action-button" disabled={isEntryUpdating(entry.id, "read")} onClick={() => void onRead(entry, "read", !entry.read)}>{entry.read ? "标为未读" : "标为已读"}</button>
        <button type="button" className="action-button" disabled={isEntryUpdating(entry.id, "favorite")} aria-label="收藏" aria-pressed={entry.favorite} title={entry.favorite ? "取消收藏" : "收藏"} onClick={() => void onRead(entry, "favorite", !entry.favorite)}>{entry.favorite ? "★" : "☆"}</button>
      </>}
      <button type="button" className={`action-button ${deleted ? "restore-entry" : "delete-entry"}`} onClick={() => void (deleted ? onRestore(entry) : onDismiss(entry))} disabled={busy}>{deleted ? "恢复内容" : "删除"}</button>
    </div>
  </article>;
}
