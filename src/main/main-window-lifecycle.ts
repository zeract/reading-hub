/**
 * The small subset of BrowserWindow used to decide whether Reading Hub may
 * take foreground focus. Keeping it independent of Electron makes the
 * user-intent boundary executable in unit tests.
 */
export interface MainWindowHandle {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  isVisible(): boolean;
  restore(): void;
  show(): void;
  showInactive(): void;
  focus(): void;
}

/**
 * Separates automatic startup/restart presentation from explicit user intent.
 * macOS can finish service startup several seconds after a user has moved to
 * another Space; that delayed work must never call `focus()` and pull them
 * back. Tray/menu/second-instance actions are explicit requests and retain
 * normal foreground behaviour.
 */
export class MainWindowLifecycle<Window extends MainWindowHandle> {
  private window?: Window;

  constructor(private readonly createWindow: () => Window) {}

  presentOnStartup(): Window {
    const window = this.getOrCreate();
    window.showInactive();
    return window;
  }

  presentForUser(): Window {
    const window = this.getOrCreate();
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }

  /**
   * App activation may be emitted while macOS is processing a background
   * native event. A visible, non-minimised reader needs no action: forcing it
   * to the foreground here would turn that event into an unexpected Space
   * switch. A hidden/minimised window still needs the usual Dock behaviour.
   */
  presentForApplicationActivation(): Window {
    if (this.window && !this.window.isDestroyed() && this.window.isVisible() && !this.window.isMinimized()) return this.window;
    return this.presentForUser();
  }

  private getOrCreate(): Window {
    if (!this.window || this.window.isDestroyed()) this.window = this.createWindow();
    return this.window;
  }
}
