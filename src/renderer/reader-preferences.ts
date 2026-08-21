export type ReaderPreset = "reading" | "compact";

export type ReaderPreferences = {
  preset: ReaderPreset;
  fontScale: number;
};

export const READER_PREFERENCES_KEY = "reading-hub.reader-preferences.v1";
export const DEFAULT_READER_PREFERENCES: ReaderPreferences = { preset: "reading", fontScale: 1 };

export function loadReaderPreferences(): ReaderPreferences {
  try {
    const stored = JSON.parse(window.localStorage.getItem(READER_PREFERENCES_KEY) || "{}") as Partial<ReaderPreferences>;
    const preset: ReaderPreset = stored.preset === "compact" ? "compact" : "reading";
    const fontScale = typeof stored.fontScale === "number" && stored.fontScale >= 0.85 && stored.fontScale <= 1.25
      ? stored.fontScale
      : DEFAULT_READER_PREFERENCES.fontScale;
    return { preset, fontScale };
  } catch {
    return DEFAULT_READER_PREFERENCES;
  }
}

export function saveReaderPreferences(preferences: ReaderPreferences): void {
  window.localStorage.setItem(READER_PREFERENCES_KEY, JSON.stringify(preferences));
}

export function adjustReaderFontScale(current: number, amount: number): number {
  return Math.min(1.25, Math.max(0.85, Number((current + amount).toFixed(2))));
}
