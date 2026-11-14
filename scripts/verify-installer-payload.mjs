// Read the embedded 7z application payload; never execute the installer.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const build = JSON.parse(await readFile(join(root, "artifacts", `offline-build-${version}.json`), "utf8"));
const installer = join(root, "release", `NIRIA Setup ${version}.exe`);
assert.equal(build.version, version);
assert.equal(resolve(build.installer), installer);
async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
assert.equal(await sha256(installer), build.installerSha256, "Installer changed since offline build");
assert.equal(await sha256(build.sevenZip), build.sevenZipSha256, "Archive tool changed since offline build");
const artifacts = join(root, "artifacts");
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(join(artifacts, `installer-payload-${version}-`));
const files = ["resources/app.asar", "NIRIA.exe", "LICENSE.electron.txt", "LICENSES.chromium.html"];
const child = spawn(build.sevenZip, ["x", "-bd", installer, ...files.map((file) => file.replaceAll("/", "\\")),
  `-o${directory}`, "-y"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
assert.equal(code, 0, output);
const actual = [];
async function walk(folder, prefix = "") {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false);
    const relative = prefix + entry.name;
    if (entry.isDirectory()) await walk(join(folder, entry.name), relative + "/");
    else actual.push(relative);
  }
}
await walk(directory);
assert.deepEqual(actual.sort(), [...files].sort(), "Unexpected installer extraction results");
const compared = [];
for (const relative of files) {
  const hash = await sha256(join(directory, relative));
  assert.equal(hash, await sha256(join(root, "release", "win-unpacked", relative)), `Installer payload differs: ${relative}`);
  compared.push({ file: relative, sha256: hash.toUpperCase(), equalToDirectory: true });
}
console.log(JSON.stringify({
  version, installer, installerExecuted: false, extractedDirectory: directory, compared,
  equalsDirectoryArchive: true, equalsDirectoryExecutable: true, systemChanges: false
}, null, 2));
