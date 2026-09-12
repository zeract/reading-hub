import type {CheerioAPI} from 'cheerio';
/** Convert declared two-column label/value grids, not arbitrary page layouts.
 * Read only local declarations as evidence; never execute or retain origin CSS. */
export function normalizeKeyValueGrids($:CheerioAPI):void {
 const twoColumns=(style:string)=>/(?:^|;)\s*display\s*:\s*(?:inline-)?grid\s*(?:;|$)/i.test(style)&&/(?:^|;)\s*grid-template-columns\s*:\s*(?:[\d.]+(?:px|em|rem|%|fr|ch)|auto)\s+(?:[\d.]+(?:px|em|rem|%|fr|ch)|auto)\s*(?:;|$)/i.test(style);
 const selectors:string[]=[];
 $('style').each((_i,e)=>{const css=$(e).text();if(css.length>100000)return;for(const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g))if(twoColumns(match[2]))for(const selector of match[1].split(',')){const s=selector.trim();if(s.length<300&&!s.includes('@'))selectors.push(s);}});
 const declared=(row:any)=>twoColumns($(row).attr('style')||'')||selectors.some(s=>{try{return $(row).is(s);}catch{return false;}});
 $('div').each((_i,node)=>{
  const container=$(node),rows=container.children();if(rows.length<2||rows.length>100||container.contents().toArray().some(n=>n.type==='text'&&n.data.trim()))return;
  if(!rows.toArray().every(row=>{
   const el=$(row),cells=el.children();return el.is('div')&&declared(row)&&cells.length===2&&cells.first().is('b,strong')&&Boolean(cells.first().text().trim())&&cells.last().is('div,p')&&!el.find('input,button,select,textarea,form,nav').length&&!el.contents().toArray().some(n=>n.type==='text'&&n.data.trim());
  }))return;
  const table=$('<table>'),body=$('<tbody>');rows.each((_j,row)=>{const cells=$(row).children();body.append($('<tr>').append($('<th>').append(cells.first().contents()),$('<td>').append(cells.last().contents())));});container.replaceWith(table.append(body));
 });
}
