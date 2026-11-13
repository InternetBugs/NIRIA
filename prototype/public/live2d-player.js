import { inspectLive2DAvatar } from "./live2d-avatar.js";
import { live2DAssets } from "./live2d-assets.js";
import { createLive2DRuntime } from "./live2d-runtime.js";

export class Live2DPlayer {
  constructor(canvas, { presence = () => {}, error = () => {}, runtime = createLive2DRuntime } = {}) {
    this.canvas = canvas;
    this.presence = presence;
    this.error = error;
    this.runtimeFactory = runtime;
    this.generation = 0;
    this.signature = undefined;
    this.pose = { name: "neutral", until: 0 };
    this.frame = 0;
    this.destroyed = false;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)");
    this.redraw = () => this.draw();
    this.reduced.addEventListener("change", this.redraw);
    document.addEventListener("visibilitychange", this.redraw);
    window.addEventListener("pagehide", this.stop = () => this.destroy(), { once: true });
  }
  release() {
    cancelAnimationFrame(this.frame); this.frame = 0;
    clearTimeout(this.expiry);
    this.controller?.abort();
    this.surface?.removeEventListener("webglcontextlost", this.lost);
    try { this.runtime?.destroy(); }
    catch { /* Disposal must still revoke URLs and release the remaining resources. */ }
    this.assets?.dispose();
    this.runtime = null; this.assets = null; this.surface = null; this.previousTime = undefined;
    this.canvas.getContext("2d").clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.dataset.expression = "neutral";
    this.presence(false);
  }
  report(message) {
    this.canvas.dataset.live2dError = message;
    this.error(message);
  }
  async update(data, pose = { name: "neutral", until: 0 }) {
    if (this.destroyed) return;
    this.pose = pose;
    clearTimeout(this.expiry);
    if (pose.until) this.expiry = setTimeout(this.redraw, Math.max(1, pose.until - Date.now()));
    if (this.signature === data.avatarKey) { this.draw(); return; }
    const generation = ++this.generation;
    this.signature = data.avatarKey;
    this.release();
    delete this.canvas.dataset.live2dError;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    let assets, runtime, surface;
    const disposePrepared = () => {
      const prepared = runtime;
      runtime = null;
      try { prepared?.destroy(); } catch { /* Continue releasing resources after a runtime error. */ }
      assets?.dispose(); assets = null;
    };
    try {
      inspectLive2DAvatar(data.avatar);
      assets = live2DAssets(data.avatar.package);
      const preparedAssets = assets;
      signal.addEventListener("abort", () => preparedAssets.dispose(), { once: true });
      surface = document.createElement("canvas");
      surface.width = this.canvas.width; surface.height = this.canvas.height;
      runtime = await this.runtimeFactory({ canvas: surface, assets, model: data.avatar.package.model,
        bindings: structuredClone(data.avatar.bindings), signal });
      if (this.destroyed || signal.aborted || generation !== this.generation) {
        disposePrepared();
        return;
      }
      if (typeof runtime?.render !== "function" || typeof runtime.destroy !== "function")
        throw new Error("Live2D 播放组件没有完成初始化。");
      this.assets = assets; this.runtime = runtime; this.surface = surface;
      assets = null; runtime = null;
      this.bindings = data.avatar.bindings;
      this.lost = (event) => {
        event.preventDefault();
        if (generation === this.generation && !this.destroyed) {
          ++this.generation;
          this.release();
          this.report("Live2D 显示已中断，请重新打开模型预览；模型资料仍保存在本机。");
        }
      };
      surface.addEventListener("webglcontextlost", this.lost);
      if (!this.draw(performance.now(), false)) throw new Error("Live2D 模型未能完成第一帧预览。");
      this.presence(true);
      if (pose.until) this.expiry = setTimeout(this.redraw, Math.max(1, pose.until - Date.now()));
    } catch (error) {
      disposePrepared();
      if (this.destroyed || signal.aborted || generation !== this.generation) return;
      this.release();
      this.report(error instanceof Error ? error.message : "Live2D 模型无法播放。");
      throw error;
    }
  }
  draw(time = performance.now(), reportError = true) {
    cancelAnimationFrame(this.frame); this.frame = 0;
    if (this.destroyed || !this.runtime) return false;
    const expression = Date.now() < this.pose.until ? this.bindings.expressions[this.pose.name] || null : null;
    const delta = this.previousTime === undefined || document.hidden || this.reduced.matches ? 0 :
      Math.min(.1, Math.max(0, (time - this.previousTime) / 1000));
    this.previousTime = document.hidden ? undefined : time;
    try {
      this.runtime.render({ time, delta, expression, idleGroup: this.bindings.idleGroup, reducedMotion: this.reduced.matches });
      const context = this.canvas.getContext("2d");
      context.clearRect(0, 0, this.canvas.width, this.canvas.height);
      context.drawImage(this.surface, 0, 0, this.canvas.width, this.canvas.height);
      this.canvas.dataset.expression = expression ? this.pose.name : "neutral";
      if (!document.hidden && !this.reduced.matches) this.frame = requestAnimationFrame((next) => this.draw(next));
      return true;
    } catch {
      if (!reportError) throw new Error("Live2D 模型未能完成第一帧预览。");
      ++this.generation;
      this.release();
      this.report("Live2D 动画无法继续播放，请重新预览模型；聊天和模型资料已保留。");
      return false;
    }
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true; ++this.generation;
    this.release();
    this.reduced.removeEventListener("change", this.redraw);
    document.removeEventListener("visibilitychange", this.redraw);
    window.removeEventListener("pagehide", this.stop);
  }
}
