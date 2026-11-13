// Import preparation only. No model code is executed and no network/filesystem
// access is performed here. Playback must validate the moc with its runtime too.
export const LIVE2D_LIMITS = Object.freeze({
  selectedFiles: 2000, assets: 512, totalBytes: 32 * 1024 * 1024,
  assetBytes: 16 * 1024 * 1024, jsonBytes: 2 * 1024 * 1024,
  texturePixels: 32 * 1024 * 1024, totalTexturePixels: 64 * 1024 * 1024, textureSide: 8192
});
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const fail = (message) => { throw new Error(message); };
const decoder = new TextDecoder("utf-8", { fatal: true });

function pathSegments(value) {
  if (typeof value !== "string" || !value || value.length > 1000 ||
      /[\u0000-\u001f\u007f:?#%]/.test(value) || /^[\\/]/.test(value))
    fail("模型资源必须使用所选文件夹内的相对路径。");
  return value.normalize("NFC").replaceAll("\\", "/").split("/");
}
export function live2DPath(value, relativeTo = "") {
  const parts = relativeTo ? pathSegments(relativeTo).slice(0, -1) : [];
  for (const part of pathSegments(value)) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) fail("模型资源路径超出了所选文件夹。");
      parts.pop();
    } else {
      if (/[. ]$/.test(part)) fail("模型资源文件名不能以空格或句点结尾。");
      parts.push(part);
    }
  }
  if (!parts.length) fail("模型资源路径无效。");
  return parts.join("/");
}
function indexFiles(files) {
  const selected = Array.from(files || []);
  if (!selected.length || selected.length > LIVE2D_LIMITS.selectedFiles) fail("请选择完整模型文件夹，最多 2000 个文件。");
  const index = new Map(), insensitive = new Set();
  for (const file of selected) {
    const path = live2DPath(file.webkitRelativePath || file.name);
    const folded = path.toLowerCase();
    if (insensitive.has(folded)) fail("模型文件存在重复或仅大小写不同的路径。");
    if (!Number.isSafeInteger(file.size) || file.size < 0 || typeof file.arrayBuffer !== "function")
      fail("模型文件无法读取。");
    insensitive.add(folded);
    index.set(path, file);
  }
  return index;
}
export function listLive2DModels(files) {
  return [...indexFiles(files).keys()].filter((path) => /\.model3\.json$/i.test(path)).sort();
}
function jsonValue(bytes, label) {
  if (bytes.byteLength > LIVE2D_LIMITS.jsonBytes) fail(`${label}超过 JSON 文件大小上限。`);
  try {
    const parsed = JSON.parse(decoder.decode(bytes).replace(/^\uFEFF/, ""));
    if (!object(parsed)) throw new Error();
    return parsed;
  } catch { fail(`${label}不是有效的 UTF-8 JSON 对象。`); }
}
function references(model, modelPath) {
  if (model.Version !== 3 || !object(model.FileReferences))
    fail("当前导入方案需要 Version 3 的 .model3.json 模型描述。");
  const ref = model.FileReferences;
  if (!Array.isArray(ref.Textures) || !ref.Textures.length || ref.Textures.length > 32)
    fail("模型描述需要包含 1 到 32 张纹理。");
  const assets = new Map([[modelPath, "model"]]);
  const add = (value, kind, suffix) => {
    const path = live2DPath(value, modelPath);
    if (!suffix.test(path)) fail("模型资源扩展名与声明类型不符。");
    if (assets.has(path) && assets.get(path) !== kind) fail("同一模型资源不能声明为不同类型。");
    assets.set(path, kind);
    if (assets.size > LIVE2D_LIMITS.assets) fail("模型引用的资源超过 512 个。");
    return path;
  };
  add(ref.Moc, "moc", /\.moc3$/i);
  const textures = new Set();
  for (const texture of ref.Textures) {
    const path = add(texture, "texture", /\.png$/i);
    if (textures.has(path)) fail("模型纹理列表包含重复路径。");
    textures.add(path);
  }
  for (const [key, suffix] of [
    ["Physics", /\.physics3\.json$/i], ["Pose", /\.pose3\.json$/i],
    ["UserData", /\.userdata3\.json$/i], ["DisplayInfo", /\.cdi3\.json$/i]
  ]) if (Object.hasOwn(ref, key)) add(ref[key], "json", suffix);
  const expressions = [];
  if (Object.hasOwn(ref, "Expressions")) {
    if (!Array.isArray(ref.Expressions) || ref.Expressions.length > 128) fail("模型表情列表无效或超过上限。");
    const names = new Set();
    for (const expression of ref.Expressions) {
      if (!object(expression) || typeof expression.Name !== "string" || !expression.Name.trim() ||
          expression.Name.length > 150 || names.has(expression.Name)) fail("模型表情名称无效或重复。");
      names.add(expression.Name);
      expressions.push({ name: expression.Name, path: add(expression.File, "json", /\.exp3\.json$/i) });
    }
  }
  const motions = [];
  let ignoredSounds = 0;
  if (Object.hasOwn(ref, "Motions")) {
    if (!object(ref.Motions) || Object.keys(ref.Motions).length > 64) fail("模型动作分组无效或超过上限。");
    for (const [group, entries] of Object.entries(ref.Motions)) {
      if (!group.trim() || group.length > 150 || !Array.isArray(entries) || entries.length > 128)
        fail("模型动作分组无效或超过上限。");
      entries.forEach((motion, index) => {
        if (!object(motion)) fail("模型动作描述无效。");
        for (const key of ["FadeInTime", "FadeOutTime"])
          if (Object.hasOwn(motion, key) && (!Number.isFinite(motion[key]) || motion[key] < 0 || motion[key] > 60))
            fail("模型动作淡入淡出时间无效。");
        motions.push({ group, index, path: add(motion.File, "json", /\.motion3\.json$/i) });
        if (Object.hasOwn(motion, "Sound")) ignoredSounds++;
      });
    }
  }
  return { assets, expressions, motions, ignoredSounds };
}
function validateAsset(bytes, kind) {
  if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > LIVE2D_LIMITS.assetBytes)
    fail("模型资源为空或超过单文件 16 MB 上限。");
  if (kind === "model" || kind === "json") jsonValue(bytes, "模型描述或动作资源");
  if (kind === "moc" && (bytes.length < 16 || String.fromCharCode(...bytes.subarray(0, 4)) !== "MOC3"))
    fail("模型二进制没有有效的 MOC3 文件头，需运行库继续验证内容。");
  if (kind === "texture") {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value) ||
        String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") fail("模型纹理需要有效的 PNG 文件头。");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(16), height = view.getUint32(20);
    if (!width || !height || Math.max(width, height) > LIVE2D_LIMITS.textureSide || width * height > LIVE2D_LIMITS.texturePixels)
      fail("模型纹理尺寸超过当前导入上限。");
    return width * height;
  }
  return 0;
}
function encoded(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 32768)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(binary);
}
function decoded(value) {
  if (typeof value !== "string" || value.length % 4 || value.length > Math.ceil(LIVE2D_LIMITS.assetBytes / 3) * 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    fail("模型资源编码无效或超过上限。");
  const binary = atob(value);
  if (btoa(binary) !== value) fail("模型资源编码无效。");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
export async function prepareLive2DImport(files, { modelPath, signal } = {}) {
  signal?.throwIfAborted();
  const index = indexFiles(files);
  const candidates = [...index.keys()].filter((path) => /\.model3\.json$/i.test(path));
  if (!candidates.length) fail("所选文件夹中没有 .model3.json，请选择完整的导出模型文件夹。");
  if (!modelPath && candidates.length !== 1) fail("所选文件夹中有多个模型，请先指定一个 .model3.json。");
  const model = modelPath ? live2DPath(modelPath) : candidates[0];
  if (!candidates.includes(model)) fail("指定的模型不在所选文件夹中。");
  const source = index.get(model);
  if (source.size > LIVE2D_LIMITS.jsonBytes) fail("模型描述超过 2 MB 上限。");
  const modelBytes = new Uint8Array(await source.arrayBuffer());
  signal?.throwIfAborted();
  const layout = references(jsonValue(modelBytes, "模型描述"), model);
  let totalBytes = 0;
  // Check all declared sizes before reading any texture, moc or motion content.
  for (const [path, kind] of layout.assets) {
    const file = index.get(path);
    if (!file) fail(`模型缺少引用的文件：${path}`);
    if (!file.size || file.size > (kind === "model" || kind === "json" ? LIVE2D_LIMITS.jsonBytes : LIVE2D_LIMITS.assetBytes))
      fail("模型资源为空或超过文件大小上限。");
    totalBytes += file.size;
    if (totalBytes > LIVE2D_LIMITS.totalBytes) fail("模型引用的资源总大小超过 32 MB 上限。");
  }
  const assets = [];
  let texturePixels = 0;
  for (const [path, kind] of layout.assets) {
    signal?.throwIfAborted();
    const bytes = path === model ? modelBytes : new Uint8Array(await index.get(path).arrayBuffer());
    signal?.throwIfAborted();
    if (bytes.byteLength !== index.get(path).size) fail("模型文件在读取时发生变化。");
    texturePixels += validateAsset(bytes, kind);
    if (texturePixels > LIVE2D_LIMITS.totalTexturePixels) fail("模型纹理总像素超过当前导入上限。");
    assets.push({ path, data: encoded(bytes) });
  }
  return { format: "niria-live2d", version: 1, model, files: assets };
}
export function inspectLive2DImport(value) {
  if (!object(value) || Object.keys(value).some((key) => !["format", "version", "model", "files"].includes(key)) ||
      value.format !== "niria-live2d" || value.version !== 1 ||
      !Array.isArray(value.files) || !value.files.length || value.files.length > LIVE2D_LIMITS.assets)
    fail("Live2D 导入资料格式或版本无效。");
  const model = live2DPath(value.model);
  if (!/\.model3\.json$/i.test(model)) fail("Live2D 模型描述扩展名无效。");
  const index = new Map(), names = new Set();
  let totalBytes = 0;
  for (const file of value.files) {
    if (!object(file) || Object.keys(file).some((key) => !["path", "data"].includes(key))) fail("Live2D 资源记录无效。");
    const path = live2DPath(file.path);
    if (path !== file.path || names.has(path.toLowerCase())) fail("Live2D 资源路径重复或未规范化。");
    names.add(path.toLowerCase());
    const bytes = decoded(file.data);
    totalBytes += bytes.byteLength;
    if (totalBytes > LIVE2D_LIMITS.totalBytes) fail("模型引用的资源总大小超过 32 MB 上限。");
    index.set(path, bytes);
  }
  if (!index.has(model)) fail("Live2D 导入资料缺少模型描述。");
  const layout = references(jsonValue(index.get(model), "模型描述"), model);
  if (index.size !== layout.assets.size) fail("Live2D 导入资料包含未声明的额外文件。");
  let texturePixels = 0;
  for (const [path, kind] of layout.assets) {
    if (!index.has(path)) fail(`模型缺少引用的文件：${path}`);
    texturePixels += validateAsset(index.get(path), kind);
    if (texturePixels > LIVE2D_LIMITS.totalTexturePixels) fail("模型纹理总像素超过当前导入上限。");
  }
  return { model, files: index.size, totalBytes,
    expressions: layout.expressions, motions: layout.motions, ignoredSounds: layout.ignoredSounds };
}
