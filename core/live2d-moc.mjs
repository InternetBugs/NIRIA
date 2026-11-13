import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { ServiceError } from "../prototype/image-service.mjs";
import { live2DAssets } from "../prototype/public/live2d-assets.js";

// Execute only the fixed, bundled official Core. Imported models supply bytes,
// never JavaScript. This context has no filesystem, network, process or require.
const source = await readFile(new URL("../prototype/public/vendor/live2d/live2dcubismcore.min.js", import.meta.url), "utf8");
const context = {
  atob, setTimeout, clearTimeout, ArrayBuffer, Uint8Array,
  console: { log() {}, warn() {}, error() {} }
};
runInNewContext(source, context, { filename: "bundled-live2dcubismcore.min.js", timeout: 15000 });
const core = context.Live2DCubismCore;
const deadline = Date.now() + 15000;
for (;;) {
  try { if (core?.Version.csmGetVersion()) break; } catch { /* Embedded WebAssembly is still compiling. */ }
  if (Date.now() > deadline) throw new Error("Bundled Cubism Core did not initialize");
  await new Promise((resolve) => setTimeout(resolve, 20));
}

export function validateLive2DMoc(avatar) {
  const assets = live2DAssets(avatar.package);
  try {
    const description = assets.json(avatar.package.model);
    const bytes = assets.read(description.FileReferences.Moc, avatar.package.model);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    if (core.Moc.prototype.hasMocConsistency(buffer) !== 1)
      throw new ServiceError(422, "模型 .moc3 已损坏或超出当前 Cubism 运行库支持范围，原形象保留。");
  } finally { assets.dispose(); }
}
