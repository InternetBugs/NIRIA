export function inspectPixels({ width, height, data }, original = { width, height }) {
  let visible = 0, sum = 0, square = 0, edge = 0;
  let left = width, top = height, right = -1, bottom = -1;
  const luminance = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const alpha = data[i * 4 + 3] / 255;
    const value = (data[i * 4] * .2126 + data[i * 4 + 1] * .7152 + data[i * 4 + 2] * .0722) / 255 * alpha + .5 * (1 - alpha);
    luminance[i] = value; sum += value; square += value * value;
    if (alpha > .05) {
      visible++;
      const x = i % width, y = Math.floor(i / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  for (let y = 1; y < height; y++) for (let x = 1; x < width; x++) {
    const i = y * width + x;
    edge += Math.abs(luminance[i] - luminance[i - 1]) + Math.abs(luminance[i] - luminance[i - width]);
  }
  const count = width * height;
  const contrast = Math.sqrt(Math.max(0, square / count - (sum / count) ** 2));
  const coverage = visible / count;
  const issues = [];
  if (coverage < .001) issues.push({ code: "empty", blocking: true, message: "这张图片几乎完全透明，没有可用画面。" });
  else if (coverage > .999 && contrast < .001 && edge / count < .0001) issues.push({ code: "flat", blocking: true, message: "这张图片接近纯色，未检测到可辨认的画面。" });
  else {
    if (Math.min(original.width, original.height) < 256) issues.push({ code: "small", message: "原图短边小于 256 像素，放大后可能不够清楚。" });
    if (contrast < .035) issues.push({ code: "contrast", message: "画面对比度较低，请检查脸部与细节是否清楚。" });
    if (coverage < .08) issues.push({ code: "sparse", message: "可见内容占比较小，建议裁去多余透明边缘。" });
    if (coverage < .95 && (left <= 1 || top <= 1 || right >= width - 2 || bottom >= height - 2)) {
      issues.push({ code: "edge", message: "可见内容接近图片边缘，请检查人物是否被裁切。" });
    }
    if (original.width > original.height * 1.4) issues.push({ code: "wide", message: "这张图片较宽，在竖向伴侣窗口中会显示得较小。" });
  }
  return { issues, coverage, contrast, originalWidth: original.width, originalHeight: original.height };
}

// Signed luminance and alpha gradients retain contour direction without treating
// a uniform background as evidence of a match.
export function edgeField({ width, height, data }) {
  const luma = new Float32Array(width * height), alpha = new Float32Array(width * height);
  for (let i = 0; i < luma.length; i++) {
    alpha[i] = data[i * 4 + 3] / 255;
    luma[i] = (data[i * 4] * .2126 + data[i * 4 + 1] * .7152 + data[i * 4 + 2] * .0722) / 255 * alpha[i] + .5 * (1 - alpha[i]);
  }
  const values = new Float32Array(width * height * 4);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x, p = i * 4;
    values[p] = (luma[i + 1] - luma[i - 1]) / 2;
    values[p + 1] = (luma[i + width] - luma[i - width]) / 2;
    values[p + 2] = (alpha[i + 1] - alpha[i - 1]) / 4;
    values[p + 3] = (alpha[i + width] - alpha[i - width]) / 4;
  }
  return { width, height, values };
}

function half(field) {
  const width = Math.floor(field.width / 2), height = Math.floor(field.height / 2);
  const values = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++) {
    const i = ((y * 2) * field.width + x * 2) * 4 + c;
    values[(y * width + x) * 4 + c] = (field.values[i] + field.values[i + 4] + field.values[i + field.width * 4] + field.values[i + field.width * 4 + 4]) / 4;
  }
  return { width, height, values };
}

function similarity(reference, target, { x = 0, y = 0, scale = 1 } = {}) {
  const { width, height, values } = reference, input = target.values;
  const cx = (width - 1) / 2, cy = (height - 1) / 2;
  let product = 0, aa = 0, bb = 0;
  for (let row = 2; row < height - 2; row++) {
    const sy = (row - cy - y) / scale + cy, iy = Math.floor(sy), fy = sy - iy;
    for (let col = 2; col < width - 2; col++) {
      const sx = (col - cx - x) / scale + cx, ix = Math.floor(sx), fx = sx - ix;
      const inside = ix >= 0 && ix < width - 1 && iy >= 0 && iy < height - 1;
      const i = (row * width + col) * 4, p = (iy * width + ix) * 4;
      for (let c = 0; c < 4; c++) {
        const a = values[i + c];
        const b = inside ? ((input[p + c] * (1 - fx) + input[p + 4 + c] * fx) * (1 - fy) +
          (input[p + width * 4 + c] * (1 - fx) + input[p + width * 4 + 4 + c] * fx) * fy) : 0;
        product += a * b; aa += a * a; bb += b * b;
      }
    }
  }
  return aa > .00001 && bb > .00001 ? product / Math.sqrt(aa * bb) : 0;
}

export function findAlignment(reference, target) {
  if (reference.width !== target.width || reference.height !== target.height || reference.width > 128 || reference.height > 192 ||
      reference.width < 16 || reference.height < 16 || reference.values.length !== reference.width * reference.height * 4 ||
      target.values.length !== target.width * target.height * 4) throw new Error("Invalid alignment samples");
  const baseline = similarity(reference, target);
  const identity = { x: 0, y: 0, scale: 1, score: baseline, baseline, suggested: false };
  if (baseline >= .985 || reference.values.every((value) => Math.abs(value) < .00001) ||
      target.values.every((value) => Math.abs(value) < .00001)) return identity;
  const smallRef = half(reference), smallTarget = half(target);
  let coarse = { x: 0, y: 0, scale: 1, score: similarity(smallRef, smallTarget) };
  const mx = Math.ceil(smallRef.width * .06), my = Math.ceil(smallRef.height * .06);
  for (let step = -3; step <= 3; step++) for (let y = -my; y <= my; y++) for (let x = -mx; x <= mx; x++) {
    const candidate = { x, y, scale: 1 + step * .02 };
    const score = similarity(smallRef, smallTarget, candidate);
    if (score > coarse.score + .000001) coarse = { ...candidate, score };
  }
  let best = identity;
  for (let s = -1; s <= 1; s++) for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
    const candidate = { x: coarse.x * 2 + dx * .5, y: coarse.y * 2 + dy * .5, scale: coarse.scale + s * .01 };
    if (Math.abs(candidate.x) > reference.width * .065 || Math.abs(candidate.y) > reference.height * .065 || candidate.scale < .93 || candidate.scale > 1.07) continue;
    const score = similarity(reference, target, candidate);
    if (score > best.score + .000001) best = { ...candidate, score, baseline };
  }
  const suggested = best.score >= .88 && best.score - baseline >= .08 &&
    (Math.abs(best.x) >= .5 || Math.abs(best.y) >= .5 || Math.abs(best.scale - 1) >= .01);
  return { ...best, suggested };
}
