// LBP cascade evaluation over an image pyramid. The fixed MIT classifier is
// distributed separately; this module performs no I/O and runs in a Worker.
const LIMIT = 640;

export function animeGray({ width, height, data }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      Math.max(width, height) > LIMIT || data.length !== width * height * 4)
    throw new Error("图片人脸检查尺寸无效。");
  const gray = new Uint8Array(width * height), histogram = new Uint32Array(256);
  for (let index = 0; index < gray.length; index++) {
    const p = index * 4, alpha = data[p + 3] / 255;
    const value = Math.round((data[p] * .299 + data[p + 1] * .587 + data[p + 2] * .114) * alpha + 255 * (1 - alpha));
    gray[index] = value; histogram[value]++;
  }
  const table = new Uint8Array(256), first = histogram.findIndex((count) => count > 0);
  const remaining = gray.length - histogram[first];
  if (!remaining) return gray;
  let sum = 0;
  for (let value = first + 1; value < 256; value++) {
    sum += histogram[value]; table[value] = Math.round(sum * 255 / remaining);
  }
  return gray.map((value) => table[value]);
}

function resize(gray, width, height, scale) {
  const w = Math.round(width / scale), h = Math.round(height / scale), result = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.max(0, (y + .5) * height / h - .5), iy = Math.floor(sy), fy = sy - iy;
    const ny = Math.min(iy + 1, height - 1);
    for (let x = 0; x < w; x++) {
      const sx = Math.max(0, (x + .5) * width / w - .5), ix = Math.floor(sx), fx = sx - ix;
      const nx = Math.min(ix + 1, width - 1);
      result[y * w + x] = Math.round(
        (gray[iy * width + ix] * (1 - fx) + gray[iy * width + nx] * fx) * (1 - fy) +
        (gray[ny * width + ix] * (1 - fx) + gray[ny * width + nx] * fx) * fy);
    }
  }
  return { width: w, height: h, data: result };
}

function integral({ width, height, data }) {
  const stride = width + 1, sums = new Uint32Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += data[y * width + x];
      sums[(y + 1) * stride + x + 1] = sums[y * stride + x + 1] + row;
    }
  }
  return sums;
}

function groupRectangles(boxes, minimum = 3) {
  const parent = boxes.map((_, index) => index);
  const root = (index) => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  for (let a = 0; a < boxes.length; a++) for (let b = 0; b < a; b++) {
    const x = boxes[a], y = boxes[b], epsilon = .2 * Math.min(x.size, y.size);
    if (Math.abs(x.x - y.x) <= epsilon && Math.abs(x.y - y.y) <= epsilon &&
        Math.abs(x.x + x.size - y.x - y.size) <= epsilon && Math.abs(x.y + x.size - y.y - y.size) <= epsilon)
      parent[root(a)] = root(b);
  }
  const groups = new Map();
  boxes.forEach((box, index) => {
    const key = root(index), group = groups.get(key) || { x: 0, y: 0, size: 0, neighbors: 0 };
    group.x += box.x; group.y += box.y; group.size += box.size; group.neighbors++;
    groups.set(key, group);
  });
  const candidates = [...groups.values()].filter((box) => box.neighbors > minimum)
    .map((box) => ({ x: Math.round(box.x / box.neighbors), y: Math.round(box.y / box.neighbors),
      width: Math.round(box.size / box.neighbors), height: Math.round(box.size / box.neighbors), neighbors: box.neighbors }));
  return candidates.filter((a) => !candidates.some((b) => a !== b && a.x >= b.x - b.width * .2 &&
    a.y >= b.y - b.height * .2 && a.x + a.width <= b.x + b.width * 1.2 &&
    a.y + a.height <= b.y + b.height * 1.2 && b.neighbors > Math.max(3, a.neighbors)));
}

export function detectAnimeFaces(gray, width, height, model) {
  if (!(gray instanceof Uint8Array) || gray.length !== width * height ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      Math.max(width, height) > LIMIT || model?.format !== "niria-animeface-lbp" ||
      model.version !== 1 || model.size !== 24) throw new Error("图片人脸检查资料无效。");
  const boxes = [];
  for (let scale = 1; Math.min(width, height) / scale >= 24; scale *= 1.1) {
    const image = resize(gray, width, height, scale), stride = image.width + 1, sums = integral(image);
    const offsets = model.features.map(([x, y, w, h]) => {
      const points = new Int32Array(16);
      for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++)
        points[row * 4 + col] = (y + row * h) * stride + x + col * w;
      return points;
    });
    const step = scale >= 2 ? 1 : 2;
    for (let y = 0; y <= image.height - 24; y += step) for (let x = 0; x <= image.width - 24; x += step) {
      const base = y * stride + x;
      let passed = true;
      for (const [threshold, trees] of model.stages) {
        let score = 0;
        for (const [feature, subset, leaves] of trees) {
          const p = offsets[feature];
          const center = sums[base + p[5]] - sums[base + p[6]] - sums[base + p[9]] + sums[base + p[10]];
          const category =
            (sums[base+p[0]]-sums[base+p[1]]-sums[base+p[4]]+sums[base+p[5]] >= center ? 128 : 0) |
            (sums[base+p[1]]-sums[base+p[2]]-sums[base+p[5]]+sums[base+p[6]] >= center ? 64 : 0) |
            (sums[base+p[2]]-sums[base+p[3]]-sums[base+p[6]]+sums[base+p[7]] >= center ? 32 : 0) |
            (sums[base+p[6]]-sums[base+p[7]]-sums[base+p[10]]+sums[base+p[11]] >= center ? 16 : 0) |
            (sums[base+p[10]]-sums[base+p[11]]-sums[base+p[14]]+sums[base+p[15]] >= center ? 8 : 0) |
            (sums[base+p[9]]-sums[base+p[10]]-sums[base+p[13]]+sums[base+p[14]] >= center ? 4 : 0) |
            (sums[base+p[8]]-sums[base+p[9]]-sums[base+p[12]]+sums[base+p[13]] >= center ? 2 : 0) |
            (sums[base+p[4]]-sums[base+p[5]]-sums[base+p[8]]+sums[base+p[9]] >= center ? 1 : 0);
          score += subset[category >>> 5] & (1 << (category & 31)) ? leaves[0] : leaves[1];
        }
        if (score < threshold - .00001) { passed = false; break; }
      }
      if (passed) {
        boxes.push({ x: Math.round(x * scale), y: Math.round(y * scale), size: Math.round(24 * scale) });
        if (boxes.length > 1000) throw new Error("图片中存在过多相似区域，无法可靠检查人脸。");
      }
    }
  }
  return groupRectangles(boxes).sort((a, b) => a.x - b.x || a.y - b.y);
}
