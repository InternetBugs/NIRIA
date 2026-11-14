import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WindowLayout } from "../desktop/window-layout.mjs";
import { normalizePreferences } from "../desktop/window-state.mjs";

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary = { x: -1600, y: -200, width: 1600, height: 860 };
const mainBounds = { x: 30, y: 35, width: 1000, height: 760 };
const widgetBounds = { x: 1400, y: 400, width: 280, height: 430 };
const inside = (bounds, area) => bounds.x >= area.x && bounds.y >= area.y &&
  bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height;

// Synchronous native events deliberately exercise reentry and intermediate saves.
class NativeWindow extends EventEmitter {
  constructor(bounds, { maximized = false, minimized = false, fullScreen = false, visible = true, topmost = false } = {}) {
    super();
    Object.assign(this, { bounds: { ...bounds }, maximized, minimized, fullScreen, visible, topmost });
    this.minimum = [780, 700];
    this.mutations = [];
    this.destroyed = false;
  }
  getBounds() { return { ...this.bounds }; }
  getNormalBounds() { return this.getBounds(); }
  getMinimumSize() { return [...this.minimum]; }
  isDestroyed() { return this.destroyed; }
  isMinimized() { return this.minimized; }
  isMaximized() { return this.maximized; }
  isFullScreen() { return this.fullScreen; }
  setMinimumSize(width, height) { this.minimum = [width, height]; this.mutations.push("minimum"); }
  setBounds(bounds) {
    this.mutations.push("bounds");
    this.bounds = { ...bounds };
    this.emit("move");
    this.emit("resize");
  }
  unmaximize() {
    this.maximized = false;
    this.mutations.push("unmaximize");
    this.emit("unmaximize");
    this.emit("restore");
  }
  maximize() { this.maximized = true; this.mutations.push("maximize"); this.emit("maximize"); }
  restore() { this.minimized = false; this.mutations.push("restore"); this.emit("restore"); }
  show() { this.visible = true; this.mutations.push("show"); }
  hide() { this.visible = false; this.mutations.push("hide"); }
  focus() { this.mutations.push("focus"); }
  setAlwaysOnTop(value) { this.topmost = value; this.mutations.push("topmost"); }
}

function fixture(t, { main = {}, widget = {}, areas = [primary] } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const preferences = {
    state: normalizePreferences({ version: 1,
      main: { bounds: main.bounds || mainBounds, maximized: !!main.maximized },
      widget: { bounds: widget.bounds || widgetBounds, visible: widget.visible ?? true,
        collapsed: !!widget.collapsed, alwaysOnTop: widget.topmost ?? true }
    }),
    updates: [],
    update(section, patch) {
      this.updates.push({ section, patch: structuredClone(patch) });
      Object.assign(this.state[section], structuredClone(patch));
    },
    flush() { return true; }
  };
  const screen = new EventEmitter(), power = new EventEmitter();
  screen.displays = areas.map((workArea, id) => ({ id, workArea }));
  screen.getPrimaryDisplay = () => screen.displays[0];
  screen.getAllDisplays = () => screen.displays;
  screen.getCursorScreenPoint = () => ({ x: 10, y: 10 });
  screen.getDisplayNearestPoint = () => screen.displays[0];
  const layout = new WindowLayout(preferences, screen, () => {}, power);
  const mainWindow = new NativeWindow(preferences.state.main.bounds, main);
  const widgetWindow = new NativeWindow(preferences.state.widget.bounds, { ...widget, topmost: preferences.state.widget.alwaysOnTop });
  widgetWindow.minimum = [92, 92];
  layout.attachMain(mainWindow);
  layout.attachWidget(widgetWindow);
  mainWindow.mutations = [];
  widgetWindow.mutations = [];
  preferences.updates = [];
  t.after(() => layout.stop());
  return { layout, preferences, screen, power, main: mainWindow, widget: widgetWindow };
}

test("unchanged display metrics leave a maximized window and native bounds untouched", (t) => {
  const { screen, main, widget } = fixture(t, { main: { maximized: true } });
  for (let index = 0; index < 4; index++) screen.emit("display-metrics-changed");
  t.mock.timers.tick(180);
  assert.deepEqual(main.mutations, []);
  assert.deepEqual(widget.mutations, []);
  assert.equal(main.isMaximized(), true);
});

test("resume recovers hidden collapsed windows from a disconnected display without revealing them", (t) => {
  const bounds = { x: -1500, y: -150, width: 92, height: 92 };
  const { power, main, widget, preferences } = fixture(t, {
    main: { bounds: { x: -1500, y: -150, width: 1000, height: 760 } },
    widget: { bounds, visible: false, collapsed: true, topmost: false }
  });
  power.emit("resume");
  t.mock.timers.tick(180);
  assert.ok(inside(main.getNormalBounds(), primary));
  assert.ok(inside(widget.getBounds(), primary));
  assert.equal(widget.getBounds().width, 92);
  assert.equal(widget.getBounds().height, 92);
  assert.equal(widget.visible, false);
  assert.equal(widget.topmost, false);
  assert.equal(preferences.state.widget.visible, false);
  assert.equal(preferences.state.widget.collapsed, true);
  assert.ok(![...main.mutations, ...widget.mutations].some((operation) => ["show", "focus", "topmost"].includes(operation)));
});

test("display removal repositions a maximized window once and never saves temporary unmaximized state", (t) => {
  const { screen, main, preferences } = fixture(t, {
    areas: [primary, secondary],
    main: { bounds: { x: -1500, y: -150, width: 1000, height: 760 }, maximized: true }
  });
  screen.displays = screen.displays.slice(0, 1);
  screen.emit("display-removed");
  t.mock.timers.tick(180);
  assert.ok(inside(main.getNormalBounds(), primary));
  assert.equal(main.isMaximized(), true);
  assert.equal(main.mutations.filter((operation) => operation === "bounds").length, 1);
  const savedMain = preferences.updates.filter((update) => update.section === "main");
  assert.equal(savedMain.length, 1);
  assert.equal(savedMain[0].patch.maximized, true);
  assert.deepEqual(preferences.state.main.bounds, main.getNormalBounds());
});

test("fullscreen is left alone during recovery and corrected after leaving fullscreen", (t) => {
  const { power, main } = fixture(t, {
    main: { bounds: { x: -1500, y: -150, width: 1000, height: 760 }, fullScreen: true }
  });
  power.emit("resume");
  t.mock.timers.tick(180);
  assert.deepEqual(main.mutations, []);
  main.fullScreen = false;
  main.emit("leave-full-screen");
  t.mock.timers.tick(180);
  assert.ok(inside(main.getNormalBounds(), primary));
});

test("resume preserves minimization and a later explicit restore corrects the old placement", (t) => {
  const { power, main } = fixture(t, {
    main: { bounds: { x: -1500, y: -150, width: 1000, height: 760 }, minimized: true }
  });
  power.emit("resume");
  t.mock.timers.tick(180);
  assert.equal(main.isMinimized(), true);
  assert.deepEqual(main.mutations, []);
  main.restore();
  assert.ok(inside(main.getNormalBounds(), primary));
  assert.ok(!main.mutations.some((operation) => ["show", "focus"].includes(operation)));
});

test("a smaller work area updates minimum sizes and preserves maximization", (t) => {
  const small = { x: 45, y: 80, width: 600, height: 480 };
  const { screen, main } = fixture(t, { main: { maximized: true } });
  screen.displays[0].workArea = small;
  screen.emit("display-metrics-changed");
  t.mock.timers.tick(180);
  assert.deepEqual(main.getBounds(), small);
  assert.deepEqual(main.getMinimumSize(), [600, 480]);
  assert.equal(main.isMaximized(), true);
});

test("fractional DPI rounding does not repeatedly reposition an otherwise valid window", (t) => {
  const { power, main, widget } = fixture(t);
  main.bounds.height = primary.height + 1;
  main.bounds.y = primary.y;
  widget.bounds.width++;
  power.emit("resume");
  t.mock.timers.tick(180);
  assert.deepEqual(main.mutations, []);
  assert.deepEqual(widget.mutations, []);
});

test("shutdown removes resume/display listeners and cancels pending recovery", (t) => {
  const { layout, screen, power, main, widget } = fixture(t);
  power.emit("resume");
  screen.emit("display-removed");
  layout.stop();
  t.mock.timers.tick(180);
  power.emit("resume");
  screen.emit("display-metrics-changed");
  t.mock.timers.tick(180);
  assert.equal(power.listenerCount("resume"), 0);
  for (const event of ["display-added", "display-removed", "display-metrics-changed"]) assert.equal(screen.listenerCount(event), 0);
  assert.deepEqual(main.mutations, []);
  assert.deepEqual(widget.mutations, []);
});
