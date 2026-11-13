import { drawContained } from "./image-tools.js";

// Interpolate premultiplied color and alpha on a transparent surface. Placing
// the target over an opaque source leaves the original silhouette behind.
export class FrameBlender {
  draw(context, source, target, amount, width, height) {
    const weight = Number.isFinite(amount) ? Math.max(0, Math.min(1, amount)) : 0;
    if (!target || weight === 0 || source === target) return drawContained(context, source, width, height);
    if (weight === 1) return drawContained(context, target, width, height);
    this.surface ||= document.createElement("canvas");
    const surface = this.surface;
    if (surface.width !== width || surface.height !== height) { surface.width = width; surface.height = height; }
    const blend = surface.getContext("2d");
    blend.clearRect(0, 0, width, height);
    blend.save();
    blend.globalAlpha = 1 - weight;
    drawContained(blend, source, width, height);
    blend.globalCompositeOperation = "lighter";
    blend.globalAlpha = weight;
    drawContained(blend, target, width, height);
    blend.restore();
    context.drawImage(surface, 0, 0, width, height);
  }
  destroy() {
    if (this.surface) { this.surface.width = 0; this.surface.height = 0; this.surface = null; }
  }
}
