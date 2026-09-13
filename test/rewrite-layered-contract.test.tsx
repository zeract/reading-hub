// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { load } from 'cheerio';
import { extractReaderArticle } from '../src/main/article-reader';
import { rewriteArticleDocument } from '../src/main/document-rewrite';
import { decodeRewriteResult, encodeRewriteResult } from '../src/main/rewrite-document';
import { articleDocumentHtml } from '../src/shared/article-document';
import { ArticleBody } from '../src/renderer/article-body';
import type { Entry } from '../src/shared/types';

it('independently checks source semantics before translating, storing and mounting the shared body', async () => {
  const url = 'https://example.com/workflow';
  const html = `<style>.facts > div {display:grid;grid-template-columns:150px 1fr}</style><article>
    <h1>Workflow</h1><p>${'Technical context with explicit structure. '.repeat(50)}</p>
    <h2>Getting started</h2><div class="facts">
      <div><b>Prerequisites</b><div>Read <a href="https://example.com/guide">the guide</a>.</div></div>
      <div><b>Infrastructure</b><div>Use <code>intent.md</code>.</div></div>
    </div><div style="white-space:pre; font-family:monospace">{\n  "allow": ["Read(*)"]\n}</div>
    <ul><li>First<ul><li>Nested</li></ul></li></ul>
    <figure><img src="https://example.com/plot.png" alt="Plot"><figcaption>Measured result.</figcaption></figure>
    </article>`;
  const source = extractReaderArticle(html, url, { id: 'fixture', title: 'Workflow', url } as Entry)!.article.document!;
  const $ = load(articleDocumentHtml(source));
  // These expectations come from the authored fixture, not an output-vs-input comparison.
  expect($('table tr')).toHaveLength(2);
  expect($('th').first().text()).toBe('Prerequisites');
  expect($('td a').attr('href')).toBe('https://example.com/guide');
  expect($('pre code').text()).toBe('{\n  "allow": ["Read(*)"]\n}');
  expect($('li li').text()).toBe('Nested');
  expect($('img')).toHaveLength(1);
  const result = await rewriteArticleDocument(source, 'Workflow', async (_stage, prompt) => {
    const input = JSON.parse(prompt);
    return JSON.stringify({ blocks: input.section.blocks.map((block: { id: string; text: string }) => ({
      ...block, text: block.id === 'rewrite-title.text' ? '工作流程' : block.text.replace('Prerequisites', '前置条件').replace('the guide', '这份指南')
    })) });
  }, new AbortController().signal, undefined, undefined, undefined, true);
  const saved = decodeRewriteResult(JSON.stringify({ ...result, schemaVersion: 2, provider: 'fixture', model: 'simulated',
    sourceUrl: url, sourceTitle: 'Workflow', sourceHash: 'fixture', createdAt: 1, promptVersion: 12 }));
  const restored = decodeRewriteResult(encodeRewriteResult(saved));
  expect(restored.content).toEqual(result.content);
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  try {
    await act(async () => root.render(<ArticleBody document={restored.content}/>));
    expect(container.querySelectorAll('table tr')).toHaveLength(2);
    expect(container.querySelector('th')?.textContent).toBe('前置条件');
    expect(container.querySelector('td a')?.textContent).toBe('这份指南');
    expect(container.querySelector('td a')?.getAttribute('href')).toBe('https://example.com/guide');
    expect(container.querySelector('pre code')?.textContent).toBe('{\n  "allow": ["Read(*)"]\n}');
    expect(container.querySelectorAll('img')).toHaveLength(1);
    // ArticleBody preserves source ownership; request interception is tested by the media lifecycle suite.
    expect(container.querySelector('img')?.getAttribute('src')).toBe('https://example.com/plot.png');
    expect(container.textContent).not.toContain('⟦');
    expect(container.querySelector('style')).toBeNull();
  } finally { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); }
});
