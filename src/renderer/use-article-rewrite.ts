import { useCallback, useEffect, useRef, useState } from "react";
import { rewritePending, type ArticleRewrite } from "../shared/rewrite";
import { errorMessage } from "./errors";

function metadata(record: ArticleRewrite | undefined): ArticleRewrite | undefined {
    if (!record) return;
    const { result, ...rest } = record;
    return { ...rest, hasResult: record.hasResult ?? Boolean(result) };
}
/** Hidden versions retain status only. Derived text remains durable in SQLite. */
export function useArticleRewrite(entryId: string) {
    const [record, setRecord] = useState<ArticleRewrite>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [visible, updateVisible] = useState(false);
    const wantsResult = useRef(false);
    const generation = useRef(0);
    const epoch = useRef(0);
    const actionLock = useRef(false);
    const readLock = useRef(false);
    const read = useCallback(async (metadataOnly = !wantsResult.current) => {
        if (actionLock.current || readLock.current) return;
        readLock.current = true;
        const current = ++epoch.current;
        try {
            let result = metadataOnly ? await window.reader.getArticleRewrite(entryId, true) : await window.reader.getArticleRewrite(entryId);
            if (metadataOnly && current === epoch.current && wantsResult.current && result && !rewritePending(result)) {
                result = await window.reader.getArticleRewrite(entryId);
                metadataOnly = false;
            }
            if (current === epoch.current) {
                setRecord(previous => !wantsResult.current ? metadata(result)
                    : metadataOnly && result && rewritePending(result) && previous?.entryId === result.entryId
                        ? { ...result, result: previous.result } : result);
                setError(undefined);
                setLoaded(!wantsResult.current || !metadataOnly || !(result?.hasResult ?? result?.result));
            }
        } catch (reason) {
            if (current === epoch.current) setError(errorMessage(reason));
        } finally {
            if (current === epoch.current) readLock.current = false;
        }
    }, [entryId]);
    useEffect(() => {
        generation.current++;
        wantsResult.current = false;
        setRecord(undefined); setError(undefined); updateVisible(false); setLoaded(false); setBusy(false);
        actionLock.current = false; readLock.current = false;
        void read(true);
        return () => { generation.current++; epoch.current++; };
    }, [read]);
    const pending = rewritePending(record);
    useEffect(() => {
        if (!pending) return;
        const timer = setInterval(() => void read(true), 2000);
        return () => clearInterval(timer);
    }, [pending, read]);
    const setVisible = useCallback((next: boolean) => {
        if (next === wantsResult.current) return;
        wantsResult.current = next;
        epoch.current++; readLock.current = false;
        updateVisible(next); setError(undefined); setLoaded(!next);
        if (!next) setRecord(previous => metadata(previous));
        void read(!next);
    }, [read]);
    const act = async (action: "generate" | "cancel") => {
        if (actionLock.current) return;
        actionLock.current = true; readLock.current = false; epoch.current++;
        const current = generation.current;
        setBusy(true); setError(undefined);
        try {
            const result = action === "generate" ? await window.reader.generateArticleRewrite(entryId) : await window.reader.cancelArticleRewrite(entryId);
            if (current === generation.current) {
                setRecord(wantsResult.current ? result || undefined : metadata(result || undefined));
                setLoaded(true);
            }
        } catch (reason) {
            if (current === generation.current) setError(errorMessage(reason));
        } finally {
            if (current === generation.current) { actionLock.current = false; setBusy(false); }
        }
    };
    return { record: record?.entryId === entryId ? record : undefined, error, busy, loaded, pending, visible, setVisible, act, reload: read };
}
