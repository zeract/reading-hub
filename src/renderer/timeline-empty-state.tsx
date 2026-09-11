import type { Source } from "../shared/types";
import type { LibraryView } from "./library-view";
import { AppIcon, type AppIconName } from "./ui-icons";

const EMPTY_VIEWS: Record<LibraryView, { title: string; description: string; icon: AppIconName }> = {
  all: { title: "还没有收集到内容", description: "来源同步后的文章会出现在这里。可以查看来源设置中的更新状态。", icon: "reading" },
  today: { title: "今天还没有内容", description: "今天发布的文章会出现在这里。", icon: "today" },
  unread: { title: "没有未读文章", description: "尚未读过的文章会出现在这里。", icon: "unread" },
  favorite: { title: "还没有收藏文章", description: "点击文章旁的星标，即可在这里集中查看。", icon: "favorite" },
};

export function TimelineEmptyState({ loading, failed, hasMore, source, hasSources, view, search, onClearSearch, onRetry, onAddSource, onEditSource }: {
  loading: boolean;
  failed: boolean;
  hasMore: boolean;
  source?: Source;
  hasSources: boolean;
  view: LibraryView;
  search: string;
  onClearSearch: () => void;
  onRetry: () => void;
  onAddSource: () => void;
  onEditSource?: (source: Source) => void;
}) {
  let state = EMPTY_VIEWS[view];
  let action: { label: string; run: () => void; primary?: boolean } | undefined;
  if (loading) {
    state = { title: "正在载入内容…", description: "正在读取本机收件箱。", icon: "refresh" };
  } else if (failed) {
    state = { title: "暂时无法载入内容", description: "可以重试载入，已保存的内容不会因此删除。", icon: "refresh" };
    action = { label: "重新载入", run: onRetry };
  } else if (hasMore) {
    state = { title: "还有内容尚未载入", description: "当前已载入的文章不符合筛选条件，可以继续加载更多。", icon: "reading" };
  } else if (search.trim()) {
    state = { title: "没有找到匹配内容", description: `没有找到“${search.trim()}”。搜索只匹配标题、作者和摘要，不会读取或保存文章全文。`, icon: "search" };
    action = { label: "清除搜索", run: onClearSearch };
  } else if (source) {
    state = { title: "该来源还没有内容", description: "可以在来源设置中查看收集范围和最近的更新状态。", icon: "reading" };
    if (onEditSource) action = { label: "查看来源设置", run: () => onEditSource(source) };
  } else if (!hasSources && (view === "all" || view === "today")) {
    state = { title: "添加第一个来源", description: "订阅 RSS、公开文章列表页，或保存文章分享链接。", icon: "reading" };
    action = { label: "添加来源", run: onAddSource, primary: true };
  }
  return <div className="empty-state" role="status">
    <AppIcon name={state.icon} />
    <h2>{state.title}</h2>
    <p>{state.description}</p>
    {action && <button type="button" className={`action-button${action.primary ? " primary" : ""}`} onClick={action.run}>{action.label}</button>}
  </div>;
}
