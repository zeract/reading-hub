import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { app, BrowserWindow } from "electron";

console.log("Reading Hub visual audit: starting Electron layout checks");

const root = path.resolve(import.meta.dirname, "..");
const css = await readFile(path.join(root, "src/renderer/styles.css"), "utf8");
const outputDirectory = process.env.READING_HUB_VISUAL_OUTPUT;
const viewports = [
  { name: "compact", width: 1024, height: 768, zoom: 1 },
  { name: "default", width: 1280, height: 800, zoom: 1 },
  { name: "wide-large-text", width: 1440, height: 900, zoom: 1.25 }
];

function page() {
  const largeImage = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='1800' height='900'><rect width='100%' height='100%' fill='#bbc9a4'/><text x='70' y='160' font-size='96'>Reading Hub visual fixture</text></svg>");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
    <main class="shell" id="shell"><header class="app-titlebar" id="app-titlebar"><span class="app-titlebar-mark">R</span><div class="app-titlebar-actions"><button class="app-titlebar-button">☰</button><button class="app-titlebar-button">←</button></div></header><aside class="sidebar" id="source-sidebar"><div class="section-title">来源 <span>12</span></div><div class="source-list"><button class="source-filter selected"><span class="source-title">全部内容</span><span class="source-meta">按最新时间</span></button><button class="source-filter"><span class="source-title">测试来源</span><span class="source-meta"><span class="source-meta-line"><span class="status active">正常</span><span>约 1 小时</span></span></span></button></div></aside>
    <section class="reader-view reader--scientific" data-reader-preset="reading" style="--reader-font-scale: 1">
      <header class="reader-toolbar"><div class="reader-toolbar-spacer"></div><div class="reader-toolbar-center"><p>科学空间</p><div class="reader-controls"><button>阅读</button></div></div><div class="reader-toolbar-actions"><button class="toolbar-icon-button ai-toggle">✦</button><button class="toolbar-icon-button external-button">↗</button></div></header>
      <div class="reader-workspace reader-workspace--assistant"><div class="reader-scroll"><article class="reader-article"><header><p class="eyebrow">视觉回归夹具</p><h1>中文长标题与数学公式布局</h1></header><div class="article-body">
        <p>这段内容用于检查文字、图片、表格和公式编号在不同窗口与字号下不会错误重叠或撑破阅读列。</p>
        <span class="katex-display" id="formula-normal"><span class="katex"><span class="katex-html"><span class="tag">(13)</span><span class="base">∇<sub>z</sub>S(q, i)</span><span class="base"> = q</span><span class="base"> − e<sub>i</sub></span></span></span></span>
        <span class="katex-display" id="formula-wide"><span class="katex"><span class="katex-html"><span class="tag">(14)</span><span class="base">W₃(SiTU(W₁x;β₁) ⊙ softcap(W₂x;β₂))</span><span class="base"> + ∑ᵢ αᵢ·underbrace{xᵢ}_{long scientific expression}</span></span></span></span>
        <mjx-container id="formula-mathjax" display="true"><mjx-math><svg width="1040" height="48" aria-label="Scientific Spaces fallback formula"><text x="0" y="28">qᵢ = [(α − 1) / α · (zᵢ − λ)]₊¹⁄⁽ᵅ⁻¹⁾</text></svg></mjx-math></mjx-container>
        <img id="fixture-image" src="${largeImage}" alt="large fixture" />
        <table><thead><tr><th>来源</th><th>状态</th></tr></thead><tbody><tr><td>OpenAlex</td><td>正常</td></tr></tbody></table>
      </div></article></div><aside class="reader-ai-panel" id="assistant-panel"><header><div><strong>AI 学习助手</strong><p>提问时才会发送文章摘录。</p></div><div class="assistant-header-actions"><button class="panel-icon-button">−</button><button class="panel-icon-button">×</button></div></header><div class="ai-messages"><p class="ai-empty">请解释这条公式。</p></div><form class="ai-question"><label>向文章提问</label><textarea>这个公式表达什么？</textarea><button class="primary">发送问题</button></form></aside></div>
    </section></main></body></html>`;
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
  const geometry = await window.webContents.executeJavaScript(`(${() => {
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
      pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      normal: formula('#formula-normal'),
      wide: formula('#formula-wide'),
      image: image && article ? { width: image.getBoundingClientRect().width, height: image.getBoundingClientRect().height, articleWidth: article.getBoundingClientRect().width } : undefined,
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
        return panelRect && workspaceRect && scrollRect ? { panel: { left: panelRect.left, right: panelRect.right, top: panelRect.top, bottom: panelRect.bottom }, workspace: { left: workspaceRect.left, right: workspaceRect.right, top: workspaceRect.top, bottom: workspaceRect.bottom }, scroll: { left: scrollRect.left, right: scrollRect.right } } : undefined;
      })(),
      toolbar: (() => {
        const toolbar = document.querySelector('.reader-toolbar')?.getBoundingClientRect();
        const controls = [...document.querySelectorAll('.reader-toolbar button')].map((button) => button.getBoundingClientRect());
        return toolbar ? { left: toolbar.left, right: toolbar.right, controls: controls.map((control) => ({ left: control.left, right: control.right, top: control.top, bottom: control.bottom })) } : undefined;
      })(),
      sidebars: (() => {
        const shell = document.querySelector('#shell');
        const sidebar = document.querySelector('#source-sidebar');
        const reader = document.querySelector('.reader-view');
        const initialSidebar = sidebar?.getBoundingClientRect();
        const initialReader = reader?.getBoundingClientRect();
        shell?.classList.add('shell--sidebar-collapsed');
        const collapsedSidebar = sidebar?.getBoundingClientRect();
        const collapsedReader = reader?.getBoundingClientRect();
        shell?.classList.remove('shell--sidebar-collapsed');
        return initialSidebar && initialReader && collapsedSidebar && collapsedReader ? {
          initialSidebarWidth: initialSidebar.width,
          initialReaderWidth: initialReader.width,
          collapsedSidebarWidth: collapsedSidebar.width,
          collapsedReaderWidth: collapsedReader.width
        } : undefined;
      })(),
      titlebar: (() => {
        const titlebar = document.querySelector('#app-titlebar')?.getBoundingClientRect();
        const mark = document.querySelector('.app-titlebar-mark')?.getBoundingClientRect();
        const controls = [...document.querySelectorAll('.app-titlebar-button')].map((button) => button.getBoundingClientRect());
        return titlebar && mark ? { left: titlebar.left, right: titlebar.right, height: titlebar.height, mark: { left: mark.left, right: mark.right }, controls: controls.map((control) => ({ left: control.left, right: control.right, top: control.top, bottom: control.bottom })) } : undefined;
      })(),
      fullscreenTitlebar: (() => {
        const shell = document.querySelector('#shell');
        shell?.classList.add('shell--fullscreen');
        const mark = document.querySelector('.app-titlebar-mark')?.getBoundingClientRect();
        const controls = [...document.querySelectorAll('.app-titlebar-button')].map((button) => button.getBoundingClientRect());
        shell?.classList.remove('shell--fullscreen');
        return mark ? { mark: { left: mark.left, right: mark.right }, controls: controls.map((control) => ({ left: control.left, right: control.right, top: control.top, bottom: control.bottom })) } : undefined;
      })(),
      sourceMeta: (() => {
        const badge = document.querySelector('.source-meta-line .status')?.getBoundingClientRect();
        const text = document.querySelector('.source-meta-line span:last-child')?.getBoundingClientRect();
        return badge && text ? { gap: text.left - badge.right } : undefined;
      })()
    };
  }})()`);
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
  if (!geometry.assistant || geometry.assistant.panel.left < geometry.assistant.workspace.left - 1 || geometry.assistant.panel.right > geometry.assistant.workspace.right + 1 || geometry.assistant.panel.top < geometry.assistant.workspace.top - 1 || geometry.assistant.panel.bottom > geometry.assistant.workspace.bottom + 1) {
    failures.push("AI 学习面板超出阅读器工作区");
  }
  if (!geometry.toolbar || geometry.toolbar.controls.some((control) => control.left < geometry.toolbar.left - 1 || control.right > geometry.toolbar.right + 1)) {
    failures.push("阅读器工具栏按钮溢出");
  }
  if (!geometry.sidebars || Math.abs(geometry.sidebars.initialSidebarWidth - 310) > 1 || geometry.sidebars.collapsedSidebarWidth > 1 || geometry.sidebars.collapsedReaderWidth < geometry.sidebars.initialReaderWidth + 300) {
    failures.push("来源侧边栏无法在阅读时正确收起或恢复正文宽度");
  }
  if (!geometry.titlebar || geometry.titlebar.height < 40 || geometry.titlebar.controls.some((control) => control.left < geometry.titlebar.left - 1 || control.right > geometry.titlebar.right + 1 || control.top < 0 || control.bottom > geometry.titlebar.height + 1)) {
    failures.push("应用顶部导航没有保持在标题栏内");
  }
  if (!geometry.titlebar || !geometry.fullscreenTitlebar || geometry.titlebar.mark.left < 90 || Math.abs(geometry.fullscreenTitlebar.mark.left - 16) > 1 || geometry.fullscreenTitlebar.controls.some((control) => control.left < geometry.fullscreenTitlebar.mark.right + 6)) {
    failures.push("全屏时顶部图标和按钮没有随 macOS 交通灯隐藏而左移");
  }
  if (geometry.sourceMeta === undefined || geometry.sourceMeta < 6) failures.push("来源状态和刷新时间之间缺少可读间距");
  if (viewport.name === "default" && geometry.assistant && geometry.assistant.panel.left < geometry.assistant.scroll.right - 1) {
    failures.push("宽窗口中的 AI 学习面板覆盖了正文滚动区，而非停靠在右侧");
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
