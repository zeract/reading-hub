import {defaultRangeExtractor,useVirtualizer,type Range} from '@tanstack/react-virtual';
import {useCallback,useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react';

/** Variable-height rows with a bounded DOM. Keep boundary/focus neighbours
 * mounted so native Tab and Shift+Tab traverse logical rows without skipping. */
export function entryWindowRange(range:Range,focused:number|undefined):number[]{
  const indices=new Set(defaultRangeExtractor(range));
  for(const index of [0,range.count-1,...(focused===undefined?[]:[focused-1,focused,focused+1])]){
    if(index>=0&&index<range.count)indices.add(index);
  }
  return [...indices].sort((a,b)=>a-b);
}
export function EntryWindow({ids,scrollRef,render}:{ids:string[];scrollRef:RefObject<HTMLElement|null>;render:(index:number)=>ReactNode}){
  const root=useRef<HTMLDivElement>(null);
  const [margin,setMargin]=useState(0);
  const [,mounted]=useState(false);
  // Parent host refs attach after child layout effects on the initial commit.
  useLayoutEffect(()=>mounted(true),[]);
  const [focusedId,setFocusedId]=useState<string>();
  const focused=focusedId===undefined?undefined:ids.indexOf(focusedId);
  const enabled=ids.length>40;
  const lastIds=useRef(ids);
  const anchor=useRef<{id:string;offset:number}|undefined>(undefined);
  const restore=useRef<typeof anchor.current>(undefined);
  if(lastIds.current!==ids){
    const saved=anchor.current;
    if(saved&&lastIds.current.indexOf(saved.id)!==ids.indexOf(saved.id))restore.current=saved;
    lastIds.current=ids;
  }
  const getItemKey=useCallback((index:number)=>ids[index],[ids]);
  const rangeExtractor=useCallback((range:Range)=>entryWindowRange(range,focused),[focused]);
  const virtualizer=useVirtualizer({
    count:ids.length,getScrollElement:()=>scrollRef.current,estimateSize:()=>190,
    getItemKey,rangeExtractor,overscan:6,enabled,scrollMargin:margin,useFlushSync:false,
    onChange:instance=>{
      if(restore.current)return;
      const offset=instance.scrollOffset??0;
      const first=instance.getVirtualItems().find(item=>item.end>offset);
      if(first)anchor.current={id:ids[first.index],offset:offset-first.start};
    }
  });
  useLayoutEffect(()=>{
    const saved=restore.current;restore.current=undefined;
    if(!saved||!enabled)return;
    const index=ids.indexOf(saved.id);
    const offset=index<0?undefined:virtualizer.getOffsetForIndex(index,'start')?.[0];
    if(offset!==undefined)virtualizer.scrollToOffset(offset+Math.max(0,saved.offset));
  },[ids,enabled,virtualizer]);
  useLayoutEffect(()=>{
    const scroll=scrollRef.current,element=root.current;
    if(!scroll||!element)return;
    const top=element.getBoundingClientRect().top-scroll.getBoundingClientRect().top+scroll.scrollTop;
    if(Math.abs(top-margin)>.5)setMargin(top);
  });
  const rows=enabled?virtualizer.getVirtualItems():ids.map((id,index)=>({key:id,index,start:0}));
  return <div ref={root} className="entry-window" role="list" aria-label="文章条目"
    style={enabled?{height:virtualizer.getTotalSize()}:undefined}
    onBlurCapture={event=>{if(!event.currentTarget.contains(event.relatedTarget))setFocusedId(undefined);}}>
    {rows.map(row=><div key={row.key} data-index={row.index} data-entry-id={ids[row.index]}
      className={enabled?'entry-window-row is-virtual':'entry-window-row'}
      ref={enabled?virtualizer.measureElement:undefined}
      role="listitem" aria-posinset={row.index+1} aria-setsize={ids.length}
      onFocusCapture={()=>setFocusedId(ids[row.index])}
      style={enabled?{transform:`translateY(${row.start-margin}px)`}:undefined}>
      {render(row.index)}
    </div>)}
  </div>;
}
