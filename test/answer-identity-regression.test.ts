import { expect, it } from 'vitest';
import { extractReaderArticle } from '../src/main/article-reader';
import { extractGenericPage } from '../src/main/extractor';
import { extractZhihuFollowPage } from '../src/main/zhihu-follow-parser';
import { assertAnswerNavigation } from '../src/main/zhihu-answer-identity';
const url='https://www.zhihu.com/question/123/answer/456';
const entry={id:'fixture',sourceId:'fixture',url,canonicalUrl:url,title:'Question',author:'Target author',contentHash:'x',read:false,favorite:false,createdAt:1};
const answer=(id:string,text:string,count=20)=>`<div class="AnswerItem" data-zop='{"type":"answer","itemId":"${id}"}'><h2><a href="https://www.zhihu.com/question/123/answer/${id}">Question</a></h2><div class="AuthorInfo-name">Author ${id}</div><div class="RichContent-inner"><p>${text.repeat(count)}</p></div></div>`;
it('binds extraction to the requested answer instead of larger other answers or Readability mixtures',()=>{
 const result=extractReaderArticle(answer('999','OTHER ',100)+answer('456','TARGET '),url,entry);
 expect(result?.article.contentHtml).toContain('TARGET');
 expect(result?.article.author).toBe('Author 456');
 expect(result?.article.contentHtml).not.toContain('OTHER');
});
it('rejects a missing answer, a redirect to another answer and a bare question page',()=>{
 expect(()=>extractReaderArticle(answer('999','OTHER '),url,entry)).toThrow('身份');
 expect(()=>assertAnswerNavigation(url,url.replace('/456','/999'))).toThrow('跳转');
 expect(()=>assertAnswerNavigation(url,'https://www.zhihu.com/question/123')).toThrow('跳转');
});
it('does not mix nested recommendations into a proven answer',()=>{
 const html=answer('456','TARGET ').replace('</p>','</p>'+answer('999','OTHER ',100));
 expect(extractReaderArticle(html,url,entry)?.article.contentHtml).not.toContain('OTHER');
});
it('rejects conflicting answer identities despite a matching document canonical',()=>{
 const html=`<link rel="canonical" href="${url}"><div class="QuestionAnswer-content"><div data-answer-id="999"><div class="RichContent-inner">${'OTHER '.repeat(100)}</div></div></div>`;
 expect(()=>extractReaderArticle(html,url,entry)).toThrow('身份');
});
it('pairs follow-feed metadata with its own answer and ignores quoted links',()=>{
 const html=`<div class="TopstoryItem">${answer('456','TARGET ')}${answer('999','OTHER ')}</div>`;
 const entries=extractZhihuFollowPage(html);
 expect(entries).toHaveLength(2);
 expect(entries.find(e=>e.url===url)).toMatchObject({author:'Author 456',summary:expect.stringContaining('TARGET')});
 const quoted=answer('456','TARGET ').replace('</p>','<a href="https://www.zhihu.com/question/123/answer/999">A long quoted answer reference</a></p>');
 expect(extractZhihuFollowPage(quoted)[0]?.url).toBe(url);
 const nested=answer('456','TARGET ').replace('</p>','</p>'+answer('999','OTHER ',100));
 expect(extractZhihuFollowPage(nested)).toHaveLength(1);
 expect(extractZhihuFollowPage(nested)[0]?.summary).not.toContain('OTHER');
});
it.each(['<time datetime="2026-09-09">2026年9月9日</time>','<span>2026年9月9日</span>'])('separates date metadata from a whole-card title: %s',date=>{
 const result=extractGenericPage(`<ul><li><a href="/post">${date}<span>Research title</span></a></li></ul>`,'https://example.com/',{version:1,selection:'manual',itemRootSelector:'li'});
 expect(result.entries[0]?.title).toBe('Research title');
});
it('preserves dates that are genuinely part of the authored title',()=>{
 const result=extractGenericPage('<li><a href="/post"><h2>2026年9月9日发布了什么</h2></a></li>','https://example.com/',{version:1,selection:'manual',itemRootSelector:'li'});
 expect(result.entries[0]?.title).toBe('2026年9月9日发布了什么');
});
it('retains title text nested inside a span that also contains a date',()=>{
 const result=extractGenericPage('<li><a href="/post"><span>2026年9月9日<strong>发布了什么</strong></span></a></li>','https://example.com/',{version:1,selection:'manual',itemRootSelector:'li'});
 expect(result.entries[0]?.title).toBe('2026年9月9日发布了什么');
});
