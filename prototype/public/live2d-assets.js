import { inspectLive2DImport, live2DPath } from "./live2d-import.js";

export function live2DAssets(bundle, { urls = URL } = {}) {
  inspectLive2DImport(bundle);
  const files = new Map(bundle.files.map((file) => [file.path, file.data]));
  const bytes = new Map(), objects = new Map();
  let disposed = false;
  const check = () => { if (disposed) throw new DOMException("模型资源已经释放。", "AbortError"); };
  const pathFor = (path, relativeTo) => {
    check();
    const resolved = live2DPath(path, relativeTo);
    if (!files.has(resolved)) throw new Error("模型请求了导入资料中不存在的资源。");
    return resolved;
  };
  const content = (path) => {
    if (!bytes.has(path)) bytes.set(path, Uint8Array.from(atob(files.get(path)), (character) => character.charCodeAt(0)));
    return bytes.get(path);
  };
  return {
    read(path, relativeTo = "") { return content(pathFor(path, relativeTo)).slice(); },
    json(path, relativeTo = "") {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content(pathFor(path, relativeTo))).replace(/^\uFEFF/, ""));
    },
    url(path, relativeTo = "") {
      const resolved = pathFor(path, relativeTo);
      if (!objects.has(resolved)) objects.set(resolved, urls.createObjectURL(new Blob([content(resolved)], {
        type: /\.png$/i.test(resolved) ? "image/png" : /\.json$/i.test(resolved) ? "application/json" : "application/octet-stream"
      })));
      return objects.get(resolved);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const url of objects.values()) urls.revokeObjectURL(url);
      objects.clear(); bytes.clear(); files.clear();
    }
  };
}
