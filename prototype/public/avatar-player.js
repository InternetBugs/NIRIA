import { FrameBlender } from "./frame-blender.js";
import { prepareAvatarFrame } from "./image-tools.js";
import { backgroundReady, BACKGROUND_FALLBACK } from "./image-background.js";
import { hasAvatarExpression } from "./avatar-expressions.js";
import { Live2DPlayer } from "./live2d-player.js";

const names = ["smile", "curious", "shy"];
export const EXPRESSION_DURATION = 8000;

export function expressionFor(data, at = Date.now()) {
  const last = data.messages.at(-1);
  const value = last?.expression;
  const start = Date.parse(value?.at);
  if (!last || last.deleted || last.conflicted || last.role !== "assistant" || last.status !== "completed" ||
      !value || value.avatarKey !== data.avatarKey || !names.includes(value.name) || !hasAvatarExpression(data.avatar, value.name) ||
      data.conflicts?.some((c) => c.kind === "avatar") || !Number.isFinite(start) || at < start || at >= start + EXPRESSION_DURATION) {
    return { name: "neutral", until: 0, at: 0 };
  }
  return { name: value.name, until: start + EXPRESSION_DURATION, at: start };
}

export class AvatarPlayer {
  constructor(canvas, { presence = () => {}, error = () => {}, live2dRuntime } = {}) {
    this.canvas = canvas;
    this.presence = presence;
    this.error = error;
    this.live2dRuntime = live2dRuntime;
    this.images = {};
    this.blender = new FrameBlender();
    this.pose = { name: "neutral", until: 0, at: 0 };
    this.signature = null;
    this.generation = 0;
    this.frame = 0;
    this.blinkStart = 0;
    this.nextBlink = performance.now() + 4000;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)");
    this.redraw = () => this.draw();
    this.reduced.addEventListener("change", this.redraw);
    document.addEventListener("visibilitychange", this.redraw);
    window.addEventListener("pagehide", () => this.destroy(), { once: true });
  }
  async update(data) {
    const previous = this.pose.name;
    this.pose = expressionFor(data);
    if (data.avatar?.format === "niria-live2d-avatar") {
      if (!this.live2d) {
        ++this.generation;
        this.assetController?.abort();
        cancelAnimationFrame(this.frame); this.frame = 0;
        clearTimeout(this.expiry);
        this.images = {}; this.signature = null;
        this.live2d = new Live2DPlayer(this.canvas, { presence: this.presence, error: this.error, runtime: this.live2dRuntime });
      }
      try { await this.live2d.update(data, this.pose); }
      catch { /* The player already reports its error; chat and state refresh continue. */ }
      return;
    }
    if (this.live2d) {
      this.live2d.destroy(); this.live2d = null; this.signature = null;
      delete this.canvas.dataset.live2dError;
    }
    if (previous !== this.pose.name) {
      this.blinkStart = 0;
      this.nextBlink = performance.now() + 4000;
    }
    clearTimeout(this.expiry);
    if (this.pose.until) this.expiry = setTimeout(this.redraw, Math.max(1, this.pose.until - Date.now()));
    if (this.signature === data.avatarKey) { this.draw(); return; }
    const generation = ++this.generation;
    this.assetController?.abort();
    this.assetController = new AbortController();
    this.signature = data.avatarKey;
    this.blinkStart = 0;
    this.nextBlink = performance.now() + 4000;
    this.images = {};
    this.presence(false);
    this.draw();
    if (!data.avatar) return;
    const entries = [["source", data.avatar.source], ...Object.entries(data.avatar.actions).filter(([name]) => ["blink", ...names].includes(name))];
    const signal = this.assetController.signal;
    const decoded = await Promise.allSettled(entries.map(([, value]) => prepareAvatarFrame(value, data.avatar.background, { signal })));
    if (generation !== this.generation) return;
    if (decoded[0].status === "rejected") { this.error("形象原图无法读取，请重新导入图片。"); return; }
    const backgroundFailed = !!data.avatar.background && decoded.some((result) =>
      result.status === "fulfilled" && !backgroundReady(result.value.backgroundReport));
    for (let i = 0; i < entries.length; i++) if (decoded[i].status === "fulfilled") {
      const frame = decoded[i].value;
      this.images[entries[i][0]] = backgroundFailed ? frame.rawImg : frame.img;
    }
    if (decoded.some((result) => result.status === "rejected")) this.error("有表情素材无法读取，暂时使用原图。");
    else if (backgroundFailed) this.error(BACKGROUND_FALLBACK);
    this.presence(true);
    this.draw();
  }
  draw(time = performance.now()) {
    if (this.live2d) { this.live2d.draw(time); return; }
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    const canvas = this.canvas;
    const context = canvas.getContext("2d");
    context.clearRect(0, 0, canvas.width, canvas.height);
    const at = Date.now();
    const name = at < this.pose.until && this.images[this.pose.name] ? this.pose.name : "neutral";
    canvas.dataset.expression = name;
    if (!this.images.source) return;
    context.save();
    const scale = this.reduced.matches ? 1 : 1 + (Math.sin(time / 1150) + 1) * .003;
    context.translate(canvas.width / 2, canvas.height);
    context.scale(scale, scale);
    context.translate(-canvas.width / 2, -canvas.height);
    let target = null, weight = 0;
    if (name !== "neutral") {
      weight = this.reduced.matches ? 1 : Math.max(0, Math.min(1, (at - this.pose.at) / 220, (this.pose.until - at) / 220));
      target = this.images[name];
      this.blinkStart = 0;
      this.nextBlink = time + 4000;
    } else if (!this.reduced.matches && this.images.blink) {
      if (!this.blinkStart && time >= this.nextBlink) this.blinkStart = time;
      const elapsed = time - this.blinkStart;
      if (this.blinkStart && elapsed < 180) {
        weight = Math.max(0, Math.min(1, elapsed / 55, (180 - elapsed) / 65));
        target = this.images.blink;
      } else if (this.blinkStart) {
        this.blinkStart = 0;
        this.nextBlink = time + 4000 + Math.random() * 3000;
      }
    }
    this.blender.draw(context, this.images.source, target, weight, canvas.width, canvas.height);
    context.restore();
    if (!this.reduced.matches && !document.hidden) this.frame = requestAnimationFrame((next) => this.draw(next));
  }
  destroy() {
    this.live2d?.destroy();
    ++this.generation;
    this.assetController?.abort();
    cancelAnimationFrame(this.frame);
    clearTimeout(this.expiry);
    this.reduced.removeEventListener("change", this.redraw);
    document.removeEventListener("visibilitychange", this.redraw);
    this.blender.destroy();
  }
}
