import { readFile, access } from "node:fs/promises";

// Node-only implementation. The local server serves a constant JS module at
// this URL to browsers, so renderer event registration needs no async probe.
async function inspectLocalSDK() {
  const root = new URL("./vendor/live2d/", import.meta.url);
  try {
    const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
    if (manifest.sdk !== "Cubism SDK for Web 5 R5") throw new Error("Unsupported SDK");
    for (const path of ["live2dcubismcore.min.js", "cubism-framework.js"])
      if (!manifest.files[path]) throw new Error("Incomplete SDK");
    if (Object.keys(manifest.files).filter((path) => /\.(vert|frag)$/.test(path)).length !== 13)
      throw new Error("Incomplete shaders");
    await Promise.all(Object.keys(manifest.files).map((path) => {
      if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split("/").includes("..")) throw new Error("Invalid SDK path");
      return access(new URL(path, root));
    }));
    return { available: true, version: manifest.sdk, message: "使用本机 Cubism 播放组件，预览成功后可采用。" };
  } catch {
    return { available: false, version: "Cubism SDK for Web 5 R5",
      message: "尚未配置本机 Live2D SDK。可检查模型文件；播放及采用需按项目文档单独接入官方 SDK。" };
  }
}
export const live2DRuntimeInfo = Object.freeze(await inspectLocalSDK());
