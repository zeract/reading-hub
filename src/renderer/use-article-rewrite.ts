import { useCallback, useEffect, useRef, useState } from "react";
import { rewritePending, type ArticleRewrite } from "../shared/rewrite";
import { errorMessage } from "./errors";
export function useArticleRewrite(entryId: string) {
    const [record, setRecord] = useState<ArticleRewrite>();
    const [error, setError] = useState<string>();
    const [busy, setBusy] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [visible, setVisible] = useState(false);
    const epoch = useRef(0);
    const actionLock = useRef(false);
    const readLock = useRef(false);
    const read = useCallback(async () => {
        if (actionLock.current || readLock.current)
            return;
        readLock.current = true;
        const current = ++epoch.current;
        try {
            const result = await window.reader.getArticleRewrite(entryId);
            if (current === epoch.current) {
                setRecord(result);
                setError(undefined);
                setLoaded(true);
            }
        }
        catch (reason) {
            if (current === epoch.current)
                setError(errorMessage(reason));
        }
        finally {
            if (current === epoch.current)
                readLock.current = false;
        }
    }, [entryId]);
    useEffect(() => { setRecord(undefined); setError(undefined); setVisible(false); setLoaded(false); setBusy(false); actionLock.current = false; readLock.current = false; void read(); return () => { epoch.current++; }; }, [read]);
    const pending = rewritePending(record);
    useEffect(() => { if (!pending)
        return; const timer = setInterval(() => void read(), 2000); return () => clearInterval(timer); }, [pending, read]);
    const act = async (action: "generate" | "cancel") => {
        if (actionLock.current)
            return;
        actionLock.current = true;
        readLock.current = false;
        const current = ++epoch.current;
        setBusy(true);
        setError(undefined);
        try {
            const result = action === "generate" ? await window.reader.generateArticleRewrite(entryId) : await window.reader.cancelArticleRewrite(entryId);
            if (current === epoch.current) {
                setRecord(result || undefined);
                setLoaded(true);
            }
        }
        catch (reason) {
            if (current === epoch.current)
                setError(errorMessage(reason));
        }
        finally {
            if (current === epoch.current) {
                actionLock.current = false;
                setBusy(false);
            }
        }
    };
    return { record: record?.entryId === entryId ? record : undefined, error, busy, loaded, pending, visible, setVisible, act, reload: read };
}
