import {it,expect} from 'vitest';
import {load} from 'cheerio';
import {normalizeKeyValueGrids} from '../src/main/reader-key-values';
import {extractReaderArticle} from '../src/main/article-reader';
import {rewriteArticleDocument} from '../src/main/document-rewrite';
import {articleDocumentHtml} from '../src/shared/article-document';
import type {Entry} from '../src/shared/types';
const rows='<div><b>Prerequisites</b><div>The <code>intent.md</code> file.</div></div><div><b>Infrastructure</b><div>Repository access.</div></div>';
it('preserves declared label/value grids through extraction and rewriting',async()=>{
 const html='<style>.facts > div {display:grid;grid-template-columns:150px 1fr}</style><article><h1>Title</h1><p>'+('Context. '.repeat(120))+'</p><div class="facts">'+rows+'</div></article>';
 const article=extractReaderArticle(html,'https://example.com/a',{id:'a',title:'Title',url:'https://example.com/a'} as Entry)!.article;
 expect(load(article.contentHtml)('table tr')).toHaveLength(2);
 const r=await rewriteArticleDocument(article.document!,'Title',async(_s,p)=>JSON.stringify({blocks:JSON.parse(p).section.blocks}),new AbortController().signal,undefined,undefined,undefined,true);
 const $=load(articleDocumentHtml(r.content));expect($('th').text()).toBe('PrerequisitesInfrastructure');expect($('td code').text()).toBe('intent.md');expect($('style')).toHaveLength(0);
});
it('does not guess a table from repeated divs, single-column layouts or controls',()=>{
 for(const style of ['', 'display:grid;grid-template-columns:1fr','display:flex']){const $=load('<style>.facts > div {'+style+'}</style><div class="facts">'+rows+'</div>');normalizeKeyValueGrids($);expect($('table')).toHaveLength(0);}
 const $=load('<style>.facts > div {display:grid;grid-template-columns:10em 1fr}</style><div class="facts">'+rows.replace('Repository access.','<button>Open</button>')+'</div>');normalizeKeyValueGrids($);expect($('table')).toHaveLength(0);
});
