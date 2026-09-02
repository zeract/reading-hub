import { type CSSProperties, type FormEvent, type KeyboardEvent, type RefObject, type SyntheticEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AiArticleContext, AiProviderId, AiProviderSettings, AiSelectionContext, AiSelectionIntent, Entry, ReaderArticle, Source } from "../shared/types";
import { AiMarkdownContent } from "./ai-markdown";
import { shouldSubmitAssistantQuestion } from "./assistant-input";
import { buildAiArticleContext, collectAiArticleText } from "./ai-request";
import { newAiRequestId, useAiStreamSubscription, useAiTextStream } from "./ai-stream";
import { bilingualTranslationLabel, bilingualTranslationQuestion, bilingualTranslationTarget } from "./bilingual-translation";
import { errorMessage } from "./errors";
import { batchImmersiveTranslationSegments, createImmersiveTranslationPlan, createImmersiveTranslationStreamParser, renderImmersiveTranslationHtml, translationSegmentsForBatch } from "./immersive-translation";
import { adjustReaderFontScale, loadReaderPreferences, saveReaderPreferences, type ReaderPreferences, type ReaderPreset } from "./reader-preferences";
import { LatestRequestGuard } from "./request-guard";
import { normaliseSelectedArticleText, selectedTextLabel, selectionActionQuestion, selectionContext, selectionOverlay, type SelectionOverlay, type SelectionRect } from "./selection-actions";

type AssistantPanelState = "closed" | "minimized" | "open";
type ReaderImagePreview = { src: string; alt: string };
type AssistantSelectionRequest = { id: string; question: string; selection: AiSelectionContext };
type ReaderTextSelection = { text: string; overlay: SelectionOverlay; asking: boolean; request?: AssistantSelectionRequest };
type AiMessage = { id: string; role: "user" | "assistant"; text: string; error?: boolean; streaming?: boolean };
type ActiveAiStream = { requestId: string; assistantMessageId: string };

function toSelectionRect(rect: DOMRect): SelectionRect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function toAiArticleContext(article: ReaderArticle, sourceTitle?: string): AiArticleContext {
  const document = new DOMParser().parseFromString(article.contentHtml, "text/html");
  // Both the side panel and selection helper call this shared path. Capping
  // here keeps their IPC payload within the same bounded contract that the
  // main process enforces before a provider or Codex CLI sees the article.
  return buildAiArticleContext({
    title: article.title,
    url: article.url,
    sourceTitle,
    plainText: collectAiArticleText(textNodeValues(document.body))
  });
}

/**
 * Translation is deliberately context-free: it must not parse the article DOM
 * or send a title, link, source label, or article excerpt through IPC.
 */
function articlePayloadForAiRequest(article: ReaderArticle, sourceTitle: string | undefined, selection?: AiSelectionContext): { article?: AiArticleContext } {
  if (selection?.intent === "translate") return {};
  return { article: toAiArticleContext(article, sourceTitle) };
}

function* textNodeValues(root: Node): Generator<string> {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    if (node.nodeValue) yield node.nodeValue;
    node = walker.nextNode();
  }
}

export function ReaderPlaceholder() {
  return <section className="reader-placeholder" aria-label="选择文章开始阅读">
    <div className="reader-placeholder-mark">RH<br /><span>01</span></div>
    <div><p className="eyebrow">YOUR READING DESK</p><h2>选择一篇文章<br />开始阅读</h2><p>来源、时间与阅读状态会保留在本机。<br />正文始终来自原始发布者。</p></div>
  </section>;
}

export function ReaderView({ entry, source, onUpdateEntry, readerOnly, onToggleReaderOnly, onOpenSettings }: {
  entry: Entry;
  source?: Source;
  onUpdateEntry: (entry: Entry, field: "read" | "favorite", value: boolean) => Promise<boolean>;
  readerOnly: boolean;
  onToggleReaderOnly: () => void;
  onOpenSettings: () => void;
}) {
  const [article, setArticle] = useState<ReaderArticle>();
  const [embedded, setEmbedded] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [preferences, setPreferences] = useState<ReaderPreferences>(loadReaderPreferences);
  const [assistantState, setAssistantState] = useState<AssistantPanelState>("closed");
  const [imagePreview, setImagePreview] = useState<ReaderImagePreview>();
  const [textSelection, setTextSelection] = useState<ReaderTextSelection>();
  const [selectionQuestion, setSelectionQuestion] = useState("");
  const [preferredAiProviderId, setPreferredAiProviderId] = useState<AiProviderId>("codex-cli");
  const [favoriteUpdating, setFavoriteUpdating] = useState(false);
  const [languageSwitching, setLanguageSwitching] = useState<string>();
  const [languageSwitchError, setLanguageSwitchError] = useState<string>();
  const [bilingualOpen, setBilingualOpen] = useState(false);
  const articleBodyElement = useRef<HTMLDivElement>(null);
  const readerWorkspaceElement = useRef<HTMLDivElement>(null);
  const articleRequestGuard = useRef(new LatestRequestGuard());
  const renderedEntryId = useRef(entry.id);

  // Effects run after React commits the new entry. Invalidate synchronously as
  // soon as this render belongs to a different entry so a just-resolved IPC
  // response for the previous article can never replace the new view.
  if (renderedEntryId.current !== entry.id) {
    renderedEntryId.current = entry.id;
    articleRequestGuard.current.invalidate();
  }

  useEffect(() => {
    saveReaderPreferences(preferences);
  }, [preferences]);

  const loadArticle = useCallback(async () => {
    const request = articleRequestGuard.current.begin();
    setLoading(true); setError(undefined); setLanguageSwitchError(undefined); setArticle(undefined); setEmbedded(false);
    try {
      const result = await window.reader.readEntry(entry.id);
      if (!articleRequestGuard.current.isCurrent(request)) return;
      if (result.kind === "article") setArticle(result.article);
      else setEmbedded(true);
    } catch (reason) {
      if (articleRequestGuard.current.isCurrent(request)) setError(errorMessage(reason));
    } finally {
      if (articleRequestGuard.current.isCurrent(request)) setLoading(false);
    }
  }, [entry.id]);

  useEffect(() => { void loadArticle(); }, [loadArticle]);
  useEffect(() => {
    setAssistantState("closed");
    setImagePreview(undefined);
    setTextSelection(undefined);
    setSelectionQuestion("");
    setLanguageSwitching(undefined);
    setLanguageSwitchError(undefined);
    setBilingualOpen(false);
  }, [entry.id]);
  useEffect(() => {
    if (!imagePreview && !textSelection) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setImagePreview(undefined);
        setTextSelection(undefined);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [imagePreview, textSelection]);

  const displayed = article || entry;
  const date = displayed.publishedAt ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" }).format(displayed.publishedAt) : undefined;
  function previewImage(image: HTMLImageElement) {
    const src = image.currentSrc || image.src;
    if (src) setImagePreview({ src, alt: image.alt || "文章图片" });
  }
  function handleContentClick(event: SyntheticEvent<HTMLElement>) {
    const target = event.target;
    const image = target instanceof HTMLImageElement
      ? target
      : target instanceof Element ? target.closest("img[data-reader-zoomable='true']") : null;
    if (image instanceof HTMLImageElement) {
      event.preventDefault();
      previewImage(image);
      return;
    }
    const link = target instanceof Element ? target.closest("a[href]") as HTMLAnchorElement | null : null;
    if (!link) return;
    event.preventDefault();
    setTextSelection(undefined);
    void window.reader.openExternal(link.href);
  }
  function handleContentKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target;
    const image = target instanceof HTMLImageElement
      ? target
      : target instanceof Element ? target.closest("img[data-reader-zoomable='true']") : null;
    if (!(image instanceof HTMLImageElement)) return;
    event.preventDefault();
    previewImage(image);
  }
  function captureArticleSelection() {
    const root = articleBodyElement.current;
    const workspace = readerWorkspaceElement.current;
    const selection = window.getSelection();
    if (!root || !workspace || !selection || selection.isCollapsed || !selection.rangeCount) {
      setTextSelection(undefined);
      return;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) {
      setTextSelection(undefined);
      return;
    }
    const text = normaliseSelectedArticleText(selection.toString());
    const frame = toSelectionRect(workspace.getBoundingClientRect());
    const overlay = selectionOverlay(Array.from(range.getClientRects()).map(toSelectionRect), frame);
    if (!text || !overlay) {
      setTextSelection(undefined);
      return;
    }
    // A text selection starts an in-context reading flow. Keep its anchor and
    // answer unobscured instead of competing with an already-open side panel.
    setAssistantState((state) => state === "open" ? "minimized" : state);
    setSelectionQuestion("");
    setTextSelection({ text, overlay, asking: false });
  }
  function askAboutSelection(intent: Exclude<AiSelectionIntent, "ask">) {
    if (!textSelection) return;
    const question = selectionActionQuestion(intent);
    if (!question) return;
    window.getSelection()?.removeAllRanges();
    setTextSelection((current) => current ? { ...current, asking: false, request: { id: newAiRequestId(), question, selection: selectionContext(current.text, intent) } } : current);
  }
  function revealSelectionQuestion() {
    setTextSelection((current) => current ? { ...current, asking: true, request: undefined } : current);
  }
  function submitSelectionQuestion(event: FormEvent) {
    event.preventDefault();
    if (!textSelection) return;
    const question = selectionActionQuestion("ask", selectionQuestion);
    if (!question) return;
    window.getSelection()?.removeAllRanges();
    setTextSelection((current) => current ? { ...current, asking: false, request: { id: newAiRequestId(), question, selection: selectionContext(current.text, "ask") } } : current);
    setSelectionQuestion("");
  }
  function clearTextSelection() {
    window.getSelection()?.removeAllRanges();
    setTextSelection(undefined);
    setSelectionQuestion("");
  }
  function handleContentError(event: SyntheticEvent<HTMLElement>) {
    const image = event.target instanceof HTMLImageElement ? event.target : undefined;
    if (!image) return;
    const originalUrl = image.currentSrc || image.src;
    if (!originalUrl || image.dataset.readerProxyTried === "1") {
      replaceBrokenImage(image);
      return;
    }
    image.dataset.readerProxyTried = "1";
    void window.reader.loadArticleImage(entry.id, originalUrl)
      .then((dataUrl) => { image.src = dataUrl; })
      .catch(() => replaceBrokenImage(image));
  }
  function replaceBrokenImage(image: HTMLImageElement) {
    if (!image.isConnected || image.dataset.readerImageUnavailable === "1") return;
    image.dataset.readerImageUnavailable = "1";
    const fallback = document.createElement("a");
    fallback.href = entry.url;
    fallback.className = "reader-image-failure";
    fallback.textContent = "图片未能加载 · 在浏览器中查看原文";
    image.replaceWith(fallback);
  }
  function openEmbedded() {
    void window.reader.openEmbeddedEntry(entry.id).catch((reason) => setError(errorMessage(reason)));
  }
  async function switchLanguage(url: string) {
    if (!article || languageSwitching || url === article.url) return;
    const request = articleRequestGuard.current.begin();
    setLanguageSwitching(url);
    setLanguageSwitchError(undefined);
    try {
      const next = await window.reader.readEntryLanguageVariant(entry.id, url);
      if (!articleRequestGuard.current.isCurrent(request)) return;
      window.getSelection()?.removeAllRanges();
      setArticle(next);
      setEmbedded(false);
      setImagePreview(undefined);
      setTextSelection(undefined);
      setSelectionQuestion("");
      setBilingualOpen(false);
      // An answer may quote the previous-language document, so do not retain
      // a stale assistant panel across an article-version switch.
      setAssistantState("closed");
    } catch (reason) {
      if (articleRequestGuard.current.isCurrent(request)) setLanguageSwitchError(errorMessage(reason));
    } finally {
      if (articleRequestGuard.current.isCurrent(request)) setLanguageSwitching(undefined);
    }
  }
  async function toggleFavorite() {
    if (favoriteUpdating) return;
    setFavoriteUpdating(true);
    try {
      await onUpdateEntry(entry, "favorite", !entry.favorite);
    } finally {
      setFavoriteUpdating(false);
    }
  }

  const readerStyle = { "--reader-font-scale": String(preferences.fontScale) } as CSSProperties & Record<"--reader-font-scale", string>;
  const setPreset = (preset: ReaderPreset) => setPreferences((current) => ({ ...current, preset }));
  const adjustFont = (amount: number) => setPreferences((current) => ({
    ...current,
    fontScale: adjustReaderFontScale(current.fontScale, amount)
  }));
  const toggleAssistant = () => {
    if (!article) return;
    setAssistantState((state) => state === "open" ? "minimized" : "open");
  };
  const toggleBilingual = () => {
    if (!article) return;
    if (!bilingualOpen && assistantState === "open") setAssistantState("minimized");
    setBilingualOpen((open) => !open);
  };
  const assistantVisible = assistantState === "open";
  const assistantMounted = assistantState !== "closed";
  const languageVariants = article?.languageVariants || [];
  const hasLanguageVariants = languageVariants.length > 1;

  return <section className={`reader-view reader--${article?.renderProfile || "standard"}`} data-reader-preset={preferences.preset} style={readerStyle} aria-label="应用内阅读器">
    <header className="reader-toolbar">
      <div className="reader-toolbar-spacer" aria-hidden="true" />
      <div className="reader-toolbar-center">
        <p>{source?.title || "已保存内容"}</p>
        <div className="reader-toolbar-settings">
          {hasLanguageVariants && <div className="reader-language-switcher" role="group" aria-label="文章语言版本">
            {languageVariants.map((variant) => {
              const matchingLanguageCount = languageVariants.filter((candidate) => candidate.language === variant.language).length;
              const active = variant.url === article?.url || (matchingLanguageCount === 1 && variant.language === article?.activeLanguage);
              return <button
                type="button"
                key={variant.url}
                className={active ? "selected" : ""}
                aria-pressed={active}
                disabled={active || Boolean(languageSwitching)}
                title={active ? `当前：${variant.label}` : `切换为${variant.label}`}
                onClick={() => void switchLanguage(variant.url)}
              >{languageSwitching === variant.url ? "…" : variant.label}</button>;
            })}
          </div>}
          <div className="reader-controls" aria-label="阅读排版设置">
            <button type="button" className={preferences.preset === "compact" ? "selected" : ""} aria-pressed={preferences.preset === "compact"} onClick={() => setPreset("compact")}>紧凑</button>
            <button type="button" className={preferences.preset === "reading" ? "selected" : ""} aria-pressed={preferences.preset === "reading"} onClick={() => setPreset("reading")}>阅读</button>
            <span aria-hidden="true" />
            <button type="button" aria-label="缩小字号" disabled={preferences.fontScale <= 0.85} onClick={() => adjustFont(-0.05)}>A−</button>
            <button type="button" aria-label="放大字号" disabled={preferences.fontScale >= 1.25} onClick={() => adjustFont(0.05)}>A+</button>
          </div>
        </div>
        {languageSwitchError && <span className="reader-language-error" role="status" title={languageSwitchError}>{languageSwitchError}</span>}
      </div>
      <div className="reader-toolbar-actions">
        <button type="button" className={`reader-immersive-translation-toggle${bilingualOpen ? " is-active" : ""}`} aria-pressed={bilingualOpen} aria-label={bilingualOpen ? "关闭沉浸翻译" : "打开沉浸翻译"} title={bilingualOpen ? "关闭沉浸翻译" : "打开沉浸翻译"} disabled={!article} onClick={toggleBilingual}>译</button>
        <button type="button" className={`toolbar-icon-button favorite-button${entry.favorite ? " is-favorite" : ""}`} aria-pressed={entry.favorite} aria-label={entry.favorite ? "取消收藏" : "收藏文章"} title={entry.favorite ? "取消收藏" : "收藏文章"} disabled={favoriteUpdating} onClick={() => void toggleFavorite()}>{entry.favorite ? "★" : "☆"}</button>
        <button type="button" className="toolbar-icon-button ai-toggle" aria-pressed={assistantVisible} aria-label={assistantVisible ? "最小化 AI 学习" : "打开 AI 学习"} title={assistantVisible ? "最小化 AI 学习" : "打开 AI 学习"} disabled={!article} onClick={toggleAssistant}>✦</button>
        <button type="button" className="toolbar-icon-button reader-focus-toggle" aria-pressed={readerOnly} aria-label={readerOnly ? "退出沉浸阅读" : "仅保留阅读栏"} title={readerOnly ? "退出沉浸阅读" : "仅保留阅读栏"} onClick={onToggleReaderOnly}>⛶</button>
        <button type="button" className="toolbar-icon-button external-button" aria-label="在浏览器中打开原文" title="在浏览器中打开原文" onClick={() => void window.reader.openExternal(article?.url || entry.url)}>↗</button>
      </div>
    </header>
    <div ref={readerWorkspaceElement} className={`reader-workspace ${assistantVisible && article ? "reader-workspace--assistant" : ""}`}>
      <div className="reader-scroll" onScroll={textSelection ? clearTextSelection : undefined}>
        {loading && <div className="reader-loading" role="status"><span className="loading-mark" /><p>正在准备适合阅读的正文…</p></div>}
        {!loading && embedded && <div className="reader-embedded"><h1>{entry.title}</h1><p>该站点不允许自动提取正文，原文已在 Reading Hub 的受限窗口中打开。该窗口不使用外部浏览器，也不会复用登录态。</p><button type="button" className="primary-action" onClick={() => void loadArticle()}>重新打开原文</button></div>}
        {!loading && error && <div className="reader-failure"><h1>{entry.title}</h1><p>{error}</p><div><button type="button" className="primary-action" onClick={() => void loadArticle()}>重试</button><button type="button" onClick={openEmbedded}>在应用内打开原文</button></div></div>}
        {!loading && article && <article className="reader-article">
          <header><p className="eyebrow">{source?.title || "已保存内容"}</p><h1>{article.title}</h1>{(article.author || date) && <p className="reader-byline">{article.author}{article.author && date ? " · " : ""}{date}</p>}</header>
          {article.contentMode === "feed_body" && <aside className="reader-content-notice" role="note">正在显示订阅 Feed 提供的正文。该原页未被自动读取；请使用右上角 ↗ 查看完整原文。</aside>}
          {article.contentMode === "feed_summary" && <aside className="reader-content-notice" role="note">正在显示订阅 Feed 提供的内容摘要。该原页不允许自动读取；请使用右上角 ↗ 查看完整原文。</aside>}
          <div>
              {article.coverImageUrl && <button type="button" className="reader-cover-button" onClick={(event) => {
                const image = event.currentTarget.querySelector("img");
                if (image) previewImage(image);
              }} aria-label="放大封面图片"><img className="reader-cover" src={article.coverImageUrl} alt="" onError={handleContentError} /></button>}
              {bilingualOpen ? <ImmersiveTranslationBody
              key={article.url}
              article={article}
              preferredProviderId={preferredAiProviderId}
              onOpenSettings={onOpenSettings}
              bodyRef={articleBodyElement}
              onClick={handleContentClick} onKeyDown={handleContentKeyDown} onKeyUp={captureArticleSelection} onMouseUp={captureArticleSelection} onError={handleContentError}
            /> : <div ref={articleBodyElement} className="article-body" onClick={handleContentClick} onKeyDown={handleContentKeyDown} onKeyUp={captureArticleSelection} onMouseUp={captureArticleSelection} onError={handleContentError} dangerouslySetInnerHTML={{ __html: article.contentHtml }} />}
          </div>
        </article>}
      </div>
      {textSelection && <div className="reader-selection-underlines" aria-hidden="true">{textSelection.overlay.underlines.map((underline, index) => <span key={`${underline.left}-${underline.top}-${index}`} style={{ left: underline.left, top: underline.top, width: underline.width }} />)}</div>}
      {textSelection && <section className="reader-selection-toolbar" role="toolbar" aria-label="所选文字操作" style={{ left: textSelection.overlay.toolbarLeft, top: textSelection.overlay.toolbarTop }}>
        {!textSelection.asking ? <>
          <button type="button" onClick={() => askAboutSelection("translate")}>翻译</button>
          <button type="button" onClick={() => askAboutSelection("explain")}>解释</button>
          <button type="button" onClick={revealSelectionQuestion}>提问</button>
          <button type="button" className="selection-cancel" onClick={clearTextSelection} aria-label="取消所选文字操作">×</button>
        </> : <form onSubmit={submitSelectionQuestion}>
          <input value={selectionQuestion} onChange={(event) => setSelectionQuestion(event.target.value)} placeholder="问所选文字…" maxLength={600} autoFocus />
          <button type="submit" disabled={!selectionQuestion.trim()}>发送</button>
          <button type="button" className="selection-cancel" onClick={clearTextSelection} aria-label="取消所选文字提问">×</button>
        </form>}
      </section>}
      {textSelection?.request && article && <SelectionAssistantCard
        request={textSelection.request}
        overlay={textSelection.overlay}
        article={article}
        sourceTitle={source?.title}
        preferredProviderId={preferredAiProviderId}
        onClose={clearTextSelection}
        onOpenSettings={() => { clearTextSelection(); onOpenSettings(); }}
      />}
      {assistantMounted && article && <ReaderAssistant
        article={article}
        sourceTitle={source?.title}
        providerId={preferredAiProviderId}
        onProviderChange={setPreferredAiProviderId}
        minimized={assistantState === "minimized"}
        onMinimize={() => setAssistantState("minimized")}
        onClose={() => setAssistantState("closed")}
        onOpenSettings={onOpenSettings}
      />}
      {assistantState === "minimized" && article && <button type="button" className="assistant-launcher" onClick={() => setAssistantState("open")} aria-label="恢复 AI 学习助手" title="恢复 AI 学习助手">✦</button>}
    </div>
    {imagePreview && <ImagePreview image={imagePreview} onClose={() => setImagePreview(undefined)} />}
  </section>;
}

function ImmersiveTranslationBody({ article, preferredProviderId, onOpenSettings, bodyRef, ...handlers }: {
  article: ReaderArticle;
  preferredProviderId: AiProviderId;
  onOpenSettings: () => void;
  bodyRef: RefObject<HTMLDivElement | null>;
  onClick: (event: SyntheticEvent<HTMLElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onKeyUp: () => void;
  onMouseUp: () => void;
  onError: (event: SyntheticEvent<HTMLElement>) => void;
}) {
  const [providers, setProviders] = useState<AiProviderSettings[]>([]);
  const [providerError, setProviderError] = useState<string>();
  const [translations, setTranslations] = useState<Map<string, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const plan = useMemo(() => createImmersiveTranslationPlan(article.contentHtml), [article.contentHtml]);
  const target = bilingualTranslationTarget(article.activeLanguage);
  const active = useRef<{ id: string; parser: ReturnType<typeof createImmersiveTranslationStreamParser>; resolve: (ok: boolean) => void } | undefined>(undefined);
  const provider = useMemo(() => providers.find((item) => item.id === preferredProviderId && item.configured)
    || providers.find((item) => item.configured), [preferredProviderId, providers]);
  const targetLabel = bilingualTranslationLabel(target);
  const html = useMemo(() => renderImmersiveTranslationHtml(plan, translations, { targetLanguage: target }), [plan, target, translations]);

  useAiStreamSubscription((event) => {
    const current = active.current;
    if (!current || current.id !== event.requestId) return;
    if (event.type === "delta") {
      const progress = current.parser.push(event.text);
      setTranslations(new Map(progress.translations));
      return;
    }
    if (event.type === "complete" && event.answer.text.trim()) {
      current.parser.reset();
      setTranslations(new Map(current.parser.push(event.answer.text).translations));
    }
    active.current = undefined;
    current.resolve(event.type === "complete");
  });

  useEffect(() => {
    let current = true;
    void window.reader.listAiProviders()
      .then((next) => { if (current) setProviders(next); })
      .catch((reason) => { if (current) setProviderError(errorMessage(reason)); });
    return () => { current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setTranslations(new Map()); setProviderError(undefined);
    if (!provider) { setProviderError("尚未配置可用的 AI 服务。"); return; }
    const batches = batchImmersiveTranslationSegments(plan.segments);
    if (!batches.length) { setProviderError("当前文章没有可供翻译的正文段落。"); return; }
    setBusy(true);
    void (async () => {
      for (const batch of batches) {
        if (cancelled) return;
        const ok = await new Promise<boolean>((resolve) => {
          const id = newAiRequestId();
          active.current = { id, parser: createImmersiveTranslationStreamParser(batch.segments.map((segment) => segment.id)), resolve };
          void window.reader.startAiStream({ requestId: id, request: { provider: provider.id, task: "immersive-translation", translationTarget: target, question: bilingualTranslationQuestion(target), translationSegments: translationSegmentsForBatch(batch) } }).catch((reason) => { if (active.current?.id === id) { active.current = undefined; setProviderError(errorMessage(reason)); resolve(false); } });
        });
        if (!ok) return;
      }
      if (!cancelled) setBusy(false);
    })();
    return () => { cancelled = true; active.current?.resolve(false); active.current = undefined; };
  }, [plan, provider?.id, retry, target]);

  return <>
    <p className="reader-immersive-status" role="status">{busy ? `正在快速生成${targetLabel}…` : providerError || (plan.truncated ? "较长段落已跳过，可继续阅读原文。" : "译文仅在本次阅读中显示。")} {providerError && <><button type="button" onClick={() => setRetry((value) => value + 1)}>重试</button><button type="button" onClick={onOpenSettings}>AI 设置</button></>}</p>
    <div ref={bodyRef} className="article-body" {...handlers} dangerouslySetInnerHTML={{ __html: html }} />
  </>;
}

function SelectionAssistantCard({ request, overlay, article, sourceTitle, preferredProviderId, onClose, onOpenSettings }: {
  request: AssistantSelectionRequest;
  overlay: SelectionOverlay;
  article: ReaderArticle;
  sourceTitle?: string;
  preferredProviderId: AiProviderId;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [providers, setProviders] = useState<AiProviderSettings[]>([]);
  const [providerError, setProviderError] = useState<string>();
  const startedSelectionRequest = useRef<string | undefined>(undefined);
  const { text: answer, busy, error: streamError, reset, start } = useAiTextStream();
  const provider = useMemo(() => providers.find((item) => item.id === preferredProviderId && item.configured)
    || providers.find((item) => item.configured), [preferredProviderId, providers]);
  const cardStyle: CSSProperties = {
    left: overlay.cardLeft,
    top: overlay.cardTop,
    width: overlay.cardWidth,
    maxHeight: overlay.cardMaxHeight
  };

  useEffect(() => {
    let current = true;
    void window.reader.listAiProviders()
      .then((next) => { if (current) setProviders(next); })
      .catch((reason) => { if (current) setProviderError(errorMessage(reason)); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (startedSelectionRequest.current === request.id || !providers.length) return;
    if (!provider) {
      startedSelectionRequest.current = request.id;
      reset();
      setProviderError("尚未配置可用的 AI 服务。请先在 AI 学习中完成设置。");
      return;
    }
    startedSelectionRequest.current = request.id;
    const requestId = newAiRequestId();
    setProviderError(undefined);
    void start({
      requestId,
      request: {
        provider: provider.id,
        question: request.question,
        selection: request.selection,
        ...articlePayloadForAiRequest(article, sourceTitle, request.selection)
      }
    });
  }, [article.contentHtml, article.title, article.url, provider, providers.length, request, reset, sourceTitle, start]);

  const excerpt = request.selection.text.length > 260 ? `${request.selection.text.slice(0, 260)}…` : request.selection.text;
  const error = providerError || streamError;
  return <aside className="selection-assistant-card" data-placement={overlay.placement} data-intent={request.selection.intent} style={cardStyle} aria-label={`${selectedTextLabel(request.selection.intent)}结果`}>
    <header>
      <div><p>{selectedTextLabel(request.selection.intent)}</p><strong>{provider?.label || "AI 学习"}</strong></div>
      <button type="button" onClick={onClose} aria-label="关闭所选文字回答">×</button>
    </header>
    <blockquote>“{excerpt}”</blockquote>
    <div className="selection-assistant-answer" aria-live="polite" aria-busy={busy}>
      {busy && !answer && <p className="ai-streaming-status">{request.selection.intent === "translate" ? "正在翻译所选文字…" : "正在结合文章上下文生成…"}</p>}
      {answer && <AiMarkdownContent text={answer} />}
      {error && <p className="selection-assistant-error">{error}</p>}
    </div>
    {error && !provider && <button type="button" className="selection-assistant-settings" onClick={onOpenSettings}>打开 AI 设置</button>}
  </aside>;
}

function ImagePreview({ image, onClose }: { image: ReaderImagePreview; onClose: () => void }) {
  return <div className="reader-image-lightbox" role="presentation" onClick={onClose}>
    <section className="reader-image-lightbox__frame" role="dialog" aria-modal="true" aria-label={image.alt} onClick={(event) => event.stopPropagation()}>
      <button type="button" className="reader-image-lightbox__close" onClick={onClose} autoFocus aria-label="关闭图片预览">×</button>
      <img src={image.src} alt={image.alt} />
    </section>
  </div>;
}

function ReaderAssistant({ article, sourceTitle, providerId: controlledProviderId, onProviderChange, minimized, onMinimize, onClose, onOpenSettings }: {
  article: ReaderArticle;
  sourceTitle?: string;
  providerId: AiProviderId;
  onProviderChange: (providerId: AiProviderId) => void;
  minimized: boolean;
  onMinimize: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
}) {
  const [providers, setProviders] = useState<AiProviderSettings[]>([]);
  const [providerId, setProviderId] = useState<AiProviderId>(controlledProviderId);
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const activeStream = useRef<ActiveAiStream | undefined>(undefined);
  const messagesElement = useRef<HTMLDivElement>(null);

  const selected = providers.find((provider) => provider.id === providerId);
  const reloadProviders = useCallback(async () => {
    const next = await window.reader.listAiProviders();
    setProviders(next);
    const active = next.find((provider) => provider.id === controlledProviderId) || next[0];
    if (active) {
      setProviderId(active.id);
      onProviderChange(active.id);
    }
  }, [controlledProviderId, onProviderChange]);
  useEffect(() => { void reloadProviders().catch((reason) => setError(errorMessage(reason))); }, [reloadProviders]);
  useAiStreamSubscription((event) => {
    const active = activeStream.current;
    if (!active || active.requestId !== event.requestId) return;
    if (event.type === "delta") {
      setMessages((current) => current.map((message) => message.id === active.assistantMessageId
        ? { ...message, text: `${message.text}${event.text}` }
        : message));
      return;
    }
    activeStream.current = undefined;
    setBusy(false);
    if (event.type === "complete") {
      setMessages((current) => current.map((message) => message.id === active.assistantMessageId
        ? { ...message, text: event.answer.text, streaming: false }
        : message));
      return;
    }
    setMessages((current) => current.map((message) => message.id === active.assistantMessageId
      ? { ...message, text: message.text ? `${message.text}\n\n生成中断：${event.message}` : event.message, error: true, streaming: false }
      : message));
  });
  useEffect(() => {
    const element = messagesElement.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

  function switchProvider(nextId: AiProviderId) {
    setProviderId(nextId);
    onProviderChange(nextId);
    setError(undefined);
  }

  async function startQuestion(textValue: string, selection?: AiSelectionContext) {
    const text = textValue.trim();
    if (!text || busy) return;
    if (!selected?.configured) {
      setError(selected?.requiresApiKey ? "请先在设置中配置 API Key。" : "未检测到本机 Codex CLI。请安装并登录后重试。");
      onOpenSettings();
      return;
    }
    setQuestion(""); setBusy(true); setError(undefined);
    const requestId = newAiRequestId();
    const assistantMessageId = newAiRequestId();
    activeStream.current = { requestId, assistantMessageId };
    const displayText = selection
      ? `${selectedTextLabel(selection.intent)}\n\n“${selection.text}”\n\n${text}`
      : text;
    setMessages((current) => [...current, { id: newAiRequestId(), role: "user", text: displayText }, { id: assistantMessageId, role: "assistant", text: "", streaming: true }]);
    try {
      await window.reader.startAiStream({
        requestId,
        request: {
          provider: providerId,
          question: text,
          selection,
          ...articlePayloadForAiRequest(article, sourceTitle, selection)
        }
      });
    } catch (reason) {
      const message = errorMessage(reason);
      if (activeStream.current?.requestId !== requestId) return;
      activeStream.current = undefined;
      setBusy(false);
      setMessages((current) => current.map((item) => item.id === assistantMessageId ? { ...item, text: message, error: true, streaming: false } : item));
    }
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    await startQuestion(question);
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!shouldSubmitAssistantQuestion(event.key, event.shiftKey, event.nativeEvent.isComposing)) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  return <aside className={`reader-ai-panel${minimized ? " is-minimized" : ""}`} aria-label="AI 学习助手" aria-hidden={minimized}>
    <header><div><strong>AI 学习助手</strong><p>提问时才会发送当前文章的文本摘录。</p></div><div className="assistant-header-actions"><button type="button" className="panel-icon-button" onClick={onMinimize} aria-label="最小化 AI 学习助手" title="最小化">−</button><button type="button" className="panel-icon-button" onClick={onClose} aria-label="关闭 AI 学习助手" title="关闭">×</button></div></header>
    <div className="ai-provider-row"><label htmlFor="ai-provider">服务</label><select id="ai-provider" value={providerId} onChange={(event) => switchProvider(event.target.value as AiProviderId)} disabled={busy}>{providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}</select><button type="button" onClick={onOpenSettings} disabled={busy}>设置</button></div>
    {selected?.availabilityMessage && <p className="ai-provider-note">{selected.availabilityMessage}</p>}
    {error && <p className="error ai-error">{error}</p>}
    <div className="ai-messages" aria-live="polite" aria-busy={busy} ref={messagesElement}>{!messages.length && <p className="ai-empty">可以让 AI 解释概念、公式推导、例子或文章中的论证。回答不会保存到数据库。</p>}{messages.map((message) => <div key={message.id} className={`ai-message ${message.role}${message.error ? " error" : ""}${message.streaming ? " is-streaming" : ""}`}><strong>{message.role === "user" ? "你" : selected?.label || "AI"}</strong>{message.streaming && !message.text ? <p className="ai-streaming-status">正在生成…</p> : <AiMarkdownContent text={message.text} />}</div>)}</div>
    <form className="ai-question" onSubmit={(event) => void ask(event)}><label htmlFor="ai-question">向文章提问（Enter 发送，Shift+Enter 换行）</label><textarea id="ai-question" value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={submitOnEnter} placeholder="例如：请用直觉解释这个公式的含义" disabled={busy} /><button className="primary" disabled={busy || !question.trim()}>{busy ? "回答中…" : "发送问题"}</button></form>
  </aside>;
}
