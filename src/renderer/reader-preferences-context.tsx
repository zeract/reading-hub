import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { adjustReaderFontScale, loadReaderPreferences, saveReaderPreferences, type ReaderPreferences, type ReaderPreset } from "./reader-preferences";

function usePreferencesController() {
  const [preferences, setPreferences] = useState(loadReaderPreferences);
  const current = useRef(preferences);
  const [saveFailed, setSaveFailed] = useState(false);
  const retrySave = useCallback(() => {
    try { saveReaderPreferences(current.current); setSaveFailed(false); }
    catch { setSaveFailed(true); }
  }, []);
  const update = useCallback((change: (value: ReaderPreferences) => ReaderPreferences) => {
    const next = change(current.current);
    if (next.preset === current.current.preset && next.fontScale === current.current.fontScale) return;
    // Current-session state is authoritative even when persistence is unavailable.
    // Update synchronously so successive controls never lose an earlier change.
    current.current = next;
    setPreferences(next);
    retrySave();
  }, [retrySave]);
  const setPreset = useCallback((preset: ReaderPreset) => update((value) => ({ ...value, preset })), [update]);
  const adjustFont = useCallback((amount: number) => update((value) => ({ ...value, fontScale: adjustReaderFontScale(value.fontScale, amount) })), [update]);
  return { preferences, setPreset, adjustFont, saveFailed, retrySave };
}

const PreferencesContext = createContext<ReturnType<typeof usePreferencesController> | undefined>(undefined);

/** One owner survives navigation between settings and reading. Merely mounting
 * either surface never rewrites storage; only user changes and retries save. */
export function ReaderPreferencesProvider({ children }: { children: ReactNode }) {
  const value = usePreferencesController();
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function useReaderPreferences() {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("Reading preferences require their application provider.");
  return value;
}

export function ReaderPreferenceStatus() {
  const { saveFailed, retrySave } = useReaderPreferences();
  return saveFailed ? <div className="reader-preference-status">
    <p role="status">排版已生效，但尚未保存到本机。</p>
    <button type="button" className="action-button" onClick={retrySave}>重试保存</button>
  </div> : null;
}
