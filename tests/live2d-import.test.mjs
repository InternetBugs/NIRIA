import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LIVE2D_LIMITS, live2DPath, listLive2DModels, prepareLive2DImport, inspectLive2DImport } from "../prototype/public/live2d-import.js";
import { live2DRuntimeInfo } from "../prototype/public/live2d-runtime.js";

const texture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
function file(path, data) {
  const value = new File([typeof data === "object" && !ArrayBuffer.isView(data) ? JSON.stringify(data) : data], path.split("/").at(-1));
  Object.defineProperty(value, "webkitRelativePath", { value: path });
  return value;
}
function fixture(change) {
  const model = { Version: 3, FileReferences: { Moc: "character.moc3", Textures: ["textures/texture_00.png"],
    Physics: "character.physics3.json", Expressions: [{ Name: "微笑", File: "expressions/smile.exp3.json" }],
    Motions: { Idle: [{ File: "motions/idle.motion3.json", Sound: "audio/unused.wav" }] } } };
  change?.(model);
  return [
    file("角色/character.model3.json", model),
    file("角色/character.moc3", Buffer.concat([Buffer.from("MOC3"), Buffer.alloc(12)])),
    file("角色/textures/texture_00.png", texture),
    file("角色/character.physics3.json", { Version: 3 }),
    file("角色/expressions/smile.exp3.json", { Type: "Live2D Expression", Parameters: [] }),
    file("角色/motions/idle.motion3.json", { Version: 3, Curves: [] })
  ];
}

test("Live2D import packages declared local assets with Chinese paths and unchanged bytes", async () => {
  const files = fixture();
  assert.deepEqual(listLive2DModels(files), ["角色/character.model3.json"]);
  const value = await prepareLive2DImport(files);
  const summary = inspectLive2DImport(value);
  assert.equal(summary.files, 6);
  assert.deepEqual(summary.expressions, [{ name: "微笑", path: "角色/expressions/smile.exp3.json" }]);
  assert.deepEqual(summary.motions, [{ group: "Idle", index: 0, path: "角色/motions/idle.motion3.json" }]);
  assert.equal(summary.ignoredSounds, 1);
  assert.deepEqual(Buffer.from(value.files.find((asset) => asset.path.endsWith(".png")).data, "base64"), texture);
  assert.deepEqual(inspectLive2DImport(JSON.parse(JSON.stringify(value))), summary);
});

test("unreferenced scripts, audio, credentials and other models are never read or packaged", async () => {
  let reads = 0;
  const files = fixture();
  for (const path of ["角色/private.env", "角色/injected.js", "角色/audio/unused.wav"]) {
    const ignored = file(path, "DO-NOT-IMPORT");
    ignored.arrayBuffer = () => { reads++; throw new Error("must not read"); };
    files.push(ignored);
  }
  const value = await prepareLive2DImport(files);
  assert.equal(reads, 0);
  assert.equal(value.files.length, 6);
  assert.equal(JSON.stringify(value).includes("private.env"), false);
});

test("multiple model descriptions require selection and only the selected model is read", async () => {
  const files = fixture();
  const other = file("其他/other.model3.json", "not valid JSON");
  other.arrayBuffer = () => { throw new Error("must not read another model"); };
  files.push(other);
  assert.equal(listLive2DModels(files).length, 2);
  await assert.rejects(prepareLive2DImport(files), /多个模型/);
  assert.equal((await prepareLive2DImport(files, { modelPath: "角色/character.model3.json" })).files.length, 6);
  await assert.rejects(prepareLive2DImport(files, { modelPath: "missing.model3.json" }), /不在/);
});

test("missing referenced files stop import before reading any available model asset", async () => {
  let reads = 0;
  const files = fixture().filter((entry) => !entry.name.endsWith(".png"));
  files.find((entry) => entry.name.endsWith(".moc3")).arrayBuffer = () => { reads++; throw new Error(); };
  await assert.rejects(prepareLive2DImport(files), /缺少引用的文件/);
  assert.equal(reads, 0);
});

test("Live2D references reject external URLs, absolute paths and folder escapes", async () => {
  for (const path of ["https://example.invalid/model.moc3", "file:///C:/private.moc3", "/absolute.moc3",
    "C:\\private.moc3", "\\\\server\\share\\model.moc3", "../../outside.moc3", "%2e%2e/private.moc3",
    "character.moc3?token=secret", "character.moc3#fragment"]) {
    await assert.rejects(prepareLive2DImport(fixture((model) => { model.FileReferences.Moc = path; })), /相对路径|超出/);
  }
  assert.equal(live2DPath("../shared/model.moc3", "folder/character.model3.json"), "shared/model.moc3");
});

test("case and normalization collisions cannot silently choose a different resource", async () => {
  const files = fixture();
  files.push(file("角色/TEXTURES/texture_00.PNG", texture));
  await assert.rejects(prepareLive2DImport(files), /重复/);
  assert.throws(() => listLive2DModels([file("A/e\u0301.model3.json", "{}"), file("A/é.model3.json", "{}")]), /重复/);
});

test("bad model schema, texture declarations, duplicate expressions and motion metadata fail locally", async () => {
  for (const change of [
    (model) => { model.Version = 2; },
    (model) => { model.FileReferences.Textures = []; },
    (model) => { model.FileReferences.Textures = ["texture.svg"]; },
    (model) => { model.FileReferences.Expressions.push({ ...model.FileReferences.Expressions[0] }); },
    (model) => { model.FileReferences.Motions.Idle[0].FadeInTime = -1; },
    (model) => { model.FileReferences.Motions.Idle = {}; },
    (model) => { model.FileReferences.Physics = "injected.js"; }
  ]) await assert.rejects(prepareLive2DImport(fixture(change)));
  await assert.rejects(prepareLive2DImport([file("legacy.model.json", "{}")]), /没有 .model3.json/);
});

test("declared byte budgets are checked before loading large assets", async () => {
  let reads = 0;
  const files = fixture();
  const moc = files.find((entry) => entry.name.endsWith(".moc3"));
  Object.defineProperty(moc, "size", { value: LIVE2D_LIMITS.assetBytes + 1 });
  moc.arrayBuffer = () => { reads++; throw new Error(); };
  await assert.rejects(prepareLive2DImport(files), /大小上限/);
  assert.equal(reads, 0);
});

test("the total resource budget rejects multiple allowed-size files before reading them", async () => {
  let reads = 0;
  const files = fixture();
  for (const entry of files.filter((value) => value.name.endsWith(".moc3") || value.name.endsWith(".png"))) {
    Object.defineProperty(entry, "size", { value: LIVE2D_LIMITS.assetBytes });
    entry.arrayBuffer = () => { reads++; throw new Error("must not read oversized group"); };
  }
  await assert.rejects(prepareLive2DImport(files), /总大小/);
  assert.equal(reads, 0);
});

test("moc magic, PNG dimensions and UTF-8 JSON are checked without claiming runtime compatibility", async () => {
  const replace = (path, bytes) => fixture().map((entry) => entry.webkitRelativePath === path ? file(path, bytes) : entry);
  await assert.rejects(prepareLive2DImport(replace("角色/character.moc3", Buffer.from("bad-moc"))), /MOC3/);
  const tooWide = Buffer.from(texture);
  tooWide.writeUInt32BE(100_000, 16);
  await assert.rejects(prepareLive2DImport(replace("角色/textures/texture_00.png", tooWide)), /尺寸/);
  await assert.rejects(prepareLive2DImport(replace("角色/character.physics3.json", "{bad")), /JSON/);
  await assert.rejects(prepareLive2DImport(replace("角色/character.physics3.json", Buffer.from([0xff, 0xfe]))), /UTF-8/);
});

test("realistic sized binary resources round trip without recursive base64 regex limits", async () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 91);
  bytes.write("MOC3", 0);
  const files = fixture().map((entry) => entry.name.endsWith(".moc3") ? file(entry.webkitRelativePath, bytes) : entry);
  const value = await prepareLive2DImport(files);
  assert.equal(inspectLive2DImport(value).files, 6);
  assert.deepEqual(Buffer.from(value.files.find((asset) => asset.path.endsWith(".moc3")).data, "base64"), bytes);
});

test("combined texture allocation and changing file sizes stop preparation", async () => {
  const files = fixture((model) => {
    model.FileReferences.Textures = ["large-1.png", "large-2.png", "large-3.png"];
  }).filter((entry) => !entry.name.endsWith(".png"));
  const large = Buffer.from(texture);
  large.writeUInt32BE(8192, 16); large.writeUInt32BE(4096, 20);
  for (const name of ["large-1.png", "large-2.png", "large-3.png"]) files.push(file(`角色/${name}`, large));
  await assert.rejects(prepareLive2DImport(files), /总像素/);
  const changing = fixture();
  const moc = changing.find((entry) => entry.name.endsWith(".moc3"));
  moc.arrayBuffer = async () => new ArrayBuffer(18);
  await assert.rejects(prepareLive2DImport(changing), /发生变化/);
});

test("cancellation before and during reading discards the prepared import", async () => {
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(prepareLive2DImport(fixture(), { signal: cancelled.signal }), { name: "AbortError" });
  const controller = new AbortController(), files = fixture();
  const moc = files.find((entry) => entry.name.endsWith(".moc3")), read = moc.arrayBuffer.bind(moc);
  moc.arrayBuffer = async () => { controller.abort(); return read(); };
  await assert.rejects(prepareLive2DImport(files, { signal: controller.signal }), { name: "AbortError" });
});

test("prepared bundle validation rejects missing, extra, duplicate, malformed and future data", async () => {
  const valid = await prepareLive2DImport(fixture());
  for (const change of [
    (value) => { value.version = 2; },
    (value) => { value.files.pop(); },
    (value) => { value.files.push({ path: "injected.js", data: btoa("script") }); },
    (value) => { value.files.push({ ...value.files[0] }); },
    (value) => { value.files[1].data = "####"; },
    (value) => { value.files[1].path = "../outside.moc3"; },
    (value) => { value.files[1].data = btoa("bad-moc"); },
    (value) => { value.credentials = "not an asset"; },
    (value) => { value.files[0].secret = "not an asset"; }
  ]) {
    const changed = structuredClone(valid); change(changed);
    assert.throws(() => inspectLive2DImport(changed));
  }
});

test("the read-only CLI inspects an actual folder with spaces and Chinese names without changing any bytes", async (t) => {
  const prefix = join(tmpdir(), "niria-live2d-");
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  });
  const modelDirectory = join(directory, "导入检查 Model");
  const files = fixture();
  for (const entry of files) {
    const target = join(modelDirectory, entry.webkitRelativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await entry.arrayBuffer()));
  }
  const { stdout } = await promisify(execFile)(process.execPath, ["scripts/inspect-live2d.mjs", modelDirectory], {
    windowsHide: true, timeout: 10000, encoding: "utf8"
  });
  const summary = JSON.parse(stdout);
  assert.equal(summary.directory, "导入检查 Model");
  assert.equal(summary.files, 6);
  assert.equal(summary.playbackVerified, false);
  assert.equal(summary.runtimeIntegrated, live2DRuntimeInfo.available);
  assert.equal(stdout.includes("base64"), false);
  for (const entry of files)
    assert.deepEqual(await readFile(join(modelDirectory, entry.webkitRelativePath)), Buffer.from(await entry.arrayBuffer()));
});
