import { findAlignment } from "./image-analysis.js";
import { removeEdgeBackground } from "./image-background.js";
import { animeGray, detectAnimeFaces } from "./animeface.js";

let faceModel;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === "faces") {
      faceModel ||= fetch(new URL("./vendor/animeface/model.json", import.meta.url)).then((response) => {
        if (!response.ok) throw new Error();
        return response.json();
      });
      const model = await faceModel, { width, height } = data.pixels;
      self.postMessage({ result: { faces: detectAnimeFaces(animeGray(data.pixels), width, height, model) } });
      return;
    }
    const result = data.type === "background" ? removeEdgeBackground(data.pixels) : findAlignment(data.reference, data.target);
    self.postMessage({ result }, data.type === "background" ? [result.data.buffer] : []);
  } catch { self.postMessage({ error: data.type === "faces" ? "本机人脸检查未完成，请在预览中确认人物。" :
    data.type === "background" ? "无法处理这张图片的背景。" : "无法比较这组素材的位置。" }); }
};
