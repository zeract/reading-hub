import type {CheerioAPI} from 'cheerio';
/** Consume explicit presentation evidence before CSS is discarded. Never infer
 * code from punctuation, and never carry the remote style into the reader. */
export function normalizePreformattedCode($:CheerioAPI):void {
 $('div[style]').each((_i,node)=>{
  const el=$(node),style=el.attr('style')||'';
  if(el.parents('pre,code').length || el.find('pre,code,img,video,table,p,div').length)return;
  if(!/(?:^|;)\s*white-space\s*:\s*pre(?:-wrap)?\s*(?:!important\s*)?(?:;|$)/i.test(style)
   || !/(?:^|;)\s*font-family\s*:[^;]*\bmonospace\b/i.test(style))return;
  el.find('br').replaceWith('\n');
  el.replaceWith($('<pre>').append($('<code>').text(el.text())));
 });
}
