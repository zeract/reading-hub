import { afterEach, beforeEach } from "vitest";

/** jsdom lacks dialog methods. Only model open/close here; focus and native
 * modality are verified by the Electron renderer smoke test. */
export function stubDialogPlatform() {
  beforeEach(() => {
    Object.defineProperties(HTMLDialogElement.prototype, {
      showModal: { configurable: true, value(this: HTMLDialogElement) { this.open = true; } },
      close: { configurable: true, value(this: HTMLDialogElement) { this.open = false; } }
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  });
}
