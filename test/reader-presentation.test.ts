import {expect,it} from 'vitest';
import {readerPresentation} from '../src/shared/reader-presentation';
import {articleDocumentFromHtml} from '../src/main/article-document';
import {articleDocumentText,articleTextChunks} from '../src/shared/article-document';
import {collectAiArticleText} from '../src/renderer/ai-request';
const document=articleDocumentFromHtml('<h2>Title</h2><p>Text <a href="https://example.com">link</a></p><pre><code>let code=1;</code></pre>');
it('projects one canonical tree without changing source HTML or legacy fallbacks',()=>{
 const original={entryId:'e',title:'Fixture',url:'https://example.com',renderProfile:'standard' as const,document,contentHtml:'<p>duplicated HTML</p>',importHtml:'<p>transient source</p>'};
 const projected=readerPresentation(original);
 expect(projected.document).toBe(document);expect(projected.contentHtml).toBe('');expect(projected.importHtml).toBeUndefined();expect(original.contentHtml).not.toBe('');
 expect(readerPresentation({...original,document:undefined}).contentHtml).toBe(original.contentHtml);
});
it('streams the same semantic text and stops before reading a long tail',()=>{
 expect([...articleTextChunks(document)].join('').trim()).toBe(articleDocumentText(document));
 const first='a'.repeat(1000000);let visited=false;
 const long={...document,children:[{type:'text' as const,id:'first',text:first},{type:'text' as const,id:'tail',get text(){visited=true;return 'tail';}}]};
 expect(collectAiArticleText(articleTextChunks(long)).length).toBeLessThan(first.length);expect(visited).toBe(false);
});
