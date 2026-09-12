import {useMemo,type HTMLAttributes,type Ref} from 'react';
import {articleDocumentHtml,type ArticleDocument} from '../shared/article-document';
/** Both language versions use this presentation boundary and reader media hooks. */
export function ArticleBody({document,html='',bodyRef,...props}:{document?:ArticleDocument;html?:string;bodyRef?:Ref<HTMLDivElement>}&HTMLAttributes<HTMLDivElement>){
 const markup=useMemo(()=>({__html:document?articleDocumentHtml(document):html}),[document,html]);
 return <div {...props} ref={bodyRef} className="article-body" dangerouslySetInnerHTML={markup}/>;
}
