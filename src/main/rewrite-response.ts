import {RewriteContentError} from './rewrite-content';
export class RewriteResponseError extends RewriteContentError {
 constructor(readonly category:'json-syntax'|'json-envelope') {
  super(`改写响应${category==='json-envelope'?'封装格式不受支持':'JSON 语法无效'}（${category}），已完成分节仍保留。`);
 }
}
/** Accept a complete JSON payload or one complete outer Markdown fence only.
 * Never extract a brace substring, repair escapes, or discard commentary. */
export function parseRewriteResponse(raw:string):unknown {
 let text=raw.trim();
 if(/^(?:`{3,}|~{3,})/.test(text)){
  const match=/^(`{3,}|~{3,})(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/i.exec(text);
  if(!match)throw new RewriteResponseError('json-envelope');text=match[2].trim();
 }
 try{return JSON.parse(text);}catch{throw new RewriteResponseError('json-syntax');}
}
