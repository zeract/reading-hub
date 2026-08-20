import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { app, BrowserWindow } from "electron";

console.log("Reading Hub visual audit: starting Electron layout checks");

const root = path.resolve(import.meta.dirname, "..");
// A running development app owns its normal Chromium profile. Visual checks are
// deterministic fixtures, so they neither need nor should contend for that
// profile's SingletonLock.
app.setPath("userData", path.join(tmpdir(), `reading-hub-visual-audit-${process.pid}`));
const css = await readFile(path.join(root, "src/renderer/styles.css"), "utf8");
const outputDirectory = process.env.READING_HUB_VISUAL_OUTPUT;
const viewports = [
  { name: "compact", width: 1024, height: 768, zoom: 1 },
  { name: "default", width: 1280, height: 800, zoom: 1 },
  { name: "wide-large-text", width: 1440, height: 900, zoom: 1.25 },
  { name: "ultra-wide", width: 1720, height: 960, zoom: 1 }
];

function page() {
  const largeImage = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='1800' height='900'><rect width='100%' height='100%' fill='#d6cec0'/><text x='70' y='160' fill='#1b1b17' font-size='96'>Reading Hub visual fixture</text></svg>");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
    <main class="shell" id="shell"><header class="app-titlebar" id="app-titlebar"><div class="app-titlebar-actions"><button class="app-titlebar-button" aria-label="收起来源"><svg viewBox="0 0 24 24"><rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M9 4v16M12.5 9h4"/></svg></button><button class="app-titlebar-button" aria-label="刷新"><svg viewBox="0 0 24 24"><path d="M20 11a8 8 0 1 0 1.1 4M20 5v6h-6"/></svg></button><button class="app-titlebar-button app-titlebar-add" aria-label="添加来源"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button></div></header><aside class="sidebar" id="source-sidebar"><nav class="library-nav" id="library-nav"><div class="section-title" id="library-heading">阅读</div><button class="library-filter selected"><span><svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18"/></svg>今日</span></button><button class="library-filter"><span><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/></svg>未读</span><em>12</em></button><button class="library-filter"><span><svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.8-5.4 2.8 1-6.1-4.4-4.3 6.1-.9Z"/></svg>收藏</span><em>6</em></button></nav><section class="source-section"><div class="section-title" id="source-heading">来源 <span>12</span></div><div class="source-list"><section class="source-group"><button class="source-group-heading"><span class="source-group-label"><svg viewBox="0 0 24 24"><path d="m7 9 5 5 5-5"/></svg><svg class="folder-icon" viewBox="0 0 24 24"><path d="M3.5 7.5h6l1.7 2H20.5v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/></svg><span>网页与订阅</span></span><em>2</em></button><button class="source-filter selected"><span class="source-icon source-icon--rss"><svg viewBox="0 0 24 24"><circle cx="6" cy="18" r="1"/><path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14"/></svg></span><span class="source-title">测试来源名称应仅显示一行</span></button></section></div></section><footer class="sidebar-footer"><button class="sidebar-settings-button"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/></svg><span>设置</span></button></footer></aside><section class="timeline" id="entry-timeline"><header><div><p class="eyebrow">阅读收件箱</p><h1>今日更新</h1></div><span class="count">12 篇更新</span></header><div class="entry-list"><article class="entry-card selected"><button class="entry-main"><div class="entry-copy"><p class="entry-source">科学空间 · 今天</p><h2>这是一个在窄窗口和大字号下仍必须限制为两行显示的非常长的文章标题测试样例</h2><p class="summary">这是用于验证文章摘要在时间线卡片内会随可用列宽安全截断的长文本；它不能越过卡片边界，也不能无限增高，而应在两行之后明确以省略效果收束，保持列表浏览时的视觉节奏和可读性。</p></div></button></article><article class="entry-card"><button class="entry-main"><div class="entry-copy"><p class="entry-source">测试来源 · 昨天</p><h2>另一篇待读文章</h2></div></button></article></div></section>
    <section class="reader-view reader--scientific" data-reader-preset="reading" style="--reader-font-scale: 1">
      <header class="reader-toolbar"><div class="reader-toolbar-spacer"></div><div class="reader-toolbar-center"><p>科学空间</p><div class="reader-controls"><button>阅读</button></div></div><div class="reader-toolbar-actions"><button class="toolbar-icon-button favorite-button is-favorite">★</button><button class="toolbar-icon-button ai-toggle">✦</button><button class="toolbar-icon-button reader-focus-toggle" aria-pressed="false">⛶</button><button class="toolbar-icon-button external-button">↗</button></div></header>
      <div class="reader-workspace reader-workspace--assistant"><div class="reader-scroll"><article class="reader-article"><header><p class="eyebrow">视觉回归夹具</p><h1>中文长标题与数学公式布局</h1></header><div class="article-body">
        <p>这段内容用于检查文字、图片、表格和公式编号在不同窗口与字号下不会错误重叠或撑破阅读列。</p>
        <span class="katex-display" id="formula-normal"><span class="katex"><span class="katex-html"><span class="tag">(13)</span><span class="base">∇<sub>z</sub>S(q, i)</span><span class="base"> = q</span><span class="base"> − e<sub>i</sub></span></span></span></span>
        <span class="katex-display" id="formula-wide"><span class="katex"><span class="katex-html"><span class="tag">(14)</span><span class="base">W₃(SiTU(W₁x;β₁) ⊙ softcap(W₂x;β₂))</span><span class="base"> + ∑ᵢ αᵢ·underbrace{xᵢ}_{long scientific expression}</span></span></span></span>
        <mjx-container id="formula-mathjax" display="true"><mjx-math><svg width="1040" height="48" aria-label="Scientific Spaces fallback formula"><text x="0" y="28">qᵢ = [(α − 1) / α · (zᵢ − λ)]₊¹⁄⁽ᵅ⁻¹⁾</text></svg></mjx-math></mjx-container>
        <img id="fixture-image" src="${largeImage}" alt="large fixture" />
        <table><thead><tr><th>来源</th><th>状态</th></tr></thead><tbody><tr><td>OpenAlex</td><td>正常</td></tr></tbody></table>
      </div></article></div><div class="reader-selection-underlines" aria-hidden="true"><span id="selection-underline" style="left: 58vw; top: 302px; width: 124px"></span></div><section class="reader-selection-toolbar" id="selection-toolbar" style="left: 58vw; top: 308px"><button>翻译</button><button>解释</button><button>提问</button><button>×</button></section><aside class="selection-assistant-card" id="selection-card" data-placement="below" style="left: 56vw; top: 356px; width: min(330px,calc(100vw - 32px)); max-height: 250px"><header><div><p>解释所选文字</p><strong>本机 Codex CLI</strong></div><button>×</button></header><blockquote>“这段选中的文章文字会保留在就地回答旁边。”</blockquote><div class="selection-assistant-answer"><p>这是一个和正文紧邻的流式回答卡片，长内容将在卡片内滚动。</p><pre class="ai-code-block" id="selection-card-code"><code>selection_answer_must_not_expand_the_reading_workspace_0123456789</code></pre></div></aside><aside class="reader-ai-panel" id="assistant-panel"><header><div><strong>AI 学习助手</strong><p>提问时才会发送文章摘录。</p></div><div class="assistant-header-actions"><button class="panel-icon-button">−</button><button class="panel-icon-button">×</button></div></header><div class="ai-messages"><div class="ai-message" id="assistant-markdown"><strong>AI</strong><div class="ai-message-content ai-markdown"><h2 class="ai-markdown-heading">推导摘要</h2><p class="ai-markdown-paragraph">这是一段 <strong>Markdown</strong> 回答。</p><ul class="ai-markdown-list"><li>列表项</li><li><code class="ai-inline-code">inline_code</code></li></ul><pre class="ai-code-block" id="assistant-code"><code>very_long_identifier_that_must_scroll_instead_of_overflowing_the_assistant_sidebar_0123456789</code></pre><div class="ai-table-wrap"><table><thead><tr><th>方法</th><th>复杂度</th></tr></thead><tbody><tr><td>线性</td><td>O(n)</td></tr></tbody></table></div></div></div></div><form class="ai-question"><label>向文章提问</label><textarea>这个公式表达什么？</textarea><button class="primary">发送问题</button></form></aside></div>
    </section></main><div class="reader-image-lightbox" id="image-lightbox" hidden><section class="reader-image-lightbox__frame"><button class="reader-image-lightbox__close">×</button><img id="lightbox-image" src="${largeImage}" alt="large fixture preview" /></section></div></body></html>`;
}

function overlaps(a, b) {
  // Chromium can report adjacent glyph boxes with a few hundredths of a pixel
  // of overlap at non-integer zoom. Treat only a visually meaningful overlap
  // as a collision, while keeping the test sensitive to real stacking.
  const width = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const height = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  return width > 0.5 && height > 0.5;
}

async function auditViewport(window, viewport) {
  window.setSize(viewport.width, viewport.height);
  window.webContents.setZoomFactor(viewport.zoom);
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page())}`);
  const geometry = await window.webContents.executeJavaScript(`(() => { try { return (${() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      const value = element?.getBoundingClientRect();
      return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height } : undefined;
    };
    const formula = (id) => {
      const root = document.querySelector(id);
      const tag = root?.querySelector('.tag');
      const bases = [...(root?.querySelectorAll('.base') || [])].map((base) => {
        const value = base.getBoundingClientRect();
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom };
      });
      const rootRect = root?.getBoundingClientRect();
      const tagRect = tag?.getBoundingClientRect();
      const baseRect = bases[0];
      return rootRect && tagRect && baseRect ? {
        root: { left: rootRect.left, right: rootRect.right, width: rootRect.width },
        tag: { left: tagRect.left, right: tagRect.right, top: tagRect.top, bottom: tagRect.bottom },
        base: { left: baseRect.left, right: baseRect.right, top: baseRect.top, bottom: baseRect.bottom },
        bases,
        scrollWidth: root.scrollWidth, clientWidth: root.clientWidth
      } : undefined;
    };
    const image = document.querySelector('#fixture-image');
    const article = document.querySelector('.reader-article');
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      normal: formula('#formula-normal'),
      wide: formula('#formula-wide'),
      image: image && article ? { width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, articleWidth: article.getBoundingClientRect().width } : undefined,
      timelineSummary: (() => {
        const summary = document.querySelector('.entry-card.selected .summary');
        const copy = document.querySelector('.entry-card.selected .entry-copy');
        const summaryRect = summary?.getBoundingClientRect();
        const copyRect = copy?.getBoundingClientRect();
        return summary && summaryRect && copyRect ? {
          left: summaryRect.left,
          right: summaryRect.right,
          height: summaryRect.height,
          scrollHeight: summary.scrollHeight,
          clientHeight: summary.clientHeight,
          copyRight: copyRect.right
        } : undefined;
      })(),
      lightbox: (() => {
        const root = document.querySelector('#image-lightbox');
        const image = document.querySelector('#lightbox-image');
        if (!(root instanceof HTMLElement) || !(image instanceof HTMLImageElement)) return undefined;
        root.hidden = false;
        const rootRect = root.getBoundingClientRect();
        const imageRect = image.getBoundingClientRect();
        root.hidden = true;
        return {
          root: { left: rootRect.left, right: rootRect.right, top: rootRect.top, bottom: rootRect.bottom },
          image: { width: imageRect.width, height: imageRect.height }
        };
      })(),
      mathJax: (() => {
        const element = document.querySelector('#formula-mathjax');
        return element ? { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth } : undefined;
      })(),
      assistant: (() => {
        const panel = document.querySelector('#assistant-panel');
        const workspace = document.querySelector('.reader-workspace');
        const scroll = document.querySelector('.reader-scroll');
        const panelRect = panel?.getBoundingClientRect();
        const workspaceRect = workspace?.getBoundingClientRect();
        const scrollRect = scroll?.getBoundingClientRect();
        const markdown = document.querySelector('#assistant-markdown')?.getBoundingClientRect();
        const code = document.querySelector('#assistant-code');
        return panelRect && workspaceRect && scrollRect && markdown ? { panel: { left: panelRect.left, right: panelRect.right, top: panelRect.top, bottom: panelRect.bottom }, workspace: { left: workspaceRect.left, right: workspaceRect.right, top: workspaceRect.top, bottom: workspaceRect.bottom }, scroll: { left: scrollRect.left, right: scrollRect.right }, markdown: { left: markdown.left, right: markdown.right }, code: code ? { scrollWidth: code.scrollWidth, clientWidth: code.clientWidth } : undefined } : undefined;
      })(),
      toolbar: (() => {
        const toolbar = document.querySelector('.reader-toolbar')?.getBoundingClientRect();
        const controls = [...document.querySelectorAll('.reader-toolbar button')].map((button) => button.getBoundingClientRect());
        return toolbar ? { left: toolbar.left, right: toolbar.right, controls: controls.map((control) => ({ left: control.left, right: control.right, top: control.top, bottom: control.bottom })) } : undefined;
      })(),
      selectionToolbar: (() => {
        const root = document.querySelector('#selection-toolbar');
        const rootRect = root?.getBoundingClientRect();
        const controls = root ? [...root.querySelectorAll('button')].map((control) => control.getBoundingClientRect()) : [];
        return rootRect ? { left: rootRect.left, right: rootRect.right, top: rootRect.top, bottom: rootRect.bottom, controls: controls.map((control) => ({ left: control.left, right: control.right, top: control.top, bottom: control.bottom })) } : undefined;
      })(),
      selectionAnswer: (() => {
        const root = document.querySelector('#selection-card');
        const answer = document.querySelector('.selection-assistant-answer');
        const code = document.querySelector('#selection-card-code');
        const underline = document.querySelector('#selection-underline');
        const rootRect = root?.getBoundingClientRect();
        const answerRect = answer?.getBoundingClientRect();
        const underlineRect = underline?.getBoundingClientRect();
        return rootRect && answerRect && underlineRect ? {
          card: { left: rootRect.left, right: rootRect.right, top: rootRect.top, bottom: rootRect.bottom },
          answer: { left: answerRect.left, right: answerRect.right, top: answerRect.top, bottom: answerRect.bottom, scrollHeight: answer?.scrollHeight, clientHeight: answer?.clientHeight },
          code: code ? { scrollWidth: code.scrollWidth, clientWidth: code.clientWidth } : undefined,
          underline: { left: underlineRect.left, right: underlineRect.right, top: underlineRect.top, bottom: underlineRect.bottom }
        } : undefined;
      })(),
      sidebars: (() => {
        const shell = document.querySelector('#shell');
        const sidebar = document.querySelector('#source-sidebar');
        const timeline = document.querySelector('#entry-timeline');
        const reader = document.querySelector('.reader-view');
        const initialSidebar = sidebar?.getBoundingClientRect();
        const initialTimeline = timeline?.getBoundingClientRect();
        const initialReader = reader?.getBoundingClientRect();
        shell?.classList.add('shell--sidebar-collapsed');
        const collapsedSidebar = sidebar?.getBoundingClientRect();
        const collapsedReader = reader?.getBoundingClientRect();
        shell?.classList.remove('shell--sidebar-collapsed');
        shell?.classList.add('shell--reader-only');
        const readerOnlySidebar = sidebar?.getBoundingClientRect();
        const readerOnlyTimeline = timeline?.getBoundingClientRect();
        const readerOnlyReader = reader?.getBoundingClientRect();
        shell?.classList.remove('shell--reader-only');
        return initialSidebar && initialTimeline && initialReader && collapsedSidebar && collapsedReader && readerOnlySidebar && readerOnlyTimeline && readerOnlyReader ? {
          initialSidebarWidth: initialSidebar.width,
          initialTimelineWidth: initialTimeline.width,
          initialReaderWidth: initialReader.width,
          collapsedSidebarWidth: collapsedSidebar.width,
          collapsedReaderWidth: collapsedReader.width,
          readerOnlySidebarWidth: readerOnlySidebar.width,
          readerOnlyTimelineWidth: readerOnlyTimeline.width,
          readerOnlyReaderWidth: readerOnlyReader.width
        } : undefined;
      })(),
      titlebar: (() => {
        const titlebar = document.querySelector('#app-titlebar')?.getBoundingClientRect();
        const controls = [...document.querySelectorAll('.app-titlebar-button')].map((button) => button.getBoundingClientRect());
        return titlebar ? { left: titlebar.left, right: titlebar.right, height: titlebar.height, controls: controls.map((control) => ({ left: control.left, right: control.right, top: control.top, bottom: control.bottom })) } : undefined;
      })(),
      fullscreenTitlebar: (() => {
        const shell = document.querySelector('#shell');
        shell?.classList.add('shell--fullscreen');
        const controls = [...document.querySelectorAll('.app-titlebar-button')].map((button) => button.getBoundingClientRect());
        shell?.classList.remove('shell--fullscreen');
        return { controls: controls.map((control) => ({ left: control.left, right: control.right, top: control.top, bottom: control.bottom })) };
      })(),
      sourceList: (() => {
        const row = document.querySelector('.source-filter')?.getBoundingClientRect();
        const sourceTitle = document.querySelector('.source-title');
        const title = sourceTitle?.getBoundingClientRect();
        const icon = document.querySelector('.source-icon')?.getBoundingClientRect();
        const folder = document.querySelector('.folder-icon')?.getBoundingClientRect();
        const sourceHeading = document.querySelector('.source-group-heading');
        const libraryHeading = document.querySelector('#library-heading')?.getBoundingClientRect();
        const libraryNav = document.querySelector('#library-nav')?.getBoundingClientRect();
        const sourceSectionHeading = document.querySelector('#source-heading')?.getBoundingClientRect();
        const libraryFilterElement = document.querySelector('.library-filter.selected');
        const libraryFilter = libraryFilterElement?.getBoundingClientRect();
        return row && title && icon && folder && sourceTitle && sourceHeading && libraryHeading && libraryNav && sourceSectionHeading && libraryFilterElement && libraryFilter ? {
          rowHeight: row.height,
          titleHeight: title.height,
          icon: { width: icon.width, height: icon.height },
          folder: { width: folder.width, height: folder.height },
          sourceFontSize: Number.parseFloat(getComputedStyle(sourceTitle).fontSize),
          groupFontSize: Number.parseFloat(getComputedStyle(sourceHeading).fontSize),
          libraryFontSize: Number.parseFloat(getComputedStyle(libraryFilterElement).fontSize),
          libraryHeadingBottom: libraryHeading.bottom,
          libraryFilterTop: libraryFilter.top,
          libraryNavBottom: libraryNav.bottom,
          sourceHeadingTop: sourceSectionHeading.top
        } : undefined;
      })(),
      theme: (() => {
        const root = getComputedStyle(document.documentElement);
        const underline = document.querySelector('#selection-underline');
        const card = document.querySelector('#selection-card');
        const selectedEntry = document.querySelector('.entry-card.selected');
        const selectedSource = document.querySelector('.source-filter.selected');
        return {
          accent: root.getPropertyValue('--accent').trim(),
          selectionAccent: root.getPropertyValue('--selection-accent').trim(),
          underline: underline ? getComputedStyle(underline).backgroundColor : undefined,
          cardShadow: card ? getComputedStyle(card).boxShadow : undefined,
          selectedEntry: selectedEntry ? getComputedStyle(selectedEntry).backgroundColor : undefined,
          selectedSource: selectedSource ? getComputedStyle(selectedSource).backgroundColor : undefined
        };
      })()
    };
  }})() } catch (error) { return { visualAuditError: String(error), visualAuditStack: error instanceof Error ? error.stack : undefined }; } })()`);
  if (geometry.visualAuditError) throw new Error(`视觉夹具脚本异常：${geometry.visualAuditError}\n${geometry.visualAuditStack || ""}`);
  const failures = [];
  for (const name of ["normal", "wide"]) {
    const formula = geometry[name];
    if (!formula) failures.push(`${name}: 公式夹具缺失`);
    else if (formula.bases.some((base) => overlaps(formula.tag, base))) failures.push(`${name}: 公式编号与主体重叠`);
    else if (formula.tag.left < Math.max(...formula.bases.map((base) => base.right)) + 4) failures.push(`${name}: 公式编号未保留最小间距`);
    else if (formula.bases.some((base, index) => formula.bases.slice(index + 1).some((other) => overlaps(base, other)))) {
      failures.push(`${name}: KaTeX 公式分段主体互相重叠`);
    }
  }
  if (geometry.pageOverflow) failures.push("页面出现非预期横向滚动");
  if (!geometry.wide || geometry.wide.scrollWidth <= geometry.wide.clientWidth) failures.push("超宽公式没有落入自身可滚动容器");
  if (!geometry.mathJax || geometry.mathJax.scrollWidth <= geometry.mathJax.clientWidth) failures.push("科学空间 MathJax/SVG 公式没有落入自身可滚动容器");
  if (!geometry.image || geometry.image.width > geometry.image.articleWidth + 1 || geometry.image.height > Math.min(360, viewport.height * 0.45) + 2) failures.push("图片尺寸没有受正文列约束");
  if (!geometry.timelineSummary || geometry.timelineSummary.right > geometry.timelineSummary.copyRight + 1 || geometry.timelineSummary.height > 36 || geometry.timelineSummary.scrollHeight <= geometry.timelineSummary.clientHeight) {
    failures.push("时间线摘要没有在卡片宽度内截断为两行");
  }
  if (!geometry.lightbox || !geometry.viewport || geometry.lightbox.root.left > 1 || geometry.lightbox.root.top > 1 || geometry.lightbox.root.right < geometry.viewport.width - 1 || geometry.lightbox.root.bottom < geometry.viewport.height - 1 || geometry.lightbox.image.width > geometry.viewport.width || geometry.lightbox.image.height > geometry.viewport.height) {
    failures.push("图片放大预览没有受视口约束");
  }
  if (!geometry.assistant || geometry.assistant.panel.left < geometry.assistant.workspace.left - 1 || geometry.assistant.panel.right > geometry.assistant.workspace.right + 1 || geometry.assistant.panel.top < geometry.assistant.workspace.top - 1 || geometry.assistant.panel.bottom > geometry.assistant.workspace.bottom + 1) {
    failures.push("AI 学习面板超出阅读器工作区");
  }
  if (!geometry.assistant?.markdown || geometry.assistant.markdown.left < geometry.assistant.panel.left - 1 || geometry.assistant.markdown.right > geometry.assistant.panel.right + 1 || !geometry.assistant.code || geometry.assistant.code.scrollWidth <= geometry.assistant.code.clientWidth) {
    failures.push("AI Markdown 回答在侧栏中没有受宽度约束或长代码没有独立滚动");
  }
  if (!geometry.toolbar || geometry.toolbar.controls.some((control) => control.left < geometry.toolbar.left - 1 || control.right > geometry.toolbar.right + 1)) {
    failures.push("阅读器工具栏按钮溢出");
  }
  if (!geometry.selectionToolbar || !geometry.viewport || geometry.selectionToolbar.left < 0 || geometry.selectionToolbar.right > geometry.viewport.width || geometry.selectionToolbar.top < 0 || geometry.selectionToolbar.bottom > geometry.viewport.height || geometry.selectionToolbar.controls.some((control) => control.left < geometry.selectionToolbar.left - 1 || control.right > geometry.selectionToolbar.right + 1)) {
    failures.push("划词操作工具栏在当前窗口或字号下溢出");
  }
  if (!geometry.selectionAnswer || !geometry.viewport || geometry.selectionAnswer.card.left < 0 || geometry.selectionAnswer.card.right > geometry.viewport.width || geometry.selectionAnswer.card.top < 0 || geometry.selectionAnswer.card.bottom > geometry.viewport.height || geometry.selectionAnswer.answer.left < geometry.selectionAnswer.card.left - 1 || geometry.selectionAnswer.answer.right > geometry.selectionAnswer.card.right + 1 || !geometry.selectionAnswer.code || geometry.selectionAnswer.code.scrollWidth <= geometry.selectionAnswer.code.clientWidth || geometry.selectionAnswer.underline.width <= 0 || !geometry.selectionToolbar || geometry.selectionAnswer.card.top < geometry.selectionToolbar.bottom - 1) {
    failures.push("划词就地回答卡片、下划线或长内容滚动异常");
  }
  const expectedSidebarWidth = geometry.viewport && geometry.viewport.width <= 1080 ? 212 : 244;
  if (!geometry.sidebars || Math.abs(geometry.sidebars.initialSidebarWidth - expectedSidebarWidth) > 1 || geometry.sidebars.collapsedSidebarWidth > 1.25 || geometry.sidebars.collapsedReaderWidth < geometry.sidebars.initialReaderWidth + expectedSidebarWidth - 2 || geometry.sidebars.readerOnlySidebarWidth > 1.25 || geometry.sidebars.readerOnlyTimelineWidth > 1.25 || geometry.sidebars.readerOnlyReaderWidth < geometry.sidebars.initialReaderWidth + geometry.sidebars.initialSidebarWidth + geometry.sidebars.initialTimelineWidth - 2) {
    failures.push("来源侧边栏无法在阅读时正确收起或恢复正文宽度");
  }
  if (!geometry.titlebar || geometry.titlebar.height < 40 || geometry.titlebar.controls.some((control) => control.left < geometry.titlebar.left - 1 || control.right > geometry.titlebar.right + 1 || control.top < 0 || control.bottom > geometry.titlebar.height + 1)) {
    failures.push("应用顶部导航没有保持在标题栏内");
  }
  if (!geometry.titlebar || !geometry.fullscreenTitlebar || Math.abs((geometry.titlebar.controls[0]?.left || 0) - 96) > 1 || Math.abs((geometry.fullscreenTitlebar.controls[0]?.left || 0) - 16) > 1) {
    failures.push("全屏时顶部按钮没有随 macOS 交通灯隐藏而左移");
  }
  if (!geometry.sourceList || geometry.sourceList.rowHeight > 37 || geometry.sourceList.titleHeight > 21 || Math.abs(geometry.sourceList.icon.width - 18) > 1 || Math.abs(geometry.sourceList.folder.width - 13) > 1 || Math.abs(geometry.sourceList.sourceFontSize - geometry.sourceList.groupFontSize) > .1 || geometry.sourceList.libraryFontSize > geometry.sourceList.groupFontSize + .1 || geometry.sourceList.libraryHeadingBottom > geometry.sourceList.libraryFilterTop + 1 || geometry.sourceList.sourceHeadingTop - geometry.sourceList.libraryNavBottom > 12) failures.push("来源列表的图标、字号层级或阅读分类间距异常");
  if (!geometry.theme || geometry.theme.accent !== "#4f7ea8" || geometry.theme.selectionAccent !== "#4f7ea8" || !geometry.theme.underline?.includes("79, 126, 168") || !geometry.theme.cardShadow?.includes("rgba(27, 32, 39, 0.12)") || geometry.theme.selectedEntry !== "rgb(220, 232, 245)" || geometry.theme.selectedSource !== "rgb(220, 232, 245)") {
    failures.push("原生蓝色选中状态、划词状态或浮层层级未保持一致");
  }
  const shouldDockAssistant = geometry.viewport && geometry.viewport.width >= 1380;
  if (shouldDockAssistant && geometry.assistant && geometry.assistant.panel.left < geometry.assistant.scroll.right - 1) {
    failures.push("超宽窗口中的 AI 学习面板覆盖了正文滚动区，而非停靠在右侧");
  }
  if (outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, `${viewport.name}.png`), await window.webContents.capturePage().then((image) => image.toPNG()));
  }
  return { viewport, geometry, failures };
}

await app.whenReady();
const window = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { contextIsolation: true, sandbox: true } });
try {
  const report = [];
  for (const viewport of viewports) report.push(await auditViewport(window, viewport));
  console.log(JSON.stringify(report, null, 2));
  const failed = report.flatMap((item) => item.failures.map((failure) => `${item.viewport.name}: ${failure}`));
  if (failed.length) throw new Error(failed.join("\n"));
} finally {
  if (!window.isDestroyed()) window.destroy();
  app.quit();
}
