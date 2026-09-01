import { describe, expect, it, vi } from "vitest";
import { MainWindowLifecycle, type MainWindowHandle } from "../src/main/main-window-lifecycle";

class WindowStub implements MainWindowHandle {
  destroyed = false;
  minimized = false;
  visible = false;
  readonly restore = vi.fn(() => { this.minimized = false; });
  readonly show = vi.fn(() => { this.visible = true; });
  readonly showInactive = vi.fn(() => { this.visible = true; });
  readonly focus = vi.fn();

  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  isVisible() { return this.visible; }
}

describe("main window lifecycle", () => {
  it("shows delayed startup without taking foreground focus", () => {
    const window = new WindowStub();
    const lifecycle = new MainWindowLifecycle(() => window);

    lifecycle.presentOnStartup();

    expect(window.showInactive).toHaveBeenCalledTimes(1);
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it("restores, shows and focuses a window for an explicit user action", () => {
    const window = new WindowStub();
    window.minimized = true;
    const lifecycle = new MainWindowLifecycle(() => window);

    lifecycle.presentForUser();

    expect(window.restore).toHaveBeenCalledTimes(1);
    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });

  it("does not re-focus a visible window for a non-user activation event", () => {
    const window = new WindowStub();
    window.visible = true;
    const lifecycle = new MainWindowLifecycle(() => window);
    lifecycle.presentOnStartup();
    window.showInactive.mockClear();

    lifecycle.presentForApplicationActivation();

    expect(window.showInactive).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });

  it("recovers a hidden window when the application is explicitly activated", () => {
    const window = new WindowStub();
    const lifecycle = new MainWindowLifecycle(() => window);
    lifecycle.presentOnStartup();
    window.visible = false;
    window.showInactive.mockClear();

    lifecycle.presentForApplicationActivation();

    expect(window.show).toHaveBeenCalledTimes(1);
    expect(window.focus).toHaveBeenCalledTimes(1);
  });
});
