import { useEffect, useState } from "react";
import type { Source } from "../shared/types";
import { sourceIconKind, type SourceIconKind } from "../shared/source-icon";

export type AppIconName = "sidebar" | "expand" | "refresh" | "add" | "search" | "today" | "unread" | "favorite" | "folder" | "chevron-down" | "chevron-right" | "settings" | "back" | "reading" | "ai" | SourceIconKind;

/** Compact, local-only line icons with a native macOS reading-list emphasis. */
export function AppIcon({ name }: { name: AppIconName }) {
  const props = { viewBox: "0 0 24 24", width: 18, height: 18, fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (name) {
    case "sidebar": return <svg {...props}><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M9 4v16M12.5 9h4M12.5 13h4M12.5 17h2.5" /></svg>;
    case "expand": return <svg {...props}><path d="M8 3H3v5M16 3h5v5M21 16v5h-5M3 16v5h5" /></svg>;
    case "refresh": return <svg {...props}><path d="M21 12a9 9 0 0 0-15.5-6.2L3 8" /><path d="M3 3v5h5" /><path d="M3 12a9 9 0 0 0 15.5 6.2L21 16" /><path d="M21 21v-5h-5" /></svg>;
    case "add": return <svg {...props}><path d="M12 5v14M5 12h14" /></svg>;
    case "search": return <svg {...props}><circle cx="10.5" cy="10.5" r="5.75" /><path d="m15 15 4.25 4.25" /></svg>;
    case "today": return <svg {...props}><rect x="4" y="5.5" width="16" height="14" rx="2.5" /><path d="M8 3.5v4M16 3.5v4M4 10h16" /><circle cx="12" cy="14.5" r="1.2" fill="currentColor" stroke="none" /></svg>;
    case "unread": return <svg {...props}><circle cx="12" cy="12" r="7" /></svg>;
    case "favorite": return <svg {...props}><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.8-5.4 2.8 1-6.1-4.4-4.3 6.1-.9Z" /></svg>;
    case "folder": return <svg {...props}><path d="M3.5 7.5h6l1.7 2H20.5v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" /><path d="M3.5 7.5v-1a2 2 0 0 1 2-2H10l1.7 2" /></svg>;
    case "chevron-down": return <svg {...props}><path d="m7 9 5 5 5-5" /></svg>;
    case "chevron-right": return <svg {...props}><path d="m9 7 5 5-5 5" /></svg>;
    case "settings": return <svg {...props}><circle cx="12" cy="12" r="3" /><path d="M19 12a7.7 7.7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.7-1L14.5 3h-5l-.4 3.1a8 8 0 0 0-1.7 1l-2.4-1-2 3.4 2 1.5a7.7 7.7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a8 8 0 0 0 1.7 1l.4 3.1h5l.4-3.1a8 8 0 0 0 1.7-1l2.4 1 2-3.4-2-1.5c.1-.3.1-.7.1-1Z" /></svg>;
    case "back": return <svg {...props}><path d="M19 12H5M11 6l-6 6 6 6" /></svg>;
    case "reading": return <svg {...props}><path d="M5 4.5h10a4 4 0 0 1 4 4V20H9a4 4 0 0 0-4 1Z" /><path d="M5 4.5V21M9 8h6M9 12h6" /></svg>;
    case "ai": return <svg {...props}><path d="m12 3 1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7Z" /></svg>;
    case "rss": return <svg {...props}><circle cx="6" cy="18" r="1" fill="currentColor" stroke="none" /><path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14" /></svg>;
    case "web": return <svg {...props}><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4c2.2 2.2 3.2 4.9 3.2 8S14.2 17.8 12 20c-2.2-2.2-3.2-4.9-3.2-8S9.8 6.2 12 4Z" /></svg>;
    case "link": return <svg {...props}><path d="M10 14 14 10M8.2 17.8l-1.4 1.4a3 3 0 0 1-4.2-4.2L7 10.6a3 3 0 0 1 4.2 0M15.8 6.2l1.4-1.4a3 3 0 0 1 4.2 4.2L17 13.4a3 3 0 0 1-4.2 0" /></svg>;
    case "zhihu": return <svg {...props}><path d="M5 5.5h14v10H9l-4 3Z" /><path d="M8 9h8M8 12h5" /></svg>;
    case "zhihu-follow": return <svg {...props}><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.6-3 2.4-4.6 5.5-4.6S13.9 16 14.5 19M17 9v6M14 12h6" /></svg>;
    case "x": return <svg {...props}><path d="m5 4 14 16M19 4 5 20" /></svg>;
    case "xiaohongshu": return <svg {...props}><rect x="4" y="5" width="16" height="14" rx="3" /><path d="M8 10h8M8 14h5" /><circle cx="17" cy="14" r="1" fill="currentColor" stroke="none" /></svg>;
    case "academic": return <svg {...props}><path d="m4 8 8-4 8 4-8 4Z" /><path d="M7 11v4.5c2.8 2 7.2 2 10 0V11M20 9v5" /></svg>;
  }
}

export function SourceIcon({ source }: { source: Source }) {
  const kind = sourceIconKind(source);
  const [favicon, setFavicon] = useState<string>();

  useEffect(() => {
    let disposed = false;
    setFavicon(undefined);
    void window.reader.loadSourceIcon(source.id).then((icon) => {
      if (!disposed) setFavicon(icon);
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [source.id, source.url, source.kind, source.iconUrl, source.config?.sourceProvider, source.config?.rsshubPlatform]);

  return <span className={`source-icon source-icon--${kind}${favicon ? " source-icon--favicon" : ""}`} aria-hidden="true">
    {favicon ? <img src={favicon} alt="" /> : <AppIcon name={kind} />}
  </span>;
}
