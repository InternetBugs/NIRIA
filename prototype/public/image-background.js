export const EDGE_BACKGROUND = Object.freeze({ version: 1, mode: "edge-connected" });
export const BACKGROUND_FALLBACK = "透明背景未能完整处理，已恢复整组原素材显示。可在形象页恢复原背景，或重新打开形象重试本机处理。";
export const backgroundReady = (report) => report?.status === "applied" || report?.status === "transparent";

export function checkBackground(value) {
  if (value === undefined) return undefined;
  if (!value || value.version !== 1 || value.mode !== "edge-connected" ||
      Object.keys(value).some((key) => !["version", "mode"].includes(key))) {
    throw new Error("背景处理设置无效或来自较新版本。");
  }
  return { ...EDGE_BACKGROUND };
}

const distance = (data, p, color) => Math.max(
  Math.abs(data[p] - color[0]), Math.abs(data[p + 1] - color[1]), Math.abs(data[p + 2] - color[2]));

// A bounded, four-connected matte. Only colors close to a stable perimeter
// color can be reached. Enclosed details are never seeds; this is not a person
// detector and must be previewed before adopting the presentation setting.
export function removeEdgeBackground({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width * height > 4_000_000 || !(data instanceof Uint8ClampedArray) || data.length !== width * height * 4) {
    throw new Error("背景处理图片尺寸或像素无效。");
  }
  const count = width * height;
  const unchanged = (status, message) => ({ width, height, data, status, message, removed: 0 });
  let left = width, top = height, right = -1, bottom = -1, visible = 0;
  for (let i = 0; i < count; i++) if (data[i * 4 + 3] > 8) {
    const x = i % width, y = Math.floor(i / width);
    left = Math.min(left, x); right = Math.max(right, x);
    top = Math.min(top, y); bottom = Math.max(bottom, y); visible++;
  }
  if (visible < 4 || right - left < 2 || bottom - top < 2) return unchanged("empty", "画面太少，保留原图。");
  const boxArea = (right - left + 1) * (bottom - top + 1), samples = [];
  if (visible / count < .98 && (visible / boxArea < .95 ||
      ((right - left + 1) < width * .98 && (bottom - top + 1) < height * .98))) {
    return unchanged("transparent", "已有透明轮廓，保留素材。");
  }
  const step = Math.max(1, Math.ceil((2 * (right - left + bottom - top) + 4) / 2048));
  for (let x = left; x <= right; x += step) {
    samples.push({ p: (top * width + x) * 4, side: 0 }, { p: (bottom * width + x) * 4, side: 1 });
  }
  for (let y = top; y <= bottom; y += step) {
    samples.push({ p: (y * width + left) * 4, side: 2 }, { p: (y * width + right) * 4, side: 3 });
  }
  const opaque = samples.filter(({ p }) => data[p + 3] >= 245);
  const bins = new Map();
  for (const { p } of opaque) {
    const key = (data[p] >> 4) * 256 + (data[p + 1] >> 4) * 16 + (data[p + 2] >> 4);
    let bin = bins.get(key);
    if (!bin) { bin = { size: 0, color: [0, 0, 0] }; bins.set(key, bin); }
    bin.size++;
    for (let c = 0; c < 3; c++) bin.color[c] += data[p + c];
  }
  const dominant = [...bins.values()].sort((a, b) => b.size - a.size)[0];
  const fallback = () => visible / boxArea < .95 || (visible / count < .98 && opaque.length < samples.length * .98)
    ? unchanged("transparent", "已有透明轮廓，保留素材。")
    : unchanged("complex", "边缘背景不够一致，保留素材；复杂背景需要其他分割方法。");
  if (!dominant || opaque.length < samples.length * .45) return fallback();
  const color = dominant.color.map((value) => value / dominant.size);
  const near = opaque.filter(({ p }) => distance(data, p, color) <= 18);
  if (near.length < samples.length * .8) return fallback();
  for (let c = 0; c < 3; c++) color[c] = Math.round(near.reduce((sum, { p }) => sum + data[p + c], 0) / near.length);
  const sides = Array.from({ length: 4 }, (_, side) => {
    const edge = samples.filter((sample) => sample.side === side);
    return edge.filter(({ p }) => data[p + 3] >= 245 && distance(data, p, color) <= 18).length / edge.length;
  });
  if (sides.filter((ratio) => ratio >= .65).length < 3) return fallback();
  const seen = new Uint8Array(count), queue = new Uint32Array(count);
  let head = 0, tail = 0;
  const visit = (i) => {
    if (seen[i]) return;
    seen[i] = 1;
    if (data[i * 4 + 3] <= 8 || distance(data, i * 4, color) < 32) queue[tail++] = i;
  };
  for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
  for (let y = 0; y < height; y++) { visit(y * width); visit(y * width + width - 1); }
  const output = new Uint8ClampedArray(data);
  let removed = 0;
  while (head < tail) {
    const i = queue[head++], p = i * 4, alpha = data[p + 3], x = i % width;
    if (alpha > 8) {
      const foreground = Math.max(0, Math.min(1, (distance(data, p, color) - 8) / 24));
      output[p + 3] = Math.round(alpha * foreground);
      removed += (alpha - output[p + 3]) / 255;
      if (!output[p + 3]) output.fill(0, p, p + 3);
      else if (alpha >= 245 && foreground < 1) for (let c = 0; c < 3; c++) {
        output[p + c] = (data[p + c] - color[c] * (1 - foreground)) / foreground;
      }
    }
    if (x) visit(i - 1);
    if (x + 1 < width) visit(i + 1);
    if (i >= width) visit(i - width);
    if (i + width < count) visit(i + width);
  }
  const fraction = removed / visible;
  if (fraction > .92 || visible - removed < Math.max(4, count * .005)) {
    return unchanged("excessive", "处理后保留的画面太少，已保留原素材。");
  }
  if (fraction < .02) return fallback();
  return { width, height, data: output, status: "applied", color, removed: fraction,
    message: `已预览移除约 ${Math.round(fraction * 100)}% 的可见背景，请检查头发、浅色衣服与边缘。` };
}
