import test from "node:test";
import assert from "node:assert/strict";
import { CompanionStore } from "../core/store.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { WebDAV } from "../core/webdav.mjs";
import { seal } from "../core/sync-model.mjs";
import { parsePairing } from "../core/sync-pairing.mjs";
import { davFixture } from "./fixtures/dav.mjs";
import { once } from "node:events";
import { CompanionService } from "../core/chat-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";

const secret = "private-upstream-and-storage-detail";
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const stopped = (error) => error.status === 504 && /停止|超时/.test(error.message) && !error.message.includes(secret);
function setup(t, options = {}) {
  const store = new CompanionStore();
  const sync = new SyncService(store, { fetchImpl: async () => { throw new Error("Unexpected network"); }, ...options });
  sync.configure({ baseUrl: "http://127.0.0.1:1/dav/", auto: false });
  const { code } = sync.createPair();
  t.after(() => { sync.lock(); store.close(); });
  return { store, sync, code };
}
test("WebDAV rejects pre-cancelled requests before calling the transport", async () => {
  let calls = 0;
  const dav = new WebDAV({ baseUrl: "http://localhost:1/" }, { fetchImpl: async () => { calls++; return new Response(null, { status: 404 }); } });
  await assert.rejects(dav.read("state.niria", AbortSignal.abort()), stopped);
  await assert.rejects(dav.write("state.niria", "data", null, AbortSignal.abort()), stopped);
  assert.equal(calls, 0);
});
test("WebDAV discards an ignored-cancel GET response and releases its body", async () => {
  const gate = deferred(), entered = deferred(), controller = new AbortController();
  let discarded = false;
  const dav = new WebDAV({ baseUrl: "http://localhost:1/" }, { fetchImpl: async () => {
    entered.resolve(); await gate.promise;
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(Uint8Array.of(1)); },
      pull(controller) { controller.close(); },
      cancel() { discarded = true; }
    }), { headers: { ETag: '"remote"' } });
  } });
  const pending = dav.read("state.niria", controller.signal);
  await entered.promise; controller.abort(); gate.resolve();
  await assert.rejects(pending, stopped);
  assert.equal(discarded, true);
});
test("WebDAV response streaming normalizes independent abort and timeout failures", async () => {
  for (const name of ["AbortError", "TimeoutError"]) {
    const dav = new WebDAV({ baseUrl: "http://localhost:1/" }, { fetchImpl: async () => new Response(
      new ReadableStream({ start(controller) { controller.error(Object.assign(new Error(secret), { name })); } }),
      { headers: { ETag: '"remote"' } }
    ) });
    await assert.rejects(dav.read("state.niria"), stopped);
  }
});
test("WebDAV does not report a late PUT as confirmed or retry the request", async () => {
  const gate = deferred(), entered = deferred(), controller = new AbortController();
  let calls = 0;
  const dav = new WebDAV({ baseUrl: "http://localhost:1/" }, { fetchImpl: async () => {
    calls++; entered.resolve(); await gate.promise; return new Response(null, { status: 204 });
  } });
  const pending = dav.write("state.niria", "encrypted", null, controller.signal);
  await entered.promise; controller.abort(); gate.resolve();
  await assert.rejects(pending, stopped);
  assert.equal(calls, 1);
});
test("stopping during an ignored-cancel GET prevents upload and keeps the exclusive task until it settles", async (t) => {
  const { store, sync } = setup(t), gate = deferred(), entered = deferred();
  const id = store.addUser("尚未上传的本机记录").id;
  let writes = 0;
  sync.capabilities = { ok: true };
  sync.connection.read = async () => { entered.resolve(); await gate.promise; return null; };
  sync.connection.write = async () => { writes++; return true; };
  const pending = sync.sync();
  await entered.promise; sync.active.abort();
  assert.equal(sync.status().busy, true);
  await assert.rejects(sync.sync(), (error) => error.status === 409);
  assert.throws(() => sync.configure({ baseUrl: "http://localhost:2/", auto: false }), /停止|执行/);
  gate.resolve();
  await assert.rejects(pending, stopped);
  assert.equal(writes, 0);
  assert.equal(sync.status().busy, false);
  assert.equal(sync.status().lastSuccess, null);
  assert.equal(store.state.messages[0].id, id);
  assert.equal(store.state.calls.length, 0);
});
test("locking during an ignored-cancel GET cannot upload with a cleared key", async (t) => {
  const { sync } = setup(t), gate = deferred(), entered = deferred();
  const key = sync.pair.key;
  let writes = 0;
  sync.capabilities = { ok: true };
  sync.connection.read = async () => { entered.resolve(); await gate.promise; return null; };
  sync.connection.write = async () => { writes++; return true; };
  const pending = sync.sync();
  await entered.promise; sync.lock();
  assert.ok(key.every((byte) => byte === 0));
  gate.resolve();
  await assert.rejects(pending, stopped);
  assert.equal(writes, 0);
  assert.equal(sync.status().configured, false);
  assert.equal(sync.status().unlocked, false);
});
test("cancelled capability checks cannot restore success after locking", async (t) => {
  const { sync } = setup(t), gate = deferred(), entered = deferred();
  sync.connection.probe = async () => { entered.resolve(); await gate.promise; return { ok: true }; };
  const pending = sync.probe();
  await entered.promise; sync.lock(); gate.resolve();
  await assert.rejects(pending, stopped);
  assert.equal(sync.capabilities, null);
  assert.match(sync.status().error, /停止|超时/);
});
test("automatic sync timeout rejects late capability results before reading or writing state", async (t) => {
  const { sync } = setup(t, { timeoutMs: 10 }), gate = deferred(), entered = deferred();
  let reads = 0;
  sync.connection.probe = async (_folder, signal) => {
    entered.resolve(signal); await gate.promise; return { ok: true };
  };
  sync.connection.read = async () => { reads++; return null; };
  const pending = sync.sync();
  const signal = await entered.promise;
  if (!signal.aborted) await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  gate.resolve();
  await assert.rejects(pending, stopped);
  assert.equal(reads, 0);
  assert.equal(sync.capabilities, null);
});
test("cancelled joining reports interruption and preserves the original empty companion", async (t) => {
  const original = setup(t), peerStore = new CompanionStore(), peer = new SyncService(peerStore);
  t.after(() => { peer.lock(); peerStore.close(); });
  peer.configure({ baseUrl: "http://localhost:1/", auto: false });
  const identity = peerStore.state.identity.id, gate = deferred(), entered = deferred();
  const pair = parsePairing(original.code);
  const data = Buffer.from(seal(original.sync.meta.manifest, pair.key, pair.vaultId));
  pair.key.fill(0);
  peer.connection.read = async () => { entered.resolve(); await gate.promise; return { data, etag: '"remote"' }; };
  const pending = peer.join(original.code);
  await entered.promise; peer.active.abort(); gate.resolve();
  await assert.rejects(pending, stopped);
  assert.equal(peerStore.state.identity.id, identity);
  assert.equal(peer.meta.vaultId, null);
  assert.equal(peer.pair, null);
});
test("stopped rotation does not start capability checks after an asynchronous credential step", async (t) => {
  const { sync, code } = setup(t), gate = deferred(), entered = deferred();
  const plan = sync.rotation.prepare();
  let probes = 0;
  sync.connection.probe = async () => { probes++; throw new Error(secret); };
  const pending = sync.rotation.activate({ id: plan.id, confirmed: true }, async () => {
    entered.resolve(); await gate.promise;
  });
  await entered.promise; sync.active.abort(); gate.resolve();
  await assert.rejects(pending, stopped);
  assert.equal(probes, 0);
  assert.equal(sync.status().rotation.pending, false);
  assert.equal(sync.exportPair().code, code);
  sync.rotation.cancel();
});
test("rotation persistence failure before I/O restores metadata and leaves the plan cancellable", async (t) => {
  const { sync, code } = setup(t);
  const plan = sync.rotation.prepare(), before = structuredClone(sync.meta);
  const save = sync.persistence.save.bind(sync.persistence);
  sync.persistence.save = () => { throw new Error(secret); };
  await assert.rejects(sync.rotation.activate({ id: plan.id, confirmed: true }),
    (error) => error.status === 503 && !error.message.includes(secret));
  assert.deepEqual(sync.meta, before);
  assert.equal(sync.exportPair().code, code);
  assert.equal(sync.status().busy, false);
  sync.persistence.save = save;
  sync.rotation.cancel();
});
test("failed unlock persistence retains the previous key, plan, and metadata", (t) => {
  const { sync, code } = setup(t);
  const plan = sync.rotation.prepare(), before = structuredClone(sync.meta), pair = sync.pair;
  const save = sync.persistence.save.bind(sync.persistence);
  sync.persistence.save = () => { throw new Error(secret); };
  assert.throws(() => sync.unlock(plan.code), (error) => error.status === 503 && !error.message.includes(secret));
  assert.equal(sync.pair, pair);
  assert.equal(sync.exportPair().code, code);
  assert.deepEqual(sync.meta, before);
  assert.equal(sync.rotation.status().prepared, true);
  sync.persistence.save = save;
  sync.rotation.cancel();
});
test("ordinary streaming failures are sanitized without being reported as cancellation", async () => {
  const dav = new WebDAV({ baseUrl: "http://localhost:1/" }, { fetchImpl: async () => new Response(
    new ReadableStream({ start(controller) { controller.error(new Error(secret)); } }), { headers: { ETag: '"remote"' } }
  ) });
  await assert.rejects(dav.read("state.niria"), (error) => error.status === 502 && !error.message.includes(secret));
});
test("cancel after a real HTTP PUT remains unconfirmed and the next explicit sync reconciles it", async (t) => {
  const dav = await davFixture();
  t.after(() => dav.close());
  const { sync, store } = setup(t), gate = deferred(), entered = deferred();
  let hold = true, writes = 0;
  sync.fetchImpl = async (url, options) => {
    const response = await fetch(url, { ...options, signal: undefined });
    if (options.method === "PUT" && url.endsWith("state.niria")) {
      writes++;
      if (hold) { entered.resolve(); await gate.promise; }
    }
    return response;
  };
  sync.configure({ baseUrl: dav.baseUrl, auto: false });
  const id = store.addUser("取消时仍只保留一条共同经历").id;
  const pending = sync.sync();
  await entered.promise; sync.active.abort(); gate.resolve();
  await assert.rejects(pending, stopped);
  assert.equal(writes, 1);
  assert.equal(sync.status().lastSuccess, null);
  assert.equal(dav.objects.size, 1);
  hold = false;
  await sync.sync();
  assert.equal(writes, 2);
  assert.deepEqual(store.state.messages.map((message) => message.id), [id]);
  assert.equal(store.state.conflicts.length, 0);
  assert.ok(sync.status().lastSuccess);
});
test("late rotation capability result cannot proceed to reading state after cancellation", async (t) => {
  const { sync } = setup(t), gate = deferred(), entered = deferred();
  const plan = sync.rotation.prepare();
  let reads = 0;
  sync.connection.probe = async () => { entered.resolve(); await gate.promise; return { ok: true }; };
  sync.connection.read = async () => { reads++; return null; };
  const pending = sync.rotation.activate({ id: plan.id, confirmed: true });
  await entered.promise; sync.active.abort(); gate.resolve();
  await assert.rejects(pending, stopped);
  assert.equal(reads, 0);
  assert.equal(sync.capabilities, null);
  assert.equal(sync.status().rotation.pending, false);
  sync.rotation.cancel();
});
test("failure clearing a rotation journal retains the durable pending marker until read-only recovery", async (t) => {
  const { sync, code } = setup(t);
  const plan = sync.rotation.prepare(), save = sync.persistence.save.bind(sync.persistence);
  sync.persistence.save = (meta) => {
    if (!meta.rotation) throw new Error(secret);
    return save(meta);
  };
  await assert.rejects(sync.rotation.activate({ id: plan.id, confirmed: true }, async () => { throw new Error(secret); }),
    (error) => error.status === 503 && /待核对/.test(error.message) && !error.message.includes(secret));
  assert.ok(sync.meta.rotation);
  assert.deepEqual(sync.meta.rotation, sync.persistence.load().rotation);
  sync.persistence.save = save;
  const pair = parsePairing(code), data = Buffer.from(seal(sync.meta.manifest, pair.key, pair.vaultId));
  pair.key.fill(0);
  sync.connection.read = async () => ({ etag: '"remote"', data });
  const recovered = await sync.rotation.recover(code);
  assert.equal(recovered.readOnly, true);
  assert.equal(sync.status().rotation.pending, false);
});
test("HTTP locking cancels immediately while saved-pair removal waits or fails", async (t) => {
  const { sync, store } = setup(t), entered = deferred(), gate = deferred(), removal = deferred(), removing = deferred();
  const server = createPrototypeServer({ store, companion: new CompanionService(store), sync });
  server.connections.rememberPair = async () => { removing.resolve(); await removal.promise; throw new Error(secret); };
  server.connections.current.set("sync", { baseUrl: "http://localhost:1/", auto: false });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  sync.capabilities = { ok: true };
  sync.connection.read = async () => { entered.resolve(); await gate.promise; return null; };
  const running = sync.sync();
  const checked = assert.rejects(running, stopped);
  await entered.promise;
  const key = sync.pair.key, controller = sync.active;
  const locked = fetch(`${base}/api/sync/lock`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Niria-Token": token }, body: "{}"
  });
  await removing.promise;
  const cancelledImmediately = controller.signal.aborted;
  const keyClearedImmediately = key.every((byte) => byte === 0);
  gate.resolve(); removal.resolve();
  const response = await locked;
  await checked;
  assert.equal(cancelledImmediately, true);
  assert.equal(keyClearedImmediately, true);
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.match(result.error, /已锁定.*配对码.*重新启动/);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.equal(server.connections.current.has("sync"), false);
  assert.equal(sync.status().configured, false);
  assert.equal(sync.status().unlocked, false);
});
