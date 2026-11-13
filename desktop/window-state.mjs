import { openSync, fstatSync, readFileSync, closeSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

const defaults = () => ({
  version: 1,
  main: { bounds: null, maximized: false },
  widget: { bounds: null, collapsed: false, visible: false, alwaysOnTop: true }
});
export function validBounds(value) {
  if (!value || !["x", "y", "width", "height"].every((key) => Number.isFinite(value[key]))) return null;
  if (Math.abs(value.x) > 1_000_000 || Math.abs(value.y) > 1_000_000 ||
      value.width < 1 || value.height < 1 || value.width > 32768 || value.height > 32768) return null;
  return Object.fromEntries(["x", "y", "width", "height"].map((key) => [key, Math.round(value[key])]));
}
export function normalizePreferences(value) {
  const state = defaults();
  if (!value || value.version !== 1) return state;
  for (const name of ["main", "widget"]) {
    const input = value[name];
    if (!input || typeof input !== "object") continue;
    state[name].bounds = validBounds(input.bounds);
    for (const key of Object.keys(state[name])) {
      if (typeof state[name][key] === "boolean" && typeof input[key] === "boolean") state[name][key] = input[key];
    }
  }
  return state;
}
export class DesktopPreferences {
  constructor(path) {
    this.path = path;
    this.state = defaults();
    this.warning = "";
    this.readOnly = false;
    this.dirty = false;
    let fd;
    try {
      fd = openSync(path, "r");
      if (fstatSync(fd).size > 32768) throw new Error("Preferences too large");
      const value = JSON.parse(readFileSync(fd, "utf8"));
      if (value && Number.isInteger(value.version) && value.version > 1) {
        this.readOnly = true;
        this.warning = "窗口偏好来自较新版本；本次使用默认布局，不覆盖原文件。";
      } else {
        if (value?.version !== 1) throw new Error("Invalid preferences");
        this.state = normalizePreferences(value);
      }
    } catch (error) {
      if (error.code !== "ENOENT") this.warning = "无法读取窗口偏好，已使用默认布局。";
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  update(section, patch) {
    if (!["main", "widget"].includes(section)) throw new Error("Unsupported preference section");
    const next = normalizePreferences({ ...this.state, [section]: { ...this.state[section], ...patch } });
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.dirty = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
    this.timer.unref();
  }
  flush() {
    clearTimeout(this.timer);
    if (!this.dirty || this.readOnly) return !this.readOnly;
    const previousWarning = this.warning;
    const temporary = `${this.path}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, this.path);
      this.dirty = false;
      this.warning = "";
      if (previousWarning !== this.warning) this.onWarning?.();
      return true;
    } catch {
      this.warning = "窗口偏好未能保存；本次仍可使用，重启后可能恢复旧布局。";
      try { unlinkSync(temporary); } catch {}
      if (previousWarning !== this.warning) this.onWarning?.();
      return false;
    }
  }
}
function areasOf(areas) {
  const result = areas.map(validBounds).filter(Boolean);
  if (!result.length) throw new Error("No display work area");
  return result;
}
export function chooseArea(bounds, areas) {
  areas = areasOf(areas);
  bounds = validBounds(bounds);
  if (!bounds) return areas[0];
  const overlap = (area) => Math.max(0, Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x)) *
    Math.max(0, Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y));
  const distance = (area) => (bounds.x + bounds.width / 2 - area.x - area.width / 2) ** 2 +
    (bounds.y + bounds.height / 2 - area.y - area.height / 2) ** 2;
  return areas.reduce((best, area) => overlap(area) > overlap(best) ||
    (overlap(area) === overlap(best) && distance(area) < distance(best)) ? area : best);
}
function clamp(bounds, area) {
  const width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
  return { x: Math.max(area.x, Math.min(bounds.x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(bounds.y, area.y + area.height - height)), width, height };
}
export function mainPlacement(saved, areas) {
  const area = chooseArea(saved, areas);
  const minWidth = Math.min(780, area.width), minHeight = Math.min(700, area.height);
  const input = validBounds(saved);
  const width = Math.max(minWidth, Math.min(input?.width || 1360, area.width));
  const height = Math.max(minHeight, Math.min(input?.height || 940, area.height));
  const bounds = clamp({ x: input?.x ?? Math.round(area.x + (area.width - width) / 2),
    y: input?.y ?? Math.round(area.y + (area.height - height) / 2), width, height }, area);
  return { bounds, minWidth, minHeight };
}
export function widgetPlacement(saved, collapsed, areas, { anchor = false, find = false } = {}) {
  const area = chooseArea(find ? null : saved, areas);
  const width = Math.min(collapsed ? 92 : 280, area.width), height = Math.min(collapsed ? 92 : 430, area.height);
  const input = find ? null : validBounds(saved);
  return clamp({
    x: input ? input.x + (anchor ? input.width - width : 0) : area.x + area.width - width - 30,
    y: input ? input.y + (anchor ? input.height - height : 0) : area.y + area.height - height - 30,
    width, height
  }, area);
}
