// Reuse locally cached, checksum-verified tools. Never download or install an app.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { verifyNsisCrc } from "./nsis-integrity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
assert.equal(process.platform, "win32", "Offline packaging currently supports Windows x64 only");
assert.equal(process.arch, "x64", "Offline packaging currently supports Windows x64 only");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
for (const [name, version] of Object.entries({ electron: "45.3.1", "electron-builder": "26.18.0" })) {
  assert.equal(manifest.devDependencies[name], version, `Review offline integration before changing ${name}`);
  assert.equal(require(`${name}/package.json`).version, version);
  assert.equal(lock.packages[`node_modules/${name}`].version, version);
}
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages[""].version, manifest.version);
function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith("--"), `${name} needs a path`);
  return resolve(process.argv[index + 1]);
}
const builderCache = option("--builder-cache") || join(process.env.LOCALAPPDATA, "electron-builder", "Cache");
const electronChecksums = require("electron/checksums.json");
const electronName = "electron-v45.3.1-win32-x64.zip";
let electronZip = option("--electron-zip");
if (!electronZip) {
  const cache = join(process.env.LOCALAPPDATA, "electron", "Cache");
  for (const entry of await readdir(cache, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(cache, entry.name, electronName);
    if ((await stat(candidate).catch(() => null))?.isFile()) { electronZip = candidate; break; }
  }
}
assert.ok(electronZip, `No cached ${electronName}; provide --electron-zip. This script does not download it.`);
const inputs = [
  { name: "electron", path: electronZip, sha256: electronChecksums[electronName],
    checksumSource: "node_modules/electron/checksums.json" },
  { name: "7zip", path: join(builderCache, "7zip@1.0.0", "7zip-win-x64.tar.gz"),
    sha256: "be071f15bd6da2f78fe81c6ddef2009b0c4d8a51f36b780cb806c7e6df95e1b3",
    checksumSource: "app-builder-lib/out/toolsets/7zip.js" },
  { name: "nsis", path: join(builderCache, "nsis-3.0.4.1", "nsis-3.0.4.1.7z"),
    sha256: "9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa",
    checksumSource: "app-builder-lib/out/toolsets/windows.js" },
  { name: "nsis-resources", path: join(builderCache, "nsis-resources-3.4.1", "nsis-resources-3.4.1.7z"),
    sha256: "593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103",
    checksumSource: "app-builder-lib/out/toolsets/windows.js" }
];
async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
// Verify every archive before extracting or invoking any of its tools.
const verified = await Promise.all(inputs.map(async (input) => {
  assert.equal(await sha256(input.path), input.sha256, `Cached archive checksum mismatch: ${input.name}`);
  return { ...input, bytes: (await stat(input.path)).size, verified: true };
}));
console.log(`Verified ${verified.length} local archives; downloads are disabled.`);
const artifacts = join(root, "artifacts");
await mkdir(artifacts, { recursive: true });
const work = await mkdtemp(join(artifacts, "offline-build-"));
const zipDir = join(work, "7zip");
await mkdir(zipDir);
await require("tar").extract({ file: inputs[1].path, cwd: zipDir, strip: 1 });
const sevenZip = join(zipDir, "bin", "7za.exe");
async function run(file, args) {
  const child = spawn(file, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
  assert.equal(code, 0, output);
}
for (const input of inputs.slice(2)) {
  await run(sevenZip, ["x", "-bd", input.path, `-o${join(work, input.name)}`, "-y"]);
}
Object.assign(process.env, {
  ELECTRON_BUILDER_7ZIP_PATH: sevenZip,
  ELECTRON_BUILDER_NSIS_DIR: join(work, "nsis"),
  ELECTRON_BUILDER_NSIS_RESOURCES_DIR: join(work, "nsis-resources"),
  ELECTRON_BUILDER_CACHE: join(work, "cache"),
  CSC_IDENTITY_AUTO_DISCOVERY: "false"
});
// These are process-local guards; installed dependencies and global caches are unchanged.
const electronGet = require("app-builder-lib/out/util/electronGet.js");
for (const name of ["downloadBuilderToolset", "downloadElectronArtifactZip", "downloadElectronArtifact"]) {
  electronGet[name] = async () => { throw new Error(`Offline build refuses ${name}; provide all tools locally`); };
}
// Use the native BUILD_UNINSTALLER helper. The pinned UninstallerReader copies
// the installer stub without rebuilding the uninstaller CRC and produces an
// executable that passes payload comparison but cannot actually uninstall.
const { WineVmManager } = require("app-builder-lib/out/vm/WineVm.js");
const installer = join(root, "release", `NIRIA Setup ${manifest.version}.exe`);
const uninstaller = installer.slice(0, -3) + "__uninstaller.exe";
let generatedUninstallers = 0;
let uninstallerEvidence;
WineVmManager.prototype.exec = async function (file, args) {
  assert.equal(resolve(file), installer, "Offline build refuses unexpected VM executable");
  assert.deepEqual(args, [], "Offline build refuses unexpected VM arguments");
  assert.equal(generatedUninstallers, 0, "Unexpected repeat uninstaller generation");
  const helperDirectory = join(work, "uninstaller-generator");
  await mkdir(helperDirectory);
  // /D= is consumed by NSIS itself before .onInit; keep SetOutPath in artifacts.
  // BUILD_UNINSTALLER writes only the compiled uninstaller and quits.
  await run(file, [`/D=${helperDirectory}`]);
  const savedUninstaller = join(work, "native-uninstaller.exe");
  await copyFile(uninstaller, savedUninstaller);
  uninstallerEvidence = { ...verifyNsisCrc(await readFile(uninstaller), { uninstaller: true }),
    sha256: await sha256(uninstaller), file: savedUninstaller, nativeGenerated: true, helperDirectory };
  generatedUninstallers++;
  console.log("Generated build-time uninstaller with native NSIS helper; CRC verified.");
  return "";
};
const { build, Platform, Arch } = require("electron-builder");
const files = await build({
  projectDir: root, targets: Platform.WINDOWS.createTarget(["nsis"], Arch.x64), publish: "never",
  config: {
    electronDist: electronZip, npmRebuild: false,
    afterExtract: async ({ appOutDir }) => {
      assert.equal(resolve(appOutDir), join(root, "release", "win-unpacked"));
      // An explicit electronDist retains these stock Electron files by default.
      await unlink(join(appOutDir, "resources", "default_app.asar"));
      await unlink(join(appOutDir, "version"));
    }
  }
});
assert.equal(generatedUninstallers, 1);
assert.ok(files.includes(installer));
const installerIntegrity = verifyNsisCrc(await readFile(installer));
const evidence = {
  version: manifest.version, createdAt: new Date().toISOString(), work, inputs: verified,
  downloadsDisabled: true, applicationInstalled: false, installerExecuted: true,
  buildTimeUninstallerParsed: false, buildTimeUninstallerNativeGenerated: true,
  installerIntegrity, uninstaller: uninstallerEvidence,
  installer, installerSha256: await sha256(installer), sevenZip, sevenZipSha256: await sha256(sevenZip)
};
const evidenceFile = join(artifacts, `offline-build-${manifest.version}.json`);
await writeFile(evidenceFile, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ installer, installerSha256: evidence.installerSha256, evidenceFile }, null, 2));
