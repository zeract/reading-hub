import {it,expect} from 'vitest';
import {load} from 'cheerio';
import {extractReaderArticle} from '../src/main/reader-extraction';
import type {Entry} from '../src/shared/types';
const url='https://example.com/posts/current/';
const prose='<p>Complete authored technical prose. This remains the selected article and preserves its argument.</p>';
const extract=(html:string)=>extractReaderArticle(html,url,{id:'boundary',url,title:'Example'} as Entry)!.article;
it('uses a unique URL-bound authored body and excludes surrounding site chrome even for a short post',()=>{
 const a=extract(`<html><head><meta property="og:title" content="Example"></head><body><h1>Site title</h1><div>Sponsored banner</div><div class="entry"><p>Published date</p><div data-permalink-context="/posts/current/"><h2>Example</h2>${prose}<p>Price: $2.00/million input and $10/million output. Formula $t$.</p><pre><code>  run --key test\n  second</code></pre><figure><img src="/diagram.png"><figcaption>Authored caption.</figcaption></figure></div><div>Entry footer</div></div><div><h2>Recent articles</h2><ul>${'<li><a href="/other">Other post</a></li>'.repeat(30)}</ul></div><div>Archive 2002 2003</div></body></html>`);
 const $=load(a.contentHtml);
 expect($('body').text()).toContain('Complete authored technical prose.');
 expect($('body').text()).toContain('$2.00/million input and $10/million output.');
 expect($('.katex')).toHaveLength(1);expect($('pre code').text()).toBe('  run --key test\n  second');
 expect($('img').attr('src')).toBe('https://example.com/diagram.png');expect($('figcaption').text()).toBe('Authored caption.');
 expect($('body').text()).not.toMatch(/Site title|Sponsored|Recent articles|Archive|Entry footer|Published date/);
});
it('ignores another article or origin and ambiguous declarations instead of granting them verified priority',()=>{
 for(const roots of [
  '<div data-permalink-context="/other/"><p>Foreign body.</p></div>',
  '<div data-permalink-context="https://other.example/posts/current/"><p>Foreign body.</p></div>',
  '<div data-permalink-context="/posts/current/"><p>Ambiguous first.</p></div><div data-permalink-context="/posts/current/"><p>Ambiguous second.</p></div>'
 ]){
  const a=extract(`<article><h1>Example</h1>${prose.repeat(5)}<p>Correct semantic article.</p></article>${roots}`);
  expect(load(a.contentHtml)('body').text()).toContain('Correct semantic article.');
  expect(load(a.contentHtml)('body').text()).not.toMatch(/Foreign body|Ambiguous/);
 }
});
it.each(['entryPage','h-entry'])('retains a unique %s page boundary for short quote and release posts without a URL declaration',name=>{
 const a=extract(`<h1>Site title</h1><div>Sponsored banner</div><div class="${name}"><blockquote><p>Quoted authored statement that must remain complete and readable.</p></blockquote><p>— <a href="https://example.com/author">Author</a></p><div class="entryFooter">Posted date and follow links</div></div><div><h2>Recent articles</h2><ul>${'<li><a href="/other">Other post</a></li>'.repeat(40)}</ul></div><div>Archive</div>`);
 const $=load(a.contentHtml);expect($('blockquote').text()).toContain('Quoted authored statement');expect($('a').attr('href')).toBe('https://example.com/author');expect($('body').text()).not.toMatch(/Site title|Sponsored|Recent articles|Archive|Posted date/);
});
it('preserves padded TeX in citation titles while leaving surrounding currency as ordinary text',()=>{
 const a=extract(`<article>${prose}<p>A citation uses Adapt-$\\infty $. Prices are $2.00/million and $10/million.</p></article>`);
 const $=load(a.contentHtml);expect($('.katex')).toHaveLength(1);expect($('annotation').text()).toBe('\\infty');expect($('body').text()).toContain('$2.00/million and $10/million.');
});
