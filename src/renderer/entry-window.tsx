import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
/** Variable-height rows with a bounded DOM. Keep boundary/focus neighbours
 * mounted so native Tab and Shift+Tab traverse logical rows without skipping. */
export function entryWindowRange(range: Range, focused: number | undefined): number[] {
    const indices = new Set(defaultRangeExtractor(range));
    for (const index of [0, range.count - 1, ...(focused === undefined ? [] : [focused - 1, focused, focused + 1])]) {
        if (index >= 0 && index < range.count)
            indices.add(index);
    }
    return [...indices].sort((a, b) => a - b);
}
// The virtualizer owns anchor correction and measurement/read-back ordering.
// An index/identity target remains live across estimate -> measured changes;
// one absolute scrollToOffset command does not.
export const entryWindowScrollPolicy = { anchorTo: 'end' as const, followOnAppend: false as const, scrollEndThreshold: 0 };
export function EntryWindow({ ids, scrollRef, render }: {
    ids: string[];
    scrollRef: RefObject<HTMLElement | null>;
    render: (index: number) => ReactNode;
}) {
    const root = useRef<HTMLDivElement>(null);
    const [margin, setMargin] = useState(0);
    const [, mounted] = useState(false);
    // Parent host refs attach after child layout effects on the initial commit.
    useLayoutEffect(() => mounted(true), []);
    const [focusedId, setFocusedId] = useState<string>();
    const focused = focusedId === undefined ? undefined : ids.indexOf(focusedId);
    const enabled = ids.length > 40;
    const previousIds = useRef(ids);
    const anchor = useRef<{
        id: string;
        offset: number;
    } | undefined>(undefined);
    const restore = useRef<{
        id: string;
        offset: number;
    } | undefined>(undefined);
    const padding = useRef(0);
    if (previousIds.current !== ids) {
        const before = previousIds.current, saved = anchor.current;
        // Native anchoring covers edge changes. An internal reorder with the
        // same count/edge keys needs the same identity target explicitly.
        if (saved && before.length === ids.length && before[0] === ids[0] && before.at(-1) === ids.at(-1) && before.indexOf(saved.id) !== ids.indexOf(saved.id)) {
            restore.current = saved;
            padding.current = -Math.max(0, saved.offset);
        }
        previousIds.current = ids;
    }
    const getItemKey = useCallback((index: number) => ids[index], [ids]);
    const rangeExtractor = useCallback((range: Range) => entryWindowRange(range, focused), [focused]);
    const virtualizer = useVirtualizer({
        count: ids.length, getScrollElement: () => scrollRef.current, estimateSize: () => 190,
        getItemKey, rangeExtractor, overscan: 6, enabled, scrollMargin: margin, useFlushSync: false,
        ...entryWindowScrollPolicy, scrollPaddingStart: padding.current,
        onChange: instance => {
            if (restore.current)
                return;
            const offset = instance.scrollOffset ?? 0, first = instance.getVirtualItems().find(item => item.end > offset);
            if (first)
                anchor.current = { id: ids[first.index], offset: offset - first.start };
        }
    });
    useLayoutEffect(() => {
        const saved = restore.current;
        restore.current = undefined;
        if (!saved || !enabled)
            return;
        const index = ids.indexOf(saved.id);
        // Keep an index command live until measurement/read-back reconciles;
        // scrollPaddingStart preserves the saved offset inside the anchor row.
        if (index >= 0)
            virtualizer.scrollToIndex(index, { align: 'start' });
    }, [ids, enabled, virtualizer]);
    useLayoutEffect(() => {
        const scroll = scrollRef.current, element = root.current;
        if (!scroll || !element)
            return;
        const top = element.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
        if (Math.abs(top - margin) > .5)
            setMargin(top);
    });
    const rows = enabled ? virtualizer.getVirtualItems() : ids.map((id, index) => ({ key: id, index, start: 0 }));
    return <div ref={root} className="entry-window" role="list" aria-label="文章条目" style={enabled ? { height: virtualizer.getTotalSize() } : undefined} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget))
        setFocusedId(undefined); }}>
    {rows.map(row => <div key={row.key} data-index={row.index} data-entry-id={ids[row.index]} className={enabled ? 'entry-window-row is-virtual' : 'entry-window-row'} ref={enabled ? virtualizer.measureElement : undefined} role="listitem" aria-posinset={row.index + 1} aria-setsize={ids.length} onFocusCapture={() => setFocusedId(ids[row.index])} style={enabled ? { transform: `translateY(${row.start - margin}px)` } : undefined}>
      {render(row.index)}
    </div>)}
  </div>;
}
