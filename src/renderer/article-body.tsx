import {useEffect,useImperativeHandle,useMemo,useRef,type HTMLAttributes,type Ref} from 'react';
import {articleDocumentHtml,type ArticleDocument} from '../shared/article-document';
import {renderReaderDiagrams} from './reader-diagrams';
/** Both language versions use this presentation boundary and reader media hooks. */
export function ArticleBody({document,html='',sourceUrl,bodyRef,...props}:{document?:ArticleDocument;html?:string;sourceUrl?:string;bodyRef?:Ref<HTMLDivElement>}&HTMLAttributes<HTMLDivElement>){
 const markup=useMemo(()=>({__html:document?articleDocumentHtml(document,true,sourceUrl):html}),[document,html,sourceUrl]);
 const body=useRef<HTMLDivElement>(null);
 useImperativeHandle(bodyRef,()=>body.current!,[]);
 useEffect(()=>body.current ? renderReaderDiagrams(body.current) : undefined,[markup]);
 return <div {...props} ref={body} className="article-body" dangerouslySetInnerHTML={markup}/>;
}
