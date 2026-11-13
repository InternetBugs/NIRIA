import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { extractFile } from "@electron/asar";

const root = fileURLToPath(new URL("../", import.meta.url));
const directoryIndex = process.argv.indexOf("--directory");
if (directoryIndex !== -1 && (!process.argv[directoryIndex + 1] || process.argv[directoryIndex + 1].startsWith("--"))) {
  throw new Error("--directory 需要一个已安装的 NIRIA 目录。");
}
const directory = directoryIndex === -1 ? join(root, "release", "win-unpacked") : resolve(process.argv[directoryIndex + 1]);
const archive = join(directory, "resources", "app.asar");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const embedded = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[""].version, manifest.version);
assert.equal(embedded.version, manifest.version);
let count = 0;
async function compare(folder) {
  for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
    const relative = join(folder, entry.name);
    if (entry.isDirectory()) await compare(relative);
    else {
      assert.deepEqual(extractFile(archive, relative), await readFile(join(root, relative)), `Packaged file differs: ${relative}`);
      count++;
    }
  }
}
for (const folder of ["core", "desktop", "prototype"]) await compare(folder);
const installer = join(root, "release", `NIRIA Setup ${manifest.version}.exe`);
const details = await stat(installer);
console.log(JSON.stringify({ version: manifest.version, runtimeFiles: count, equalToSource: true, directory,
  installer, bytes: details.size, modifiedAt: details.mtime.toISOString() }, null, 2));
