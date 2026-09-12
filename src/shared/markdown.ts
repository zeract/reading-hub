import MarkdownIt from "markdown-it";
import { mathAt } from "./markdown-math";

/** One CommonMark/GFM grammar for segmentation, structural validation and safe React rendering. */
export function createReaderMarkdown() {
  const parser=new MarkdownIt({html:false,linkify:true});
  parser.inline.ruler.before("escape","reader_math",(state,silent)=>{
    const match=mathAt(state.src,state.pos);
    if(!match || match.end>state.posMax)return false;
    if(!silent){const token=state.push("reader_math","",0);token.content=restoreMathPipe(match.tex,state.env);token.meta={displayMode:match.displayMode};}
    if(Array.isArray(state.env.mathRanges))state.env.mathRanges.push([state.pos,match.end]);
    state.pos=match.end;return true;
  });
  parser.block.ruler.before("fence","reader_math_block",(state,start,end,silent)=>{
    if(state.sCount[start]-state.blkIndent>=4)return false;
    const source=state.getLines(start,end,state.blkIndent,false), offset=source.search(/\S/);
    if(offset<0)return false;
    const match=mathAt(source,offset);
    if(!match?.displayMode || source.slice(match.end).split("\n",1)[0].trim())return false;
    if(silent)return true;
    const lines=source.slice(0,match.end).split("\n").length;
    const token=state.push("reader_math_block","",0);token.content=restoreMathPipe(match.tex,state.env);token.block=true;token.map=[start,start+lines];
    state.line=start+lines;return true;
  },{alt:["paragraph","reference","blockquote","list"]});
  // GFM splits table cells before parsing inline math. Shield math-internal pipes while
  // keeping source offsets/line maps stable; ordinary escaped pipes use the normal grammar.
  parser.core.ruler.before("block","reader_math_pipes",state=>{
    if(state.inlineMode || !state.src.includes("|"))return;
    const preliminary:ReturnType<typeof parser.parse>=[];
    parser.block.parse(state.src,parser,{},preliminary);
    const literal=new Set<number>();
    for(const token of preliminary)if((token.type==="fence" || token.type==="code_block") && token.map)for(let line=token.map[0];line<token.map[1];line++)literal.add(line);
    let pipe=0xe000;while(state.src.includes(String.fromCharCode(pipe)) && pipe<0xf8ff)pipe++;
    if(state.src.includes(String.fromCharCode(pipe)))return;
    const pipeChar=String.fromCharCode(pipe);state.env.mathPipe=pipeChar;
    state.src=state.src.split("\n").map((line,index)=>{
      if(literal.has(index) || !line.includes("|"))return line;
      const env={mathRanges:[] as number[][]};parser.parseInline(line,env);
      for(const [start,end] of env.mathRanges.reverse())line=line.slice(0,start)+line.slice(start,end).replace(/\|/g,pipeChar)+line.slice(end);
      return line;
    }).join("\n");
  });
  return parser;
}

function restoreMathPipe(tex:string,env:Record<string,unknown>):string {return typeof env.mathPipe==="string"?tex.split(env.mathPipe).join("|"):tex;}
