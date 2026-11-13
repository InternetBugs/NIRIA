import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CompanionStore, validateAvatar } from "../core/store.mjs";
import { CompanionService, buildContext } from "../core/chat-service.mjs";
import { adoptLive2D } from "../core/live2d-adoption.mjs";
import { expressionOptions } from "../core/expression.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";
import { live2DRuntimeInfo } from "../prototype/public/live2d-runtime.js";
import { expressionFor } from "../prototype/public/avatar-player.js";
import { live2DAvatar } from "../prototype/public/live2d-avatar.js";
import { live2DAssets } from "../prototype/public/live2d-assets.js";
import { live2DFixture, live2DAvatarFixture } from "./fixtures/live2d.mjs";
import { davFixture } from "./fixtures/dav.mjs";

function setup(t) {
  const store = new CompanionStore();
  t.after(() => store.close());
  return store;
}
const setAvatar = (store, avatar) => store.mutate((state) => { state.avatar = validateAvatar(avatar); });
const imageAvatar = () => ({ format: "niria-avatar-prototype", version: 1, actions: {},
  source: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" });

test("Live2D state validates expression and motion bindings and returns an independent copy", () => {
  const source = live2DAvatarFixture();
  const accepted = validateAvatar(source);
  assert.deepEqual(accepted, source);
  accepted.bindings.expressions.smile = "害羞";
  assert.equal(source.bindings.expressions.smile, "微笑");
  assert.deepEqual(live2DAvatar(live2DFixture()).bindings, { idleGroup: null, expressions: {} });
  for (const change of [
    (value) => { value.version = 2; },
    (value) => { value.bindings.idleGroup = "missing"; },
    (value) => { value.bindings.expressions.smile = "missing"; },
    (value) => { value.bindings.expressions.other = "微笑"; },
    (value) => { value.bindings.autoplayAudio = true; },
    (value) => { value.credentials = "not a model"; }
  ]) {
    const invalid = structuredClone(source); change(invalid);
    assert.throws(() => validateAvatar(invalid), (error) => error.status === 400);
  }
});

test("changing Live2D bindings updates the avatar key without changing identity, chat or memory", (t) => {
  const store = setup(t);
  const user = store.addUser("既有的共同经历");
  store.addMemory({ content: "既有记忆", sources: [{ id: user.id, revision: 1 }] });
  const identity = structuredClone(store.state.identity), messages = structuredClone(store.state.messages), memories = structuredClone(store.state.memories);
  setAvatar(store, live2DAvatarFixture());
  const key = store.avatarKey;
  const changed = structuredClone(store.state.avatar);
  changed.bindings.expressions.smile = "害羞";
  setAvatar(store, changed);
  assert.notEqual(store.avatarKey, key);
  assert.deepEqual(store.state.identity, identity);
  assert.deepEqual(store.state.messages, messages);
  assert.deepEqual(store.state.memories, memories);
  assert.equal(Object.hasOwn(store.clientSnapshot({ assets: false }), "avatar"), false);
});

test("SQLite reopening preserves the entire Live2D package, bindings and same companion", async (t) => {
  const prefix = join(tmpdir(), "niria-live2d-state-"), directory = await mkdtemp(prefix);
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(prefix))); await rm(directory, { recursive: true, force: true }); });
  const path = join(directory, "companion.sqlite");
  const first = new CompanionStore(path), avatar = live2DAvatarFixture();
  const identityId = first.state.identity.id;
  setAvatar(first, avatar); first.close();
  const second = new CompanionStore(path);
  try {
    assert.equal(second.state.identity.id, identityId);
    assert.deepEqual(second.state.avatar, avatar);
    assert.equal(second.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally { second.close(); }
});

test("a failed Live2D persistence transaction retains the previous image and synchronization graph", (t) => {
  const store = setup(t), sync = new SyncService(store);
  setAvatar(store, imageAvatar());
  sync.createPair();
  const before = store.exportData(), key = store.avatarKey;
  store.db.exec("CREATE TEMP TRIGGER reject_live2d BEFORE UPDATE ON avatar_state BEGIN SELECT RAISE(ABORT, 'isolated storage failure'); END");
  assert.throws(() => setAvatar(store, live2DAvatarFixture()), /isolated storage failure/);
  assert.deepEqual(store.exportData(), before);
  assert.equal(store.avatarKey, key);
  store.db.exec("DROP TRIGGER reject_live2d");
  setAvatar(store, live2DAvatarFixture());
  assert.equal(store.state.avatar.format, "niria-live2d-avatar");
});

test("encrypted complete backups restore Live2D bytes and mappings onto a new companion", async (t) => {
  const first = setup(t), second = setup(t), sync = new SyncService(first);
  setAvatar(first, live2DAvatarFixture());
  first.addUser("模型更换前后的聊天");
  sync.createPair();
  const before = first.exportData();
  const envelope = await encryptBackup(before, "isolated-live2d-backup");
  assert.equal(JSON.stringify(envelope).includes("合成模型"), false);
  second.restore(await decryptBackup(envelope, "isolated-live2d-backup"));
  assert.equal(second.state.identity.id, first.state.identity.id);
  assert.deepEqual(second.state.avatar, first.state.avatar);
  assert.deepEqual(second.state.messages, first.state.messages);
});

test("backup restore rejects malformed Live2D in preserved conflict candidates without replacing local state", (t) => {
  const store = setup(t), before = store.exportData(), broken = structuredClone(before);
  const invalid = live2DAvatarFixture();
  invalid.package.files[1].data = "####";
  broken.conflicts = [{ kind: "avatar", key: `avatar:${store.state.identity.id}`, id: store.state.identity.id,
    candidates: [
      { id: "branch-a", device: "device-a", at: new Date().toISOString(), value: imageAvatar() },
      { id: "branch-b", device: "device-b", at: new Date().toISOString(), value: invalid }
    ] }];
  assert.throws(() => store.restore(broken));
  assert.deepEqual(store.exportData(), before);
});

test("WebDAV restores Live2D and preserves both image/model conflicts until explicit selection", async (t) => {
  const a = setup(t), b = setup(t), dav = await davFixture();
  t.after(() => dav.close());
  const sa = new SyncService(a), sb = new SyncService(b);
  sa.configure({ baseUrl: dav.baseUrl, auto: false }); sb.configure({ baseUrl: dav.baseUrl, auto: false });
  setAvatar(a, live2DAvatarFixture("最初"));
  const { code } = sa.createPair();
  await sa.sync(); await sb.join(code);
  assert.deepEqual(b.state.avatar, a.state.avatar);
  assert.equal([...dav.objects.values()][0].data.toString().includes("合成模型"), false);
  setAvatar(a, live2DAvatarFixture("新模型"));
  setAvatar(b, imageAvatar());
  await sa.sync(); await sb.sync(); await sa.sync();
  const conflict = b.state.conflicts.find((value) => value.kind === "avatar");
  assert.equal(conflict.candidates.length, 2);
  assert.equal(a.state.conflicts.filter((value) => value.kind === "avatar").length, 1);
  const selected = conflict.candidates.find((candidate) => candidate.value.format === "niria-live2d-avatar");
  sb.resolve(conflict.key, selected.id);
  await sb.sync(); await sa.sync();
  assert.deepEqual(a.state.avatar, live2DAvatarFixture("新模型"));
  assert.deepEqual(b.state.avatar, a.state.avatar);
  assert.equal(a.state.conflicts.length, 0);
  setAvatar(b, imageAvatar());
  await sb.sync(); await sa.sync();
  assert.deepEqual(a.state.avatar, imageAvatar());
});

test("Live2D expressions share the chat call without sending model bytes, native names or file paths", async (t) => {
  const store = setup(t), calls = [];
  setAvatar(store, live2DAvatarFixture());
  store.settings({ autoMemory: false });
  const service = new CompanionService(store, { completion: async (_, messages) => {
    calls.push(messages); return "很高兴听你说。\n[NIRIA_EXPRESSION:smile]";
  } });
  service.configure({ baseUrl: "http://127.0.0.1:9/v1", model: "isolated-model" });
  assert.deepEqual(expressionOptions(store.state.avatar), ["neutral", "smile", "shy"]);
  const context = JSON.stringify(buildContext(store.state));
  assert.equal(context.includes("MOC3"), false);
  assert.equal(context.includes("合成模型"), false);
  assert.equal(context.includes("smile.exp3.json"), false);
  await service.send({ content: "今天想和你说说话" });
  assert.equal(calls.length, 1);
  const data = { ...store.snapshot(), avatarKey: store.avatarKey };
  assert.equal(expressionFor(data).name, "smile");
  assert.equal(expressionFor(data, Date.now() + 9000).name, "neutral");
  setAvatar(store, live2DAvatarFixture("另一模型"));
  assert.equal(expressionFor({ ...store.snapshot(), avatarKey: store.avatarKey }).name, "neutral");
});

test("local runtime assets never resolve outside the imported bundle and revoke every object URL", async () => {
  const created = [], revoked = [];
  const bundle = live2DFixture(), resolver = live2DAssets(bundle, { urls: {
    createObjectURL(blob) { created.push(blob); return `blob:isolated-${created.length}`; },
    revokeObjectURL(url) { revoked.push(url); }
  } });
  const mocPath = bundle.model.replace("model.model3.json", "model.moc3");
  const bytes = resolver.read(mocPath);
  bytes[0] = 0;
  assert.equal(resolver.read(mocPath)[0], 77);
  assert.equal(resolver.json(bundle.model).Version, 3);
  assert.equal(resolver.url("model.moc3", bundle.model), resolver.url(mocPath));
  assert.equal(created.length, 1);
  assert.equal(created[0].type, "application/octet-stream");
  assert.throws(() => resolver.url("https://example.invalid/model.moc3"));
  assert.throws(() => resolver.read("ignored.wav", bundle.model), /不存在/);
  assert.throws(() => resolver.read("../../../../private", bundle.model));
  resolver.dispose(); resolver.dispose();
  assert.deepEqual(revoked, ["blob:isolated-1"]);
  assert.throws(() => resolver.read(mocPath), { name: "AbortError" });
  assert.throws(() => resolver.url(mocPath), { name: "AbortError" });
});

test("Live2D adoption checks current state and readiness before atomically replacing", (t) => {
  const store = setup(t);
  setAvatar(store, imageAvatar());
  const payload = { avatar: live2DAvatarFixture(), expectedAvatarKey: store.avatarKey, identityId: store.state.identity.id };
  const before = store.exportData();
  let applied = 0;
  assert.throws(() => adoptLive2D(store, payload), (error) => error.status === 503);
  assert.deepEqual(store.exportData(), before);
  assert.deepEqual(adoptLive2D(store, payload, { runtimeReady: true, beforeApply: () => { applied++; } }), { ok: true });
  assert.equal(applied, 1);
  assert.deepEqual(store.state.avatar, payload.avatar);
  assert.throws(() => adoptLive2D(store, payload, { runtimeReady: true }), (error) => error.status === 409);
});

test("Live2D adoption HTTP checks token, origin, current avatar and official moc integrity", async (t) => {
  const store = setup(t), companion = new CompanionService(store);
  setAvatar(store, imageAvatar());
  const server = createPrototypeServer({ store, companion });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((done) => { server.close(done); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const payload = { avatar: live2DAvatarFixture(), expectedAvatarKey: store.avatarKey, identityId: store.state.identity.id };
  const post = (body = payload, headers = {}, path = "/api/avatar/live2d") => fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Niria-Token": token, ...headers }, body: JSON.stringify(body)
  });
  const original = store.exportData();
  assert.equal((await post(payload, { "X-Niria-Token": "wrong" })).status, 403);
  assert.equal((await post(payload, { Origin: "https://example.invalid" })).status, 403);
  assert.equal((await post({ ...payload, identityId: "another-companion" })).status, 409);
  assert.equal((await post({ ...payload, expectedAvatarKey: null })).status, 409);
  assert.equal((await post({ ...payload, expectedAvatarKey: undefined })).status, 400);
  const broken = structuredClone(payload); broken.avatar.bindings.expressions.smile = "missing";
  assert.equal((await post(broken)).status, 400);
  assert.deepEqual(store.exportData(), original);
  assert.equal((await post(payload.avatar, {}, "/api/avatar")).status, 400);
  assert.equal((await post()).status, live2DRuntimeInfo.available ? 422 : 503);
  assert.deepEqual(store.exportData(), original);
  // Low-level state fixtures deliberately do not contain playable moc bytes.
  setAvatar(store, payload.avatar);
  assert.equal((await post()).status, 409);
  for (const module of ["/live2d-import.js", "/live2d-avatar.js", "/live2d-assets.js", "/live2d-player.js", "/live2d-runtime.js",
    "/live2d-adapter.js", "/live2d-runtime-info.js", ...(live2DRuntimeInfo.available
      ? ["/vendor/live2d/live2dcubismcore.min.js", "/vendor/live2d/cubism-framework.js"] : [])]) {
    const response = await fetch(`${base}${module}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /javascript/);
  }
  const runtime = await (await fetch(`${base}/api/live2d/runtime`)).json();
  assert.equal(runtime.available, live2DRuntimeInfo.available);
  const browserConfig = await (await fetch(`${base}/live2d-runtime-info.js`)).text();
  assert.equal(browserConfig, `export const live2DRuntimeInfo = Object.freeze(${JSON.stringify(live2DRuntimeInfo)});`);
  if (!runtime.available)
    assert.equal((await fetch(`${base}/vendor/live2d/live2dcubismcore.min.js`)).status, 404);
  const before = store.exportData(), badBackup = structuredClone(before);
  badBackup.avatar.package.files[1].data = "####";
  assert.throws(() => store.restore(badBackup));
  assert.deepEqual(store.exportData(), before);
});
