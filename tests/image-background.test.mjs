import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { removeEdgeBackground, checkBackground, EDGE_BACKGROUND } from "../prototype/public/image-background.js";
import { CompanionStore, validateAvatar } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";
import { davFixture } from "./fixtures/dav.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const avatar = () => ({ format: "niria-avatar-prototype", version: 1, source: png, actions: { blink: png }, background: { ...EDGE_BACKGROUND } });
function picture(width = 64, height = 96) {
  const data = new Uint8ClampedArray(width * height * 4);
  const rectangle = (x, y, w, h, color) => {
    for (let row = y; row < y + h; row++) for (let col = x; col < x + w; col++) data.set(color, (row * width + col) * 4);
  };
  rectangle(0, 0, width, height, [250, 250, 250, 255]);
  rectangle(20, 20, 24, 60, [40, 60, 90, 255]);
  rectangle(27, 35, 10, 12, [250, 250, 250, 255]);
  return { width, height, data, rectangle };
}
const pixel = (image, x, y) => [...image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];

test("solid edge background becomes transparent without removing enclosed same-color details or mutating originals", () => {
  const image = picture(), before = new Uint8ClampedArray(image.data), result = removeEdgeBackground(image);
  assert.equal(result.status, "applied");
  assert.deepEqual(pixel(result, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(result, 24, 40), [40, 60, 90, 255]);
  assert.deepEqual(pixel(result, 30, 40), [250, 250, 250, 255]);
  assert.deepEqual(image.data, before);
  assert.ok(result.removed > .5 && result.removed < .9);
});

test("a near-background fringe keeps fractional alpha and removes matte color contamination", () => {
  const image = picture();
  image.rectangle(19, 20, 1, 60, [234, 238, 242, 255]);
  const result = removeEdgeBackground(image), fringe = pixel(result, 19, 40);
  assert.equal(result.status, "applied");
  assert.ok(fringe[3] > 0 && fringe[3] < 255);
  assert.ok(fringe[0] < 234 && fringe[1] < 238 && fringe[2] < 242);
  assert.deepEqual(pixel(result, 20, 40), [40, 60, 90, 255]);
});

test("fixed perimeter color prevents gradual background traversal into a different color", () => {
  const image = picture();
  for (let x = 10; x <= 24; x++) image.rectangle(x, 22, 1, 56, [250 - (x - 9) * 6, 250 - (x - 9) * 6, 250 - (x - 9) * 6, 255]);
  const result = removeEdgeBackground(image);
  assert.equal(result.status, "applied");
  assert.equal(pixel(result, 16, 40)[3], 255);
  assert.equal(pixel(result, 23, 40)[3], 255);
});

test("inconsistent opaque scenery is preserved with a complex-background result", () => {
  const image = picture();
  image.rectangle(0, 0, 32, 96, [30, 80, 120, 255]);
  const result = removeEdgeBackground(image);
  assert.equal(result.status, "complex");
  assert.deepEqual(result.data, image.data);
});

test("existing transparent silhouettes and partial edges remain byte-identical", () => {
  const image = picture();
  image.data.fill(0); image.rectangle(20, 20, 24, 60, [40, 60, 90, 255]);
  image.rectangle(19, 20, 1, 60, [42, 62, 92, 85]);
  const result = removeEdgeBackground(image);
  assert.equal(result.status, "transparent");
  assert.deepEqual(result.data, image.data);
  const once = removeEdgeBackground(picture());
  const twice = removeEdgeBackground(once);
  assert.equal(twice.status, "transparent");
  assert.deepEqual(twice.data, once.data);
});

test("transparent letterboxing still permits a uniform opaque image background to be removed", () => {
  const image = picture();
  image.rectangle(0, 0, 64, 10, [0, 0, 0, 0]);
  image.rectangle(0, 86, 64, 10, [0, 0, 0, 0]);
  const result = removeEdgeBackground(image);
  assert.equal(result.status, "applied");
  assert.equal(pixel(result, 3, 30)[3], 0);
  assert.deepEqual(pixel(result, 24, 40), [40, 60, 90, 255]);
});

test("flat, tiny and nearly erased images retain the input rather than returning an empty companion", () => {
  const image = picture();
  image.rectangle(0, 0, 64, 96, [250, 250, 250, 255]);
  assert.equal(removeEdgeBackground(image).status, "excessive");
  assert.deepEqual(removeEdgeBackground(image).data, image.data);
  const empty = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
  assert.equal(removeEdgeBackground(empty).status, "empty");
  image.rectangle(31, 47, 2, 2, [40, 60, 90, 255]);
  assert.equal(removeEdgeBackground(image).status, "excessive");
});

test("pixel processing rejects invalid dimensions, excessive allocation and non-byte data", () => {
  for (const image of [
    { width: 0, height: 1, data: new Uint8ClampedArray() },
    { width: 2.5, height: 2, data: new Uint8ClampedArray(20) },
    { width: 2001, height: 2000, data: new Uint8ClampedArray(4) },
    { width: 2, height: 2, data: new Uint8Array(16) },
    { width: 2, height: 2, data: new Uint8ClampedArray(12) }
  ]) assert.throws(() => removeEdgeBackground(image));
});

test("presentation metadata accepts only the known version and mode", () => {
  assert.equal(checkBackground(undefined), undefined);
  assert.deepEqual(checkBackground(EDGE_BACKGROUND), EDGE_BACKGROUND);
  for (const background of [null, [], "edge-connected", { version: 2, mode: "edge-connected" },
    { version: 1, mode: "semantic" }, { ...EDGE_BACKGROUND, endpoint: "https://other.example" }]) {
    assert.throws(() => checkBackground(background));
    assert.throws(() => validateAvatar({ ...avatar(), background }), (error) => error.status === 400);
  }
});

test("SQLite saves original image bytes and background mode, updates avatar keys and restores original presentation", (t) => {
  const folder = mkdtempSync(join(tmpdir(), "niria-background-")), filename = join(folder, "companion.sqlite");
  let store = new CompanionStore(filename);
  t.after(() => {
    store?.close();
    assert.ok(resolve(folder).startsWith(`${resolve(tmpdir())}${sep}`));
    rmSync(folder, { recursive: true, force: true });
  });
  store.mutate((state) => { state.avatar = validateAvatar(avatar()); });
  const key = store.avatarKey;
  store.close(); store = null; store = new CompanionStore(filename);
  assert.deepEqual(store.state.avatar, avatar());
  assert.equal(store.avatarKey, key);
  store.mutate((state) => { delete state.avatar.background; state.avatar = structuredClone(state.avatar); });
  assert.notEqual(store.avatarKey, key);
  assert.equal(store.state.avatar.source, png); assert.equal(store.state.avatar.actions.blink, png);
});

test("full encrypted backup restores presentation mode and original assets without credentials or model requests", async (t) => {
  const store = new CompanionStore(); t.after(() => store.close());
  store.mutate((state) => { state.avatar = validateAvatar(avatar()); });
  const backup = await encryptBackup(store.exportData(), "background-test-backup");
  const decoded = await decryptBackup(backup, "background-test-backup");
  const restored = new CompanionStore(); t.after(() => restored.close()); restored.restore(decoded);
  assert.deepEqual(restored.state.avatar, avatar());
  assert.equal(restored.state.calls.length, 0);
  assert.equal(JSON.stringify(backup).includes(png), false);
});

test("WebDAV peers preserve presentation metadata, and removing it restores both devices without replacing raw assets", async (t) => {
  const dav = await davFixture(); t.after(() => dav.close());
  const a = new CompanionStore(), b = new CompanionStore(); t.after(() => { a.close(); b.close(); });
  a.mutate((state) => { state.avatar = validateAvatar(avatar()); });
  const x = new SyncService(a), y = new SyncService(b);
  for (const sync of [x, y]) sync.configure({ baseUrl: dav.baseUrl, auto: false });
  const code = x.createPair().code; await x.sync(); await y.join(code);
  assert.deepEqual(b.state.avatar, a.state.avatar);
  b.mutate((state) => { delete state.avatar.background; state.avatar = structuredClone(state.avatar); });
  await y.sync(); await x.sync();
  assert.equal(Object.hasOwn(a.state.avatar, "background"), false);
  assert.equal(a.state.avatar.source, png); assert.equal(a.state.avatar.actions.blink, png);
  assert.equal(a.state.calls.length + b.state.calls.length, 0);
});

test("avatar HTTP validates background mode atomically and exposes only local processing modules", async (t) => {
  const store = new CompanionStore(); t.after(() => store.close());
  const server = createPrototypeServer({ store, companion: new CompanionService(store) }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`, { token } = await (await fetch(`${base}/api/session`)).json();
  const headers = { "Content-Type": "application/json", "X-Niria-Token": token };
  const payload = (value) => ({ avatar: value, identityId: store.state.identity.id, expectedAvatarKey: store.avatarKey });
  assert.equal((await fetch(`${base}/api/avatar`, { method: "POST", headers, body: JSON.stringify(payload(avatar())) })).status, 200);
  const before = store.snapshot();
  assert.equal((await fetch(`${base}/api/avatar`, { method: "POST", headers,
    body: JSON.stringify(payload({ ...avatar(), background: { version: 9, mode: "edge-connected" } })) })).status, 400);
  assert.deepEqual(store.snapshot(), before);
  for (const route of ["/image-background.js", "/background-editor.js", "/image-worker.js"]) {
    assert.equal((await fetch(`${base}${route}`)).status, 200);
  }
  assert.equal(store.state.calls.length, 0);
});
