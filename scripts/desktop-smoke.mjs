import { spawn } from "node:child_process";
import { mkdir, readFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import electron from "electron";
import { davFixture } from "../tests/fixtures/dav.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const artifacts = join(root, "artifacts");
await mkdir(artifacts, { recursive: true });
const executableIndex = process.argv.indexOf("--executable");
if (executableIndex !== -1 && (!process.argv[executableIndex + 1] || process.argv[executableIndex + 1].startsWith("--"))) {
  throw new Error("--executable 需要一个已安装的 NIRIA.exe 路径。");
}
const executableOverride = executableIndex === -1 ? null : resolve(process.argv[executableIndex + 1]);
const packaged = !!executableOverride || process.argv.includes("--packaged");
async function run(phase, dataDirectory, baseUrl = "") {
  const resultFile = join(artifacts, `desktop-smoke-${phase}-${Date.now()}.json`);
  const child = spawn(executableOverride || (packaged ? join(root, "release", "win-unpacked", "NIRIA.exe") : electron), packaged ? ["--smoke"] : [".", "--smoke"], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NIRIA_DESKTOP_DATA_DIR: dataDirectory, NIRIA_SMOKE_PHASE: phase,
      NIRIA_SMOKE_RESULT: resultFile, NIRIA_SMOKE_SCREENSHOT: join(artifacts, phase.startsWith("live2d-real") ? "live2d-real-desktop.png" : "companion-desktop.png"),
      NIRIA_SMOKE_DAV: baseUrl, NIRIA_LIVE2D_MODEL_DIR: process.env.NIRIA_LIVE2D_MODEL_DIR ||
        join(artifacts, "cubism-sdk-5-r5/CubismSdkForWeb-5-r.5/Samples/Resources/Haru") }
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output += chunk; });
  const timeout = setTimeout(() => child.kill(), phase.startsWith("live2d-real") ? 120000 : 45000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0, output);
    const result = JSON.parse(await readFile(resultFile, "utf8"));
    assert.equal(result.ok, true, JSON.stringify(result));
    return result;
  } finally { clearTimeout(timeout); }
}
if (process.argv.includes("--live2d-real")) {
  const directory = join(artifacts, `live2d-real-restart-${Date.now()}`);
  const phases = [], live2dDav = await davFixture();
  try {
    for (const phase of ["live2d-real-write", "live2d-real-read"]) phases.push(await run(phase, directory, live2dDav.baseUrl));
    assert.ok(live2dDav.objects.size > 0);
    for (const object of live2dDav.objects.values())
      assert.equal(object.data.toString().includes("FileReferences"), false, "remote object contains encrypted model data");
  } finally { await live2dDav.close(); }
  console.log(JSON.stringify({ packaged, phases }, null, 2));
} else {
const windows = await run("windows", join(artifacts, `desktop-data-${Date.now()}`));
const credentialsDirectory = join(artifacts, `credential-restart-${Date.now()}`);
const credentials = [];
for (const phase of ["credential-write", "credential-read", "credential-empty"]) credentials.push(await run(phase, credentialsDirectory));
const layoutDirectory = join(artifacts, `layout-restart-${Date.now()}`);
const layout = [];
for (const phase of ["layout-write", "layout-read", "layout-hidden"]) layout.push(await run(phase, layoutDirectory));
const rotationDirectory = join(artifacts, `rotation-restart-${Date.now()}`);
const rotation = [], dav = await davFixture();
try {
  for (const phase of ["rotation-write", "rotation-read", "rotation-pending", "rotation-recover", "rotation-restored"]) {
    const before = dav.calls.length;
    const result = await run(phase, rotationDirectory, dav.baseUrl);
    if (phase === "rotation-recover") assert.ok(dav.calls.slice(before).every((call) => call.method === "GET"), "interrupted rotation recovery must be read-only");
    rotation.push(result);
  }
} finally { await dav.close(); }
const upgrade = [];
for (const [flag, file, version] of [
  ["--upgrade", "storage-upgrade-fixture.json", "0.7.0"],
  ["--upgrade-v2", "storage-v2-upgrade-fixture.json", "0.14.0"]
]) {
  if (!process.argv.includes(flag)) continue;
  const fixture = JSON.parse(await readFile(join(artifacts, file), "utf8"));
  assert.equal(fixture.oldVersion, version);
  const directory = join(artifacts, `storage-native-upgrade-${Date.now()}`);
  await mkdir(directory, { recursive: true });
  for (const filename of ["companion.sqlite", "upgrade-expected.json", "legacy-backup.niria"]) {
    await copyFile(join(fixture.dataDirectory, filename), join(directory, filename));
  }
  upgrade.push(await run("storage-upgrade", directory));
  const downgrade = spawn(process.execPath, ["--input-type=module", "-e", `
    import { pathToFileURL } from "node:url";
    const { CompanionStore } = await import(pathToFileURL(process.argv[1]));
    let blocked = false;
    try { const store = new CompanionStore(process.argv[2]); store.close(); }
    catch (error) { blocked = /不受支持|较新版本/.test(error.message); }
    console.log(JSON.stringify({ downgradeBlocked: blocked }));
    process.exitCode = blocked ? 0 : 1;
  `, join(fixture.dataDirectory, "..", "legacy-runtime", "core", "store.mjs"), join(directory, "companion.sqlite")], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
  });
  let downgradeOutput = "";
  for (const stream of [downgrade.stdout, downgrade.stderr]) stream.on("data", (chunk) => { downgradeOutput += chunk; });
  const downgradeCode = await new Promise((resolve, reject) => { downgrade.once("error", reject); downgrade.once("exit", resolve); });
  assert.equal(downgradeCode, 0, downgradeOutput);
  upgrade.push({ phase: "old-runtime-downgrade", oldVersion: fixture.oldVersion, downgradeBlocked: true });
  upgrade.push(await run("storage-restart", directory));
}
console.log(JSON.stringify({ windows, credentials, layout, rotation, upgrade }, null, 2));
}
