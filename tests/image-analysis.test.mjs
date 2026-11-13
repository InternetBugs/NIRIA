import test from "node:test";
import assert from "node:assert/strict";
import { inspectPixels, edgeField, findAlignment } from "../prototype/public/image-analysis.js";

function picture(width = 96, height = 144) {
  const data = new Uint8ClampedArray(width * height * 4);
  const rectangle = (x, y, w, h, color) => {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) {
      if (row >= 0 && row < height && col >= 0 && col < width) data.set(color, (row * width + col) * 4);
    }
  };
  rectangle(25, 62, 46, 66, [37, 67, 112, 255]);
  rectangle(32, 20, 33, 45, [218, 178, 154, 255]);
  rectangle(29, 16, 39, 12, [49, 32, 21, 255]);
  rectangle(20, 68, 6, 38, [144, 65, 38, 255]);
  rectangle(70, 73, 8, 45, [49, 32, 21, 255]);
  rectangle(36, 34, 4, 3, [10, 10, 10, 255]);
  rectangle(55, 34, 4, 3, [10, 10, 10, 255]);
  rectangle(45, 49, 9, 2, [100, 40, 70, 255]);
  rectangle(32, 90, 5, 22, [200, 180, 90, 255]);
  rectangle(57, 105, 6, 6, [225, 225, 225, 255]);
  return { width, height, data };
}
function transformed(image, { x = 0, y = 0, scale = 1 } = {}) {
  const { width, height } = image, data = new Uint8ClampedArray(image.data.length);
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  for (let row = 0; row < height; row++) for (let col = 0; col < width; col++) {
    const sx = (col - cx - x) / scale + cx, sy = (row - cy - y) / scale + cy;
    const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
    if (ix < 0 || ix >= width - 1 || iy < 0 || iy >= height - 1) continue;
    const i = (iy * width + ix) * 4, p = (row * width + col) * 4;
    for (let c = 0; c < 4; c++) data[p + c] =
      (image.data[i + c] * (1 - fx) + image.data[i + 4 + c] * fx) * (1 - fy) +
      (image.data[i + width * 4 + c] * (1 - fx) + image.data[i + width * 4 + 4 + c] * fx) * fy;
  }
  return { width, height, data };
}
test("pixel checks distinguish empty and flat images from usable content and retain original resolution warnings", () => {
  const empty = { width: 48, height: 72, data: new Uint8ClampedArray(48 * 72 * 4) };
  assert.equal(inspectPixels(empty).issues[0].code, "empty");
  const flat = { ...empty, data: new Uint8ClampedArray(empty.data.length).fill(255) };
  assert.equal(inspectPixels(flat).issues[0].code, "flat");
  const image = picture();
  const report = inspectPixels(image, { width: 640, height: 960 });
  assert.equal(report.issues.some((issue) => issue.blocking), false);
  assert.equal(report.issues.some((issue) => issue.code === "small"), false);
  assert.ok(report.coverage > .1 && report.coverage < .8);
  assert.equal(inspectPixels(image, { width: 128, height: 192 }).issues.some((issue) => issue.code === "small"), true);
  assert.equal(inspectPixels(image, { width: 1600, height: 800 }).issues.some((issue) => issue.code === "wide"), true);
});
test("transparent clipping and low contrast produce advisory messages, not semantic person verdicts", () => {
  const image = picture();
  for (let y = 1; y < 30; y++) image.data.set([50, 50, 50, 255], y * image.width * 4);
  const report = inspectPixels(image);
  assert.equal(report.issues.some((issue) => issue.code === "edge"), true);
  assert.equal(report.issues.some((issue) => issue.blocking), false);
  assert.equal(Object.hasOwn(report, "personCount"), false);
  const subtle = { width: 32, height: 48, data: new Uint8ClampedArray(32 * 48 * 4) };
  for (let i = 0; i < 32 * 48; i++) {
    const gray = 127 + (i % 2) * 5;
    subtle.data.set([gray, gray, gray, 255], i * 4);
  }
  const lowContrast = inspectPixels(subtle);
  assert.equal(lowContrast.issues.some((issue) => issue.code === "contrast"), true);
  assert.equal(lowContrast.issues.some((issue) => issue.blocking), false);
});
test("position comparison leaves matching and uninformative frames untouched", () => {
  const image = picture();
  const field = edgeField(image);
  const result = findAlignment(field, field);
  assert.equal(result.suggested, false);
  assert.equal(result.x, 0);
  assert.equal(result.y, 0);
  const blank = edgeField({ ...image, data: new Uint8ClampedArray(image.data.length) });
  assert.equal(findAlignment(blank, blank).suggested, false);
});
test("position comparison recovers small translation while tolerating a local expression change", () => {
  const reference = picture(), changed = picture();
  // Only the small eye area differs; most body and contour features remain.
  for (let x = 36; x < 40; x++) changed.data.set([218, 178, 154, 255], (35 * changed.width + x) * 4);
  const target = transformed(changed, { x: 4, y: -6 });
  const result = findAlignment(edgeField(reference), edgeField(target));
  assert.equal(result.suggested, true, JSON.stringify(result));
  assert.ok(Math.abs(result.x + 4) <= .5, JSON.stringify(result));
  assert.ok(Math.abs(result.y - 6) <= .5, JSON.stringify(result));
  assert.ok(result.score > result.baseline + .08);
});
test("small scale correction improves pixel alignment without rotation or deformation", () => {
  const reference = picture(), target = transformed(reference, { scale: 1.04, x: 2, y: -2 });
  const result = findAlignment(edgeField(reference), edgeField(target));
  assert.equal(result.suggested, true, JSON.stringify(result));
  assert.ok(Math.abs(result.scale - 1 / 1.04) <= .025, JSON.stringify(result));
  const corrected = transformed(target, result);
  const delta = (a, b) => a.data.reduce((sum, value, i) => sum + Math.abs(value - b.data[i]), 0);
  assert.ok(delta(reference, corrected) < delta(reference, target) * .65, JSON.stringify(result));
});
test("unrelated and excessive shifts do not receive a confident automatic correction", () => {
  const reference = picture(), noisy = picture();
  let seed = 731;
  for (let i = 0; i < noisy.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const gray = seed >>> 24;
    noisy.data.set([gray, gray, gray, 255], i);
  }
  assert.equal(findAlignment(edgeField(reference), edgeField(noisy)).suggested, false);
  assert.equal(findAlignment(edgeField(reference), edgeField(transformed(reference, { x: 20, y: 24 }))).suggested, false);
});
