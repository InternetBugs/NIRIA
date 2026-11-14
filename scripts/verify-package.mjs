import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { extractFile, listPackage, statFile } from "@electron/asar";
import { verifyNsisCrc } from "./nsis-integrity.mjs";

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
const expected = new Set(["package.json"]);
async function compare(folder) {
  for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
    const relative = join(folder, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `Runtime source must be a regular file or directory: ${relative}`);
    if (entry.isDirectory()) await compare(relative);
    else {
      assert.deepEqual(extractFile(archive, relative), await readFile(join(root, relative)), `Packaged file differs: ${relative}`);
      expected.add(relative.replaceAll("\\", "/"));
      count++;
    }
  }
}
for (const folder of ["core", "desktop", "prototype"]) await compare(folder);
// Comparing expected files alone misses obsolete or accidentally bundled files.
const actual = new Set();
for (const path of listPackage(archive)) {
  const relative = path.replace(/^[\\/]+/, "").replaceAll("\\", "/");
  const entry = statFile(archive, join(...relative.split("/")), false);
  assert.equal("link" in entry, false, `Unexpected archive link: ${relative}`);
  assert.notEqual(entry.unpacked, true, `Unexpected unpacked runtime entry: ${relative}`);
  if (!("files" in entry)) actual.add(relative);
}
assert.deepEqual([...actual].sort(), [...expected].sort(), "Packaged file set differs from runtime source");
async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex").toUpperCase();
}
const installer = join(root, "release", `NIRIA Setup ${manifest.version}.exe`);
const details = await stat(installer);
const installerIntegrity = verifyNsisCrc(await readFile(installer));
let uninstaller;
if (directoryIndex !== -1) {
  const file = join(directory, "Uninstall NIRIA.exe");
  const build = JSON.parse(await readFile(join(root, "artifacts", `offline-build-${manifest.version}.json`), "utf8"));
  uninstaller = { ...verifyNsisCrc(await readFile(file), { uninstaller: true }), sha256: await sha256(file) };
  assert.equal(uninstaller.sha256.toLowerCase(), build.uninstaller.sha256, "Installed uninstaller differs from native build output");
}
console.log(JSON.stringify({ version: manifest.version, runtimeFiles: count, equalToSource: true, directory,
  exactFileSet: true, totalArchiveFiles: actual.size, archiveSha256: await sha256(archive),
  installer, bytes: details.size, installerSha256: await sha256(installer), installerIntegrity, uninstaller,
  modifiedAt: details.mtime.toISOString() }, null, 2));
