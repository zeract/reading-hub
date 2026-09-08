import { useEffect, useState } from "react";

/** The startup read fills the initial state only until a live event arrives.
 * Each effect owns its subscription and snapshot, including StrictMode replay.
 */
export function useWindowFullscreen() {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    const unsubscribe = window.reader.onWindowFullscreenChange((value) => {
      if (!active) return;
      receivedEvent = true;
      setFullscreen(value);
    });
    void (async () => {
      try {
        const value = await window.reader.isWindowFullscreen();
        if (active && !receivedEvent) setFullscreen(value);
      } catch {
        // Keep the last known state; native events can still recover it.
      }
    })();
    return () => { active = false; unsubscribe(); };
  }, []);
  return fullscreen;
}
