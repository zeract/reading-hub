/**
 * The small subset of BrowserWindow used to decide whether Reading Hub may
 * take foreground focus. Keeping it independent of Electron makes the
 * user-intent boundary executable in unit tests.
 */
export interface MainWindowHandle {
  isDestroyed(): boolean;
  isMinimized(): boolean;
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
  private hiddenByUser = false;
  private userRequestedForeground = false;

  constructor(private readonly createWindow: () => Window) {}

  presentOnStartup(): Window {
    const window = this.getOrCreate();
    // A second-instance or tray action can race startup. Never downgrade an
    // explicit foreground request into an inactive presentation.
    if (this.userRequestedForeground) return window;
    this.hiddenByUser = false;
    window.showInactive();
    return window;
  }

  presentForUser(): Window {
    const window = this.getOrCreate();
    this.hiddenByUser = false;
    this.userRequestedForeground = true;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }

  /** Records an explicit window close/hide so a later Dock activation may restore it. */
  markHiddenByUser(window: Window): void {
    if (this.window === window && !window.isDestroyed()) this.hiddenByUser = true;
  }

  /**
   * `isVisible()` means "visible in the foreground", not "the app has no
   * window". In particular, a window on another macOS Space can report false
   * after the user switches away. Keep a startup-presented window untouched
   * until it was explicitly hidden/minimised by the user; otherwise a delayed
   * native `activate` event would turn into an unexpected Space switch.
   */
  presentForApplicationActivation(): Window {
    if (this.window && !this.window.isDestroyed() && !this.hiddenByUser && !this.window.isMinimized()) return this.window;
    return this.presentForUser();
  }

  private getOrCreate(): Window {
    if (!this.window || this.window.isDestroyed()) this.window = this.createWindow();
    return this.window;
  }
}
