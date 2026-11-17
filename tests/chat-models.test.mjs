import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { listChatModels } from "../core/chat-models.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { CompanionStore } from "../core/store.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";

const access = { baseUrl: "https://models.example/prefix/v1/", apiKey: "fixture-secret" };
const response = (data) => new Response(JSON.stringify({ data }));

test("model listing uses GET, configured prefix and bearer key without requiring a model", async () => {
  let count = 0;
  const result = await listChatModels(access, { fetchImpl: async (url, options) => {
    count++;
    assert.equal(url, "https://models.example/prefix/v1/models");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, "Bearer fixture-secret");
    assert.equal(options.body, undefined);
    return response([{ id: "zeta", owned_by: "ignored" }, { id: "alpha" }, { id: "zeta" }]);
  } });
  assert.equal(count, 1);
  assert.deepEqual(result, { models: ["alpha", "zeta"] });
});

test("local services may list models without authorization; empty catalogs are valid", async () => {
  assert.deepEqual(await listChatModels({ baseUrl: "http://localhost:8100/v1" }, { fetchImpl: async (url, options) => {
    assert.equal(url, "http://localhost:8100/v1/models");
    assert.equal(options.headers.Authorization, undefined);
    return response([]);
  } }), { models: [] });
});

test("invalid endpoints and keys fail before contacting the service", async () => {
  for (const input of [
    { baseUrl: "http://remote.example/v1" }, { baseUrl: "https://user:pass@remote.example/v1" },
    { baseUrl: "https://remote.example/v1?q=secret" }, { baseUrl: "https://remote.example/v1#secret" },
    { baseUrl: "https://remote.example/v1/chat/completions" }, { ...access, apiKey: "bad\r\nkey" },
    { ...access, apiKey: "a".repeat(4097) }, { apiKey: "secret" }
  ]) {
    await assert.rejects(listChatModels(input, { fetchImpl: () => assert.fail("must not fetch") }), { status: 400 });
  }
});

for (const status of [401, 403, 404, 405, 429, 500, 501]) {
  test(`model listing sanitizes HTTP ${status}, cancels its body and never retries`, async () => {
    let count = 0, canceled = false;
    await assert.rejects(listChatModels(access, { fetchImpl: async () => {
      count++;
      return { ok: false, status, body: { cancel: async () => { canceled = true; } } };
    } }), (error) => error.status === 502 && !error.message.includes(access.apiKey) &&
      ([401, 403].includes(status) ? error.message.includes("拒绝") :
        [404, 405, 501].includes(status) ? error.message.includes("手动") : true));
    assert.equal(canceled, true);
    assert.equal(count, 1);
  });
}

test("malformed, oversized and excessive model lists are rejected with bounded messages", async () => {
  for (const data of [null, {}, [{ id: "" }], [{ id: 42 }], [null], [{ id: "a".repeat(151) }],
    [{ id: "bad\nid" }], Array.from({ length: 10001 }, () => ({ id: "model" }))]) {
    await assert.rejects(listChatModels(access, { fetchImpl: async () => response(data) }), { status: 502 });
  }
  for (const body of ['{"data":', "<html>secret fixture-secret</html>", "a".repeat(1024 * 1024 + 1)]) {
    await assert.rejects(listChatModels(access, { fetchImpl: async () => new Response(body) }),
      (error) => error.status === 502 && !error.message.includes(access.apiKey));
  }
});

test("network failures and late aborted results are sanitized", async () => {
  await assert.rejects(listChatModels(access, { fetchImpl: async () => { throw new Error(access.apiKey); } }),
    (error) => error.status === 502 && !error.message.includes(access.apiKey));
  const controller = new AbortController();
  await assert.rejects(listChatModels(access, { signal: controller.signal, fetchImpl: async (_, options) => {
    assert.equal(options.signal, controller.signal);
    controller.abort();
    return response([{ id: "late" }]);
  } }), { status: 504 });
});

async function fixture(t, { timeoutMs = 1000, hang = false } = {}) {
  const calls = [];
  const upstream = http.createServer((request, reply) => {
    calls.push({ path: request.url, method: request.method, authorization: request.headers.authorization });
    if (!hang) { reply.setHeader("Content-Type", "application/json"); reply.end(JSON.stringify({ data: [{ id: "picked-model" }] })); }
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const store = new CompanionStore();
  const companion = new CompanionService(store, { completion: async () => assert.fail("listing must never call chat") });
  let writes = 0;
  const vault = {
    available: true, storageReady: true,
    status: () => ({ available: true, saved: ["chat"] }),
    write: async () => { writes++; }, remove: async () => { writes++; }
  };
  const server = createPrototypeServer({ store, companion, vault, modelsTimeoutMs: timeoutMs });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${origin}/api/session`)).json();
  const post = async (body, headers = {}) => {
    const result = await fetch(`${origin}/api/connection/models`, {
      method: "POST", headers: { "Content-Type": "application/json", "X-Niria-Token": token, ...headers }, body: JSON.stringify(body)
    });
    return { status: result.status, body: await result.json() };
  };
  t.after(async () => {
    await Promise.all([server, upstream].map((item) => new Promise((resolve) => { item.close(resolve); item.closeAllConnections(); })));
    server.connections.services.sync.lock(); store.close();
  });
  return { baseUrl, calls, store, companion, server, post, writes: () => writes };
}

test("local API lists draft credentials without applying configuration, writing secrets or charging chat usage", async (t) => {
  const { baseUrl, calls, store, companion, server, post, writes } = await fixture(t);
  const before = store.exportData();
  assert.deepEqual(await post({ baseUrl, apiKey: "typed-key", remember: true }), { status: 200, body: { models: ["picked-model"] } });
  assert.deepEqual(calls, [{ path: "/v1/models", method: "GET", authorization: "Bearer typed-key" }]);
  assert.equal(companion.connection, null);
  assert.equal(server.connections.current.size, 0);
  assert.equal(writes(), 0);
  assert.deepEqual(store.exportData(), before);
});

test("local API only reuses an existing secret for the same endpoint and with explicit consent", async (t) => {
  const { baseUrl, calls, companion, server, post, writes } = await fixture(t);
  await server.connections.configure("chat", { baseUrl, model: "original", apiKey: "saved-key", remember: true });
  const before = server.connections.status(), original = companion.connection, savedWrites = writes();
  assert.equal((await post({ baseUrl: `${baseUrl}/`, reuseSecret: true })).status, 200);
  assert.equal(calls.at(-1).authorization, "Bearer saved-key");
  assert.equal((await post({ baseUrl, reuseSecret: false })).status, 200);
  assert.equal(calls.at(-1).authorization, undefined);
  assert.equal((await post({ baseUrl, apiKey: "new-draft-key", reuseSecret: true })).status, 200);
  assert.equal(calls.at(-1).authorization, "Bearer new-draft-key");
  const count = calls.length;
  assert.equal((await post({ baseUrl: `${baseUrl}/other`, reuseSecret: true })).status, 400);
  assert.equal((await post({ baseUrl, reuseSecret: "true" })).status, 400);
  assert.equal(calls.length, count);
  assert.equal(companion.connection, original);
  assert.deepEqual(server.connections.status(), before);
  assert.equal(writes(), savedWrites);
});

test("model discovery enforces the local token and origin checks", async (t) => {
  const { baseUrl, calls, post } = await fixture(t);
  assert.equal((await post({ baseUrl }, { "X-Niria-Token": "wrong-token" })).status, 403);
  assert.equal((await post({ baseUrl }, { Origin: "https://other.example" })).status, 403);
  assert.equal((await post({ baseUrl, reuseSecret: true })).status, 400);
  assert.equal(calls.length, 0);
});

test("model discovery has a deadline independent of conversation state", async (t) => {
  const { baseUrl, calls, companion, post } = await fixture(t, { timeoutMs: 80, hang: true });
  const result = await post({ baseUrl });
  assert.equal(result.status, 504);
  assert.match(result.body.error, /超时/);
  assert.equal(calls.length, 1);
  assert.equal(companion.active, null);
});
