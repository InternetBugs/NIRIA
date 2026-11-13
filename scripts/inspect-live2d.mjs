import { readdir, stat, lstat, readFile } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { LIVE2D_LIMITS, listLive2DModels, prepareLive2DImport, inspectLive2DImport } from "../prototype/public/live2d-import.js";
import { live2DRuntimeInfo } from "../prototype/public/live2d-runtime.js";

if (process.argv[2] === "--help") {
  console.log("用法：node scripts/inspect-live2d.mjs <模型文件夹> [相对的.model3.json路径]\n只读检查本机文件并输出资源摘要；不播放、不上传、不修改伴侣。");
} else {
  try {
    if (!process.argv[2]) throw new Error("请指定模型文件夹；使用 --help 查看用法。");
    const directory = resolve(process.argv[2]);
    const root = await lstat(directory);
    if (root.isSymbolicLink()) throw new Error("只读检查不跟随符号链接，请选择直接包含模型资源的文件夹。");
    if (!root.isDirectory()) throw new Error("请选择模型文件夹。");
    const files = [];
    let directories = 0;
    async function collect(folder, prefix = "") {
      if (++directories > LIVE2D_LIMITS.selectedFiles) throw new Error("所选文件夹包含过多目录。");
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const absolute = join(folder, entry.name), relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) throw new Error("只读检查不跟随符号链接，请选择直接包含模型资源的文件夹。");
        if (entry.isDirectory()) await collect(absolute, relative);
        else if (entry.isFile()) {
          if (files.length >= LIVE2D_LIMITS.selectedFiles) throw new Error("所选文件夹超过 2000 个文件。");
          const details = await stat(absolute);
          files.push({ name: entry.name, webkitRelativePath: relative, size: details.size, arrayBuffer: async () => {
            const bytes = await readFile(absolute);
            return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
          } });
        }
      }
    }
    await collect(directory);
    const candidates = listLive2DModels(files);
    const bundle = await prepareLive2DImport(files, { modelPath: process.argv[3] });
    console.log(JSON.stringify({ directory: basename(directory), candidates,
      ...inspectLive2DImport(bundle), playbackVerified: false, runtimeIntegrated: live2DRuntimeInfo.available }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "模型检查未完成。");
    process.exitCode = 1;
  }
}
