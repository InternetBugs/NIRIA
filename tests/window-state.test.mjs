import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DesktopPreferences, normalizePreferences, chooseArea, mainPlacement, widgetPlacement } from "../desktop/window-state.mjs";
import { stableBounds } from "../desktop/window-layout.mjs";

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const left = { x: -1600, y: -200, width: 1600, height: 860 };
const inside = (bounds, area) => bounds.x >= area.x && bounds.y >= area.y &&
  bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height;
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), "niria-layout-"));
  t.after(() => {
    assert.ok(resolve(path).startsWith(`${resolve(tmpdir())}${sep}`));
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}
test("restoration chooses greatest overlap and keeps negative monitor coordinates", () => {
  const bounds = { x: -1250, y: -150, width: 1000, height: 760 };
  assert.deepEqual(chooseArea(bounds, [primary, left]), left);
  assert.deepEqual(mainPlacement(bounds, [primary, left]).bounds, bounds);
  assert.deepEqual(chooseArea({ x: -100, y: 10, width: 800, height: 700 }, [left, primary]), primary);
});
test("missing monitors and display gaps restore entirely into a nearby work area", () => {
  const saved = { x: -1500, y: -100, width: 1200, height: 800 };
  assert.ok(inside(mainPlacement(saved, [primary]).bounds, primary));
  const right = { x: 2400, y: 100, width: 1280, height: 800 };
  const inGap = { x: 2100, y: 200, width: 100, height: 400 };
  assert.deepEqual(chooseArea(inGap, [primary, right]), right);
  assert.ok(inside(widgetPlacement(inGap, false, [primary, right]), right));
});
test("small work areas respect taskbar origins and shrink native minimum dimensions", () => {
  const area = { x: 45, y: 80, width: 600, height: 480 };
  const placement = mainPlacement({ x: -1e5, y: 1e5, width: 3000, height: 2000 }, [area]);
  assert.equal(placement.minWidth, 600);
  assert.equal(placement.minHeight, 480);
  assert.deepEqual(placement.bounds, area);
  const tiny = { x: -80, y: 25, width: 70, height: 80 };
  assert.deepEqual(widgetPlacement(null, false, [tiny]), tiny);
});
test("collapse and expand preserve bottom/right anchors then clamp; find ignores old monitor", () => {
  const original = { x: -1000, y: 0, width: 280, height: 430 };
  const collapsed = widgetPlacement(original, true, [left, primary], { anchor: true });
  assert.deepEqual(collapsed, { x: -812, y: 338, width: 92, height: 92 });
  assert.deepEqual(widgetPlacement(collapsed, false, [left, primary], { anchor: true }), original);
  assert.ok(inside(widgetPlacement({ x: 0, y: 0, width: 92, height: 92 }, false, [primary], { anchor: true }), primary));
  assert.deepEqual(widgetPlacement(original, true, [primary], { find: true }), { x: 1798, y: 918, width: 92, height: 92 });
});
test("untrusted preferences only accept bounded coordinates and actual booleans", () => {
  const state = normalizePreferences({ version: 1, main: { bounds: { x: Infinity, y: 0, width: 800, height: 700 }, maximized: "yes" },
    widget: { collapsed: "false", alwaysOnTop: false, visible: true, bounds: { x: 10, y: 20, width: -5, height: 430 }, apiKey: "ignored" } });
  assert.equal(state.main.bounds, null);
  assert.equal(state.main.maximized, false);
  assert.equal(state.widget.bounds, null);
  assert.equal(state.widget.collapsed, false);
  assert.equal(state.widget.alwaysOnTop, false);
  assert.equal(state.widget.visible, true);
  assert.ok(!JSON.stringify(state).includes("apiKey"));
});
test("fractional DPI rounding does not accumulate while larger manual changes are saved", () => {
  const saved = { x: 30, y: -40, width: 1000, height: 761 };
  let current = { ...saved };
  for (let i = 0; i < 20; i++) current = stableBounds({ ...current, height: current.height + 1 }, current);
  assert.deepEqual(current, saved);
  assert.deepEqual(stableBounds({ ...saved, x: 80, height: 900 }, saved), { ...saved, x: 80, height: 900 });
});
test("atomic local preferences survive restart without companion data or temp files", (t) => {
  const path = join(directory(t), "desktop.json");
  const prefs = new DesktopPreferences(path);
  assert.equal(prefs.warning, "");
  prefs.update("main", { bounds: { x: -900, y: 35, width: 900, height: 750 }, maximized: true });
  prefs.update("widget", { collapsed: true, alwaysOnTop: false, visible: true });
  assert.ok(prefs.flush());
  assert.deepEqual(new DesktopPreferences(path).state, prefs.state);
  assert.deepEqual(readdirSync(resolve(path, "..")), ["desktop.json"]);
});
test("corrupt or oversized files recover safely and do not expose file contents in warnings", (t) => {
  const path = join(directory(t), "desktop.json");
  for (const input of ["secret invalid json", " ".repeat(32769), JSON.stringify({ version: 0 })]) {
    writeFileSync(path, input);
    const prefs = new DesktopPreferences(path);
    assert.equal(prefs.state.widget.visible, false);
    assert.match(prefs.warning, /默认布局/);
    assert.ok(!prefs.warning.includes(input));
  }
});
test("future schema uses defaults and preserves the original file", (t) => {
  const path = join(directory(t), "desktop.json");
  const original = '{"version":2,"newSetting":"keep"}';
  writeFileSync(path, original);
  const prefs = new DesktopPreferences(path);
  prefs.update("widget", { visible: true });
  assert.equal(prefs.flush(), false);
  assert.match(prefs.warning, /较新版本/);
  assert.equal(readFileSync(path, "utf8"), original);
});
test("write failure keeps prior preferences and reports a recoverable sanitized warning", (t) => {
  const folder = directory(t), parent = join(folder, "blocked");
  writeFileSync(parent, "existing");
  const prefs = new DesktopPreferences(join(parent, "desktop.json"));
  prefs.update("widget", { collapsed: true });
  assert.equal(prefs.flush(), false);
  assert.equal(prefs.state.widget.collapsed, true);
  assert.match(prefs.warning, /未能保存/);
  assert.equal(readFileSync(parent, "utf8"), "existing");
  const alternate = join(folder, "directory-as-file");
  mkdirSync(alternate);
  const second = new DesktopPreferences(alternate);
  second.update("widget", { visible: true });
  assert.equal(second.flush(), false);
  assert.deepEqual(readdirSync(folder).sort(), ["blocked", "directory-as-file"]);
});
