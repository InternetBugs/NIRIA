import { mainPlacement, widgetPlacement } from "./window-state.mjs";

export function stableBounds(actual, previous) {
  // A one-DIP native rounding difference must not accumulate across restarts.
  return Object.fromEntries(["x", "y", "width", "height"].map((key) =>
    [key, previous && Math.abs(actual[key] - previous[key]) <= 1 ? previous[key] : actual[key]]));
}
// Native coordinates are Electron's logical pixels, including negative monitor origins.
export class WindowLayout {
  constructor(preferences, screen, changed = () => {}) {
    this.preferences = preferences;
    this.screen = screen;
    this.changed = changed;
    preferences.onWarning = () => { if (!this.stopped) this.changed(); };
    this.stopped = false;
    this.displayChanged = () => {
      clearTimeout(this.displayTimer);
      this.displayTimer = setTimeout(() => this.recover(), 180);
    };
    for (const event of ["display-added", "display-removed", "display-metrics-changed"]) screen.on(event, this.displayChanged);
  }
  areas(cursor = false) {
    const preferred = cursor ? this.screen.getDisplayNearestPoint(this.screen.getCursorScreenPoint()) : this.screen.getPrimaryDisplay();
    return [preferred, ...this.screen.getAllDisplays().filter((display) => display.id !== preferred.id)].map((display) => display.workArea);
  }
  mainOptions() {
    const { bounds, ...limits } = mainPlacement(this.preferences.state.main.bounds, this.areas());
    return { ...bounds, ...limits };
  }
  widgetOptions() {
    const state = this.preferences.state.widget;
    const bounds = widgetPlacement(state.bounds, state.collapsed, this.areas(true));
    return { ...bounds, minWidth: Math.min(92, bounds.width), minHeight: Math.min(92, bounds.height), alwaysOnTop: state.alwaysOnTop };
  }
  attachMain(window) {
    this.main = window;
    const capture = () => this.captureMain();
    for (const event of ["move", "resize", "maximize", "unmaximize"]) window.on(event, capture);
    window.on("restore", () => this.recover());
    if (this.preferences.state.main.maximized) window.maximize();
  }
  captureMain() {
    const window = this.main;
    if (this.stopped || !window || window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    this.preferences.update("main", { bounds: stableBounds(window.getNormalBounds(), this.preferences.state.main.bounds), maximized: window.isMaximized() });
  }
  attachWidget(window) {
    this.widget = window;
    const capture = () => {
      if (!this.stopped && !window.isDestroyed() && !window.isMinimized()) {
        this.preferences.update("widget", { bounds: stableBounds(window.getBounds(), this.preferences.state.widget.bounds) });
      }
    };
    window.on("move", capture);
    window.on("resize", capture);
    window.on("closed", () => { if (this.widget === window) this.widget = null; });
    window.on("close", (event) => {
      if (this.stopped) return;
      event.preventDefault();
      this.hideWidget();
    });
  }
  showMain() {
    if (!this.main || this.main.isDestroyed()) return;
    if (this.main.isMinimized()) this.main.restore();
    this.main.show();
    this.main.focus();
  }
  state() {
    const { collapsed, visible, alwaysOnTop } = this.preferences.state.widget;
    return { collapsed, visible, alwaysOnTop, warning: this.preferences.warning };
  }
  shownWidget() {
    this.preferences.update("widget", { visible: true });
    this.changed();
  }
  hideWidget() {
    this.widget?.hide();
    this.preferences.update("widget", { visible: false });
    this.changed();
  }
  collapseWidget() {
    if (!this.widget || this.widget.isDestroyed()) return this.preferences.state.widget.collapsed;
    const collapsed = !this.preferences.state.widget.collapsed;
    const bounds = widgetPlacement(this.widget.getBounds(), collapsed, this.areas(), { anchor: true });
    this.widget.setMinimumSize(Math.min(92, bounds.width), Math.min(92, bounds.height));
    this.widget.setBounds(bounds);
    this.preferences.update("widget", { collapsed, bounds: this.widget.getBounds() });
    this.changed();
    return collapsed;
  }
  toggleTopmost() {
    const alwaysOnTop = !this.preferences.state.widget.alwaysOnTop;
    this.widget?.setAlwaysOnTop(alwaysOnTop);
    this.preferences.update("widget", { alwaysOnTop });
    this.changed();
    return this.state();
  }
  findWidget() {
    if (!this.widget || this.widget.isDestroyed()) return;
    this.widget.setBounds(widgetPlacement(null, this.preferences.state.widget.collapsed, [this.areas(true)[0]], { find: true }));
    this.preferences.update("widget", { bounds: this.widget.getBounds() });
  }
  recover() {
    if (this.stopped) return;
    const main = this.main;
    if (main && !main.isDestroyed() && !main.isMinimized()) {
      const placement = mainPlacement(main.getNormalBounds(), this.areas());
      const maximized = main.isMaximized();
      if (maximized) main.unmaximize();
      main.setMinimumSize(placement.minWidth, placement.minHeight);
      main.setBounds(placement.bounds);
      if (maximized) main.maximize();
      this.captureMain();
    }
    if (this.widget && !this.widget.isDestroyed()) {
      const bounds = widgetPlacement(this.widget.getBounds(), this.preferences.state.widget.collapsed, this.areas());
      this.widget.setMinimumSize(Math.min(92, bounds.width), Math.min(92, bounds.height));
      this.widget.setBounds(bounds);
      this.preferences.update("widget", { bounds: this.widget.getBounds() });
    }
  }
  stop() {
    this.captureMain();
    this.stopped = true;
    clearTimeout(this.displayTimer);
    for (const event of ["display-added", "display-removed", "display-metrics-changed"]) this.screen.removeListener(event, this.displayChanged);
    this.preferences.flush();
  }
}
