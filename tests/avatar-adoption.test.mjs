import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { adoptImageAvatar } from "../core/avatar-adoption.mjs";
import { CompanionStore, defaults, validateAvatar } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const avatar = (extra = {}) => ({ format: "niria-avatar-prototype", version: 1, original: png, actions: {}, ...extra });
const basis = (store) => ({ identityId: store.state.identity.id, expectedAvatarKey: store.avatarKey });
const status = (code) => (error) => error.status === code;
function fixture(t) {
  const store = new CompanionStore();
  t.after(() => store.close());
  return store;
}

test("image adoption returns the committed basis and accepts later edits from that basis", (t) => {
  const store = fixture(t), identity = structuredClone(store.state.identity);
  const first = adoptImageAvatar(store, { avatar: avatar(), ...basis(store) });
  assert.deepEqual(first, { ok: true, identityId: identity.id, avatarKey: store.avatarKey });
  assert.match(first.avatarKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(store.state.identity, identity);
  const second = adoptImageAvatar(store, { avatar: avatar({ actions: { blink: png } }), identityId: first.identityId, expectedAvatarKey: first.avatarKey });
  assert.notEqual(second.avatarKey, first.avatarKey);
  assert.equal(store.state.avatar.actions.blink, png);
  assert.equal(store.state.calls.length, 0);
});

test("missing or malformed confirmation and a Live2D bypass do not cancel work or replace the avatar", (t) => {
  const store = fixture(t), before = store.snapshot();
  let cancelled = 0;
  for (const input of [null, avatar(), { avatar: avatar() }, { avatar: avatar(), ...basis(store), expectedAvatarKey: "" },
    { avatar: avatar(), ...basis(store), expectedAvatarKey: "A".repeat(64) },
    { avatar: { format: "niria-live2d-avatar" }, ...basis(store) }]) {
    assert.throws(() => adoptImageAvatar(store, input, { beforeApply: () => cancelled++ }), status(400));
    assert.deepEqual(store.snapshot(), before);
  }
  assert.throws(() => adoptImageAvatar(store, { avatar: avatar({ original: "bad PNG" }), ...basis(store) },
    { beforeApply: () => cancelled++ }), status(400));
  assert.equal(cancelled, 0);
});

test("another window's image or background change rejects an old save and retains its sync graph", (t) => {
  const store = fixture(t), sync = new SyncService(store);
  const opened = basis(store);
  sync.createPair();
  adoptImageAvatar(store, { avatar: avatar({ background: { version: 1, mode: "edge-connected" } }), ...opened });
  const before = store.snapshot(), graph = structuredClone(sync.meta);
  assert.throws(() => adoptImageAvatar(store, { avatar: avatar(), ...opened }), status(409));
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(sync.meta, graph);
  const stale = basis(store);
  store.mutate((state) => { state.avatar = validateAvatar(avatar()); });
  assert.throws(() => adoptImageAvatar(store, { avatar: avatar({ actions: { smile: png } }), ...stale }), status(409));
  assert.deepEqual(store.state.avatar, validateAvatar(avatar()));
});

test("restoring another companion rejects a prior selection even when the image hash is identical", (t) => {
  const store = fixture(t);
  adoptImageAvatar(store, { avatar: avatar(), ...basis(store) });
  const opened = basis(store), next = defaults();
  next.avatar = structuredClone(store.state.avatar);
  store.restore(next);
  assert.equal(store.avatarKey, opened.expectedAvatarKey);
  const before = store.snapshot();
  assert.throws(() => adoptImageAvatar(store, { avatar: avatar({ actions: { smile: png } }), ...opened }), status(409));
  assert.deepEqual(store.snapshot(), before);
});

test("an in-place action edit invalidates the cached avatar key and rejects the old basis", (t) => {
  const store = fixture(t);
  adoptImageAvatar(store, { avatar: avatar(), ...basis(store) });
  const opened = basis(store);
  store.mutate((state) => { state.avatar.actions.smile = png; });
  assert.notEqual(store.avatarKey, opened.expectedAvatarKey);
  assert.throws(() => adoptImageAvatar(store, { avatar: avatar(), ...opened }), status(409));
  assert.equal(store.state.avatar.actions.smile, png);
});

test("the commit rechecks its basis after beforeApply and keeps an intervening edit", (t) => {
  const store = fixture(t), opened = basis(store);
  assert.throws(() => adoptImageAvatar(store, { avatar: avatar(), ...opened }, {
    beforeApply: () => store.mutate((state) => { state.avatar = validateAvatar(avatar({ actions: { shy: png } })); })
  }), status(409));
  assert.equal(store.state.avatar.actions.shy, png);
  assert.equal(store.state.avatar.actions.smile, undefined);
});

test("a late persistence failure rolls image, sync revisions and stored basis back together", (t) => {
  const store = fixture(t), sync = new SyncService(store);
  sync.createPair();
  const before = store.snapshot(), graph = structuredClone(sync.meta), opened = basis(store);
  store.db.exec("CREATE TEMP TRIGGER reject_avatar_write BEFORE UPDATE ON main.avatar_state BEGIN SELECT RAISE(ABORT,'isolated avatar failure'); END");
  assert.throws(() => adoptImageAvatar(store, { avatar: avatar(), ...opened }), /isolated avatar failure/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(sync.meta, graph);
  assert.deepEqual(basis(store), opened);
  store.db.exec("DROP TRIGGER reject_avatar_write");
  adoptImageAvatar(store, { avatar: avatar(), ...opened });
  assert.ok(store.avatarKey);
});

test("late sync listener failure leaves the previous image and permits a retry from the same basis", (t) => {
  const store = fixture(t), sync = new SyncService(store);
  sync.createPair();
  const opened = basis(store), before = store.snapshot(), graph = structuredClone(sync.meta);
  const fail = () => { throw new Error("late avatar failure"); };
  store.listeners.add(fail);
  assert.throws(() => adoptImageAvatar(store, { avatar: avatar(), ...opened }), /late avatar failure/);
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(sync.meta, graph);
  store.listeners.delete(fail);
  assert.equal(adoptImageAvatar(store, { avatar: avatar(), ...opened }).avatarKey, store.avatarKey);
});

test("HTTP image adoption checks the token, Origin, missing basis and concurrent selections", async (t) => {
  const store = fixture(t), companion = new CompanionService(store);
  const server = createPrototypeServer({ store, companion });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const opened = basis(store), body = { avatar: avatar(), ...opened };
  const post = (value, extra = {}) => fetch(`${base}/api/avatar`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Niria-Token": token, ...extra }, body: JSON.stringify(value)
  });
  assert.equal((await post(body, { "X-Niria-Token": "wrong" })).status, 403);
  assert.equal((await post(body, { Origin: "https://other.example" })).status, 403);
  assert.equal((await post(avatar())).status, 400);
  assert.equal(store.state.avatar, null);
  const responses = await Promise.all([post(body), post({ ...body, avatar: avatar({ actions: { smile: png } }) })]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const accepted = await responses.find((response) => response.status === 200).json();
  assert.equal(accepted.avatarKey, store.avatarKey);
  const before = store.snapshot();
  assert.equal((await post(body)).status, 409);
  assert.deepEqual(store.snapshot(), before);
});

test("the accepted image and basis survive SQLite restart and encrypted backup recovery", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "niria-avatar-adoption-"));
  t.after(() => {
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
    rmSync(folder, { recursive: true, force: true });
  });
  let store = new CompanionStore(join(folder, "companion.sqlite"));
  try {
    const accepted = adoptImageAvatar(store, { avatar: avatar({ actions: { blink: png } }), ...basis(store) });
    const backup = await encryptBackup(store.exportData(), "isolated-avatar-adoption");
    store.close();
    store = new CompanionStore(join(folder, "companion.sqlite"));
    assert.deepEqual(basis(store), { identityId: accepted.identityId, expectedAvatarKey: accepted.avatarKey });
    store.restore(await decryptBackup(backup, "isolated-avatar-adoption"));
    assert.equal(store.avatarKey, accepted.avatarKey);
    adoptImageAvatar(store, { avatar: avatar({ actions: { curious: png } }), ...basis(store) });
    assert.equal(store.state.avatar.actions.curious, png);
  } finally { store.close(); }
});
