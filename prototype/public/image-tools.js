import { inspectPixels, edgeField, findAlignment } from "./image-analysis.js";
import { removeEdgeBackground } from "./image-background.js";
import { animeGray, detectAnimeFaces } from "./animeface.js";

export const WIDTH = 1024, HEIGHT = 1536;
const pageChecks = typeof window === "undefined" ? null : new AbortController();
if (pageChecks) window.addEventListener("pagehide", () => pageChecks.abort(), { once: true });
export async function imageFrom(value) {
  const image = new Image();
  image.src = value;
  await image.decode();
  if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 20_000_000) {
    throw new Error("图片超过 2000 万像素或尺寸无效，请缩小后重新导入。");
  }
  return image;
}
export function drawContained(context, image, width = WIDTH, height = HEIGHT) {
  const ratio = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const w = image.naturalWidth * ratio, h = image.naturalHeight * ratio;
  context.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
}
function surface(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width; canvas.height = height;
  return canvas;
}
export function normalized(image, transform = { x: 0, y: 0, scale: 1 }) {
  const canvas = surface(WIDTH, HEIGHT), context = canvas.getContext("2d");
  context.translate(WIDTH / 2 + transform.x, HEIGHT / 2 + transform.y);
  context.scale(transform.scale, transform.scale);
  context.translate(-WIDTH / 2, -HEIGHT / 2);
  drawContained(context, image);
  return canvas.toDataURL("image/png");
}
export function inspectImage(image) {
  const ratio = Math.min(1, 160 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = surface(Math.max(1, Math.round(image.naturalWidth * ratio)), Math.max(1, Math.round(image.naturalHeight * ratio)));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return inspectPixels(context.getImageData(0, 0, canvas.width, canvas.height), { width: image.naturalWidth, height: image.naturalHeight });
}
export async function inspectCharacterImage(image, { signal } = {}) {
  signal = pageChecks ? AbortSignal.any([pageChecks.signal, ...(signal ? [signal] : [])]) : signal;
  signal?.throwIfAborted();
  const quality = inspectImage(image);
  if (quality.issues.some((issue) => issue.blocking)) return quality;
  const scale = Math.min(1, 640 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = surface(Math.max(1, Math.round(image.naturalWidth * scale)), Math.max(1, Math.round(image.naturalHeight * scale)));
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  try {
    let result;
    if (typeof Worker === "undefined") {
      const checkSignal = AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]);
      const response = await fetch(new URL("./vendor/animeface/model.json", import.meta.url), { signal: checkSignal });
      if (!response.ok) throw new Error();
      const model = await response.json();
      checkSignal.throwIfAborted();
      result = { faces: detectAnimeFaces(animeGray(pixels), pixels.width, pixels.height, model) };
    } else result = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./image-worker.js", import.meta.url), { type: "module" });
      let finished = false;
      const finish = (callback, value) => {
        if (finished) return;
        finished = true; clearTimeout(timer); worker.terminate();
        signal?.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = () => finish(reject, signal.reason || new DOMException("检查已取消。", "AbortError"));
      const timer = setTimeout(() => finish(reject, new Error("本机人脸检查超时，请在预览中确认人物。")), 8000);
      signal?.addEventListener("abort", abort, { once: true });
      worker.onmessage = ({ data }) => data.error ? finish(reject, new Error(data.error)) : finish(resolve, data.result);
      worker.onerror = () => finish(reject, new Error("本机人脸检查未完成，请在预览中确认人物。"));
      if (signal?.aborted) return abort();
      try { worker.postMessage({ type: "faces", pixels }, [pixels.data.buffer]); }
      catch { finish(reject, new Error("本机人脸检查无法启动，请在预览中确认人物。")); }
    });
    signal?.throwIfAborted();
    const faces = result.faces.map((face) => ({ ...face, x: face.x / canvas.width, y: face.y / canvas.height,
      width: face.width / canvas.width, height: face.height / canvas.height }));
    quality.faceCheck = { status: faces.length === 1 ? "one-face" : faces.length > 1 ? "multiple-faces" : "unconfirmed", faces };
    if (faces.length > 1) quality.issues.push({ code: "multiple-faces", blocking: true, message: "检测到多张二次元人脸，请选择只包含一位人物的立绘。" });
    else if (!faces.length) quality.issues.push({ code: "face-unconfirmed", message: "未能确认清晰的二次元正面人脸；可能是遮挡、侧脸、脸部太小或画风不适配，请检查后再生成。" });
    else if (faces[0].width * image.naturalWidth < 64 || faces[0].height * image.naturalHeight < 64)
      quality.issues.push({ code: "small-face", message: "检测到的脸部短边小于 64 像素，表情生成可能缺少细节，建议使用更清晰的原图。" });
  } catch (error) {
    signal?.throwIfAborted();
    quality.faceCheck = { status: "unavailable", faces: [] };
    quality.issues.push({ code: "face-unavailable", message: error.message || "本机人脸检查未完成，请在预览中确认人物。" });
  }
  return quality;
}
export async function prepareImageFile(file, { signal } = {}) {
  signal?.throwIfAborted();
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 8 * 1024 * 1024) throw new Error("请选择 8 MB 以内的 PNG、JPG 或 WebP 图片。");
  const url = URL.createObjectURL(file);
  let image;
  try { image = await imageFrom(url); } finally { URL.revokeObjectURL(url); }
  signal?.throwIfAborted();
  const quality = await inspectCharacterImage(image, { signal });
  const blocked = quality.issues.find((issue) => issue.blocking);
  if (blocked) throw new Error(blocked.message);
  const data = normalized(image);
  const img = await imageFrom(data);
  signal?.throwIfAborted();
  return { data, img, quality };
}
function field(image) {
  const canvas = surface(96, 144), context = canvas.getContext("2d", { willReadFrequently: true });
  drawContained(context, image, 96, 144);
  return edgeField(context.getImageData(0, 0, 96, 144));
}
export async function compareFrames(referenceImage, targetImage, { signal } = {}) {
  signal = pageChecks ? AbortSignal.any([pageChecks.signal, ...(signal ? [signal] : [])]) : signal;
  signal?.throwIfAborted();
  const reference = field(referenceImage), target = field(targetImage);
  let comparison;
  if (typeof Worker === "undefined") comparison = findAlignment(reference, target);
  else comparison = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./image-worker.js", import.meta.url), { type: "module" });
    let finished = false;
    const finish = (callback, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer); worker.terminate();
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => finish(reject, signal.reason || new DOMException("位置比较已取消。", "AbortError"));
    const timer = setTimeout(() => finish(reject, new Error("位置比较超时，仍可对照原图决定是否采用。")), 15_000);
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => data.error ? finish(reject, new Error(data.error)) : finish(resolve, data.result);
    worker.onerror = () => finish(reject, new Error("位置比较不可用，仍可人工对照后采用。"));
    if (signal?.aborted) return abort();
    try { worker.postMessage({ reference, target }); }
    catch { finish(reject, new Error("位置比较无法启动，仍可人工对照后采用。")); }
  });
  signal?.throwIfAborted();
  return { ...comparison, x: comparison.x * WIDTH / 96, y: comparison.y * HEIGHT / 144 };
}
export function overlayFrames(reference, target) {
  const canvas = surface(WIDTH, HEIGHT), context = canvas.getContext("2d");
  drawContained(context, reference);
  context.globalAlpha = .5;
  drawContained(context, target);
  return canvas.toDataURL("image/png");
}

export async function prepareAvatarFrame(value, background, { signal } = {}) {
  const img = await imageFrom(value);
  signal?.throwIfAborted();
  const original = { raw: value, data: value, img, rawImg: img };
  if (!background) return original;
  const canvas = surface(WIDTH, HEIGHT), context = canvas.getContext("2d", { willReadFrequently: true });
  drawContained(context, img);
  const pixels = context.getImageData(0, 0, WIDTH, HEIGHT);
  let report;
  try {
    if (typeof Worker === "undefined") report = removeEdgeBackground(pixels);
    else report = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./image-worker.js", import.meta.url), { type: "module" });
      let finished = false;
      const finish = (callback, value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); worker.terminate();
        signal?.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = () => finish(reject, signal.reason);
      const timer = setTimeout(() => finish(reject, new Error("本机背景处理超时，原图已保留。")), 15_000);
      signal?.addEventListener("abort", abort, { once: true });
      worker.onmessage = ({ data }) => data.error ? finish(reject, new Error(data.error)) : finish(resolve, data.result);
      worker.onerror = () => finish(reject, new Error("本机背景处理不可用，原图已保留。"));
      if (signal?.aborted) return abort();
      try {
        worker.postMessage({ type: "background", pixels: { width: WIDTH, height: HEIGHT, data: pixels.data } }, [pixels.data.buffer]);
      } catch { finish(reject, new Error("本机背景处理无法启动，原图已保留。")); }
    });
  } catch (error) {
    signal?.throwIfAborted();
    return { ...original, backgroundReport: { status: "unavailable", message: error.message } };
  }
  signal?.throwIfAborted();
  const { data: output, ...backgroundReport } = report;
  if (report.status !== "applied") return { ...original, backgroundReport };
  context.putImageData(new ImageData(output, WIDTH, HEIGHT), 0, 0);
  const data = canvas.toDataURL("image/png");
  const processed = await imageFrom(data);
  signal?.throwIfAborted();
  return { raw: value, data, img: processed, rawImg: img, backgroundReport };
}
