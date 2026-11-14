import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { generateImage } from "../core/image-generation.mjs";
import { CompanionStore, defaults, validateSnapshot } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";
import { ServiceError } from "../prototype/image-service.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const input = { baseUrl: "https://images.example/private-service-path/v1", model: "isolated-image-model", apiKey: "isolated-image-secret", action: "blink", image: png };
const result = { image: png, action: "blink", label: "闭眼" };
const status = (code) => (error) => error.status === code;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture(t) {
  const store = new CompanionStore();
  t.after(() => store.close());
  return store;
}
async function waitFor(check) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("isolated image condition timed out");
}
async function httpFixture(t, options = {}) {
  const store = fixture(t), companion = new CompanionService(store);
  const server = createPrototypeServer({ store, companion, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const post = (body = input, extra = {}) => fetch(`${base}/api/generate`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Niria-Token": token, ...(extra.headers || {}) },
    body: JSON.stringify(body), signal: extra.signal
  });
  return { store, server, base, token, post };
}

test("image attempts persist before the generator and success records metadata without adopting the result", async (t) => {
  const store = fixture(t), before = store.snapshot();
  const response = await generateImage(store, input, { generator: async (request) => {
    assert.equal(request.apiKey, input.apiKey);
    assert.equal(store.state.calls.length, 1);
    assert.equal(store.state.calls[0].status, "pending");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM call_records").get().n, 1);
    return result;
  } });
  assert.deepEqual(response, result);
  const call = store.state.calls[0];
  assert.equal(call.kind, "image");
  assert.equal(call.action, "blink");
  assert.equal(call.status, "completed");
  assert.equal(call.endpoint, "https://images.example");
  assert.equal(store.state.usage[call.day].image, 1);
  const serialized = JSON.stringify(store.state.calls);
  for (const value of [png, input.apiKey, "private-service-path", "reference.png"]) assert.equal(serialized.includes(value), false);
  assert.deepEqual(store.state.avatar, before.avatar);
  assert.deepEqual(store.state.identity, before.identity);
  validateSnapshot(store.snapshot());
});

test("invalid local input, stale connection confirmation and unauthenticated requests do not count attempts", async (t) => {
  let calls = 0;
  const { store, server, post } = await httpFixture(t, { generator: async () => { calls++; return result; } });
  for (const value of [null, [], {}, { ...input, action: "toString" }, { ...input, image: "bad PNG" }, { ...input, baseUrl: "http://remote.example/v1" }]) {
    assert.equal((await post(value)).status, 400);
  }
  assert.equal((await post(input, { headers: { "X-Niria-Token": "wrong" } })).status, 403);
  assert.equal((await post(input, { headers: { Origin: "https://other.example" } })).status, 403);
  assert.equal((await post({ useConnection: true, connectionId: "stale", action: "blink", image: png })).status, 400);
  await server.connections.configure("image", { ...input, remember: false });
  assert.equal((await post({ useConnection: true, connectionId: "stale", action: "blink", image: png })).status, 409);
  assert.equal(calls, 0);
  assert.equal(store.state.calls.length, 0);
  assert.deepEqual(store.state.usage, {});
});

test("provider errors record one failed attempt without secrets, retries or changing the adopted avatar", async (t) => {
  let calls = 0;
  const { store, post } = await httpFixture(t, { generator: async () => { calls++; throw new Error(input.apiKey); } });
  const before = store.snapshot();
  const response = await post();
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes(input.apiKey), false);
  assert.equal(calls, 1);
  assert.equal(store.state.calls[0].status, "failed");
  assert.equal(store.state.usage[store.state.calls[0].day].image, 1);
  assert.equal(store.state.avatar, before.avatar);
});

test("pre-aborted requests make no provider call and no local attempt", async (t) => {
  const store = fixture(t), controller = new AbortController();
  controller.abort();
  await assert.rejects(generateImage(store, input, { signal: controller.signal, generator: async () => assert.fail("provider must not run") }), status(504));
  assert.equal(store.state.calls.length, 0);
});

test("timeouts and ignored aborts discard late results and retain an unknown potentially billed attempt", async (t) => {
  const store = fixture(t), controller = new AbortController(), pending = deferred();
  let calls = 0;
  const request = generateImage(store, input, { signal: controller.signal, generator: async () => { calls++; return pending.promise; } });
  controller.abort();
  pending.resolve(result);
  await assert.rejects(request, status(504));
  assert.equal(calls, 1);
  assert.equal(store.state.calls[0].status, "unknown");
  assert.equal(store.state.usage[store.state.calls[0].day].image, 1);
  assert.equal(store.state.avatar, null);
});

test("HTTP timeouts record unknown and release the slot only after the generator settles", async (t) => {
  const entered = deferred(), release = deferred();
  let attempts = 0;
  const { store, post } = await httpFixture(t, { timeoutMs: 25, generator: async (_, { signal }) => {
    attempts++;
    if (attempts === 1) { entered.resolve(signal); return release.promise; }
    return result;
  } });
  const first = post();
  const signal = await entered.promise;
  await waitFor(() => signal.aborted);
  assert.equal((await post()).status, 409);
  release.resolve(result);
  assert.equal((await first).status, 504);
  assert.equal(store.state.calls.length, 1);
  assert.equal(store.state.calls[0].status, "unknown");
  assert.equal((await post()).status, 200);
  assert.equal(attempts, 2);
  assert.equal(store.state.calls[1].status, "completed");
});

test("adapter timeouts and aborts record unknown even before the shared signal is aborted", async (t) => {
  const store = fixture(t), controller = new AbortController();
  for (const error of [new ServiceError(504, "isolated adapter timeout"), new DOMException("isolated timeout", "TimeoutError"), new DOMException("isolated abort", "AbortError")]) {
    await assert.rejects(generateImage(store, input, { signal: controller.signal, generator: async () => { throw error; } }), status(504));
    assert.equal(store.state.calls.at(-1).status, "unknown");
  }
  assert.equal(controller.signal.aborted, false);
  assert.equal(store.state.calls.length, 3);
});

test("closing the HTTP request aborts generation and persists unknown without an automatic retry", async (t) => {
  const entered = deferred();
  let attempts = 0;
  const { store, post } = await httpFixture(t, { generator: async (_, { signal }) => {
    attempts++;
    entered.resolve(signal);
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("isolated disconnect")), { once: true }));
  } });
  const controller = new AbortController(), request = post(input, { signal: controller.signal });
  const signal = await entered.promise;
  controller.abort();
  await assert.rejects(request, (error) => error.name === "AbortError");
  await waitFor(() => signal.aborted && store.state.calls[0].status === "unknown");
  assert.equal(attempts, 1);
  assert.equal(store.state.usage[store.state.calls[0].day].image, 1);
});

test("failed initial logging prevents an upstream request and leaves no partial usage count", async (t) => {
  const store = fixture(t);
  store.db.exec("CREATE TEMP TRIGGER reject_image_log BEFORE INSERT ON main.call_records BEGIN SELECT RAISE(ABORT,'isolated initial image log failure'); END");
  await assert.rejects(generateImage(store, input, { generator: async () => assert.fail("must not incur an unlogged call") }), /initial image log failure/);
  assert.equal(store.state.calls.length, 0);
  assert.deepEqual(store.state.usage, {});
});

test("failed completion logging reports uncertainty and retains the attempted request", async (t) => {
  const store = fixture(t);
  store.db.exec(`CREATE TEMP TRIGGER reject_image_completion BEFORE UPDATE ON main.call_records
    WHEN json_extract(new.data,'$.status')<>'pending' BEGIN SELECT RAISE(ABORT,'isolated completion failure'); END`);
  let calls = 0;
  await assert.rejects(generateImage(store, input, { generator: async () => { calls++; return result; } }), status(503));
  assert.equal(calls, 1);
  assert.equal(store.state.calls[0].status, "pending");
  assert.equal(store.state.usage[store.state.calls[0].day].image, 1);
  assert.equal(store.state.avatar, null);
});

test("one failed completion write is reconciled to unknown and does not report success", async (t) => {
  const store = fixture(t), save = store.persistence.save.bind(store.persistence);
  let fail = true;
  store.persistence.save = (state, before) => {
    if (fail && state.calls.at(-1)?.status === "completed") {
      fail = false;
      throw new Error("isolated one-shot completion failure");
    }
    return save(state, before);
  };
  await assert.rejects(generateImage(store, input, { generator: async () => result }), status(503));
  assert.equal(store.state.calls[0].status, "unknown");
});

test("a replaced companion receives neither an old result nor an old image call", async (t) => {
  const store = fixture(t), pending = deferred();
  const request = generateImage(store, input, { generator: async () => pending.promise });
  store.restore(defaults());
  const before = store.snapshot();
  pending.resolve(result);
  await assert.rejects(request, status(409));
  assert.deepEqual(store.snapshot(), before);
});

test("call retention and daily accounting stay bounded and do not enter backup or synchronization", async (t) => {
  const store = fixture(t), sync = new SyncService(store);
  const date = new Date("2026-11-14T12:00:00Z"), day = date.toLocaleDateString("en-CA");
  store.mutate((state) => {
    for (let i = 0; i < 500; i++) state.calls.push({
      id: `old-${i}`, kind: "test", model: "synthetic", endpoint: "https://old.example", at: "2026-01-01T00:00:00Z", status: "completed"
    });
    for (let i = 1; i <= 31; i++) state.usage[`2026-01-${String(i).padStart(2, "0")}`] = { test: 1 };
    for (let i = 1; i <= 20; i++) state.usage[`2026-02-${String(i).padStart(2, "0")}`] = { test: 1 };
  });
  sync.createPair();
  const graph = structuredClone(sync.meta);
  await generateImage(store, input, { generator: async () => result, clock: () => date.getTime() });
  assert.equal(store.state.calls.length, 500);
  assert.equal(store.state.calls[0].id, "old-1");
  assert.equal(Object.keys(store.state.usage).length, 40);
  assert.equal(store.state.usage[day].image, 1);
  assert.equal(store.exportData().calls.length, 0);
  assert.deepEqual(sync.meta, graph);
});

test("completed and interrupted image calls survive SQLite restart with unknown recovery", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "niria-image-calls-"));
  t.after(() => {
    assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
    rmSync(folder, { recursive: true, force: true });
  });
  let store = new CompanionStore(join(folder, "companion.sqlite"));
  try {
    await generateImage(store, input, { generator: async () => result });
    store.mutate((state) => { state.calls.push({ ...state.calls[0], id: "interrupted-image-call", status: "pending" }); });
    const savedDay = store.state.calls[0].day;
    store.close();
    store = new CompanionStore(join(folder, "companion.sqlite"));
    assert.deepEqual(store.state.calls.map((call) => call.status), ["completed", "unknown"]);
    assert.equal(store.state.calls[1].action, "blink");
    assert.equal(store.state.usage[savedDay].image, 1);
    assert.equal(store.db.prepare("SELECT json_extract(data,'$.status') AS status FROM call_records WHERE json_extract(data,'$.id')=?").get("interrupted-image-call").status, "unknown");
    const malformed = store.snapshot();
    malformed.calls[0].action = "unsupported";
    assert.throws(() => validateSnapshot(malformed), status(400));
  } finally { store.close(); }
});

test("backup restore cannot erase an active image attempt", async (t) => {
  const entered = deferred(), release = deferred();
  const { store, base, token, post } = await httpFixture(t, { generator: async () => { entered.resolve(); return release.promise; } });
  const request = post();
  await entered.promise;
  const response = await fetch(`${base}/api/backup/restore`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Niria-Token": token }, body: "{}"
  });
  assert.equal(response.status, 409);
  assert.equal(store.state.calls[0].status, "pending");
  release.resolve(result);
  assert.equal((await request).status, 200);
});

test("image generation cannot start midway through joining another companion", async (t) => {
  const store = fixture(t), companion = new CompanionService(store), sync = new SyncService(store);
  const entered = deferred(), release = deferred();
  let attempts = 0;
  sync.join = async () => { entered.resolve(); await release.promise; };
  const server = createPrototypeServer({ store, companion, sync, generator: async () => { attempts++; return result; } });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const post = (path, body) => fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Niria-Token": token }, body: JSON.stringify(body)
  });
  const join = post("/api/sync/join", { code: "isolated-join", rememberPair: false });
  await entered.promise;
  assert.equal((await post("/api/generate", input)).status, 409);
  assert.equal(attempts, 0);
  assert.equal(store.state.calls.length, 0);
  release.resolve();
  assert.equal((await join).status, 200);
  assert.equal((await post("/api/generate", input)).status, 200);
  assert.equal(attempts, 1);
});
