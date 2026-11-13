import { live2DRuntimeInfo } from "./live2d-runtime-info.js";
export { live2DRuntimeInfo };

// Kept lazy so Node can import the availability information and image-only
// windows do not load Core, WebGL, or any model resource.
export async function createLive2DRuntime(options) {
  options.signal?.throwIfAborted();
  if (!live2DRuntimeInfo.available) throw new Error(live2DRuntimeInfo.message);
  const { createCubismRuntime } = await import("./live2d-adapter.js");
  options.signal?.throwIfAborted();
  return createCubismRuntime(options);
}
