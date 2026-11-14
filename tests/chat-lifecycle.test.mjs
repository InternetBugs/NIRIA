import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService, complete } from "../core/chat-service.mjs";
import { ServiceError } from "../prototype/image-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";

const config = { baseUrl: "http://127.0.0.1:8181/private-chat/v1", model: "isolated-chat-lifecycle", apiKey: "isolated-chat-secret" };
const status = (value) => (error) => error.status === value;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(t, options = {}) {
  const store = new CompanionStore();
  t.after(() => store.close());
  store.settings({ autoMemory: false });
  const service = new CompanionService(store, { timeoutMs: 1000, ...options });
  service.configure(config);
  return { store, service };
}
async function waitFor(check) {
  for (let index = 0; index < 40; index++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("isolated chat condition timed out");
}
async function httpFixture(t, options) {
  const fixture = setup(t, options), server = createPrototypeServer({ store: fixture.store, companion: fixture.service });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const post = (path, body = {}, signal) => fetch(`${base}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Niria-Token": token },
    body: JSON.stringify(body), signal
  });
  return { ...fixture, post };
}

test("pre-aborted chat invocation never records or submits an attempt", async (t) => {
  const { store, service } = setup(t, { completion: async () => assert.fail("must not call after cancel") });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(service.invoke("chat", [], controller.signal), status(504));
  assert.equal(store.state.calls.length, 0);
  assert.deepEqual(store.state.usage, {});
});

test("failed initial chat logging makes no provider request and keeps the user message retryable", async (t) => {
  let attempts = 0;
  const { store, service } = setup(t, { completion: async () => { attempts++; return "可用回复。"; } });
  store.db.exec("CREATE TEMP TRIGGER reject_chat_log BEFORE INSERT ON main.call_records BEGIN SELECT RAISE(ABORT,'isolated-chat-secret'); END");
  await assert.rejects(service.send({ content: "保留用户输入。" }), (error) => error.status === 503 && !error.message.includes(config.apiKey));
  assert.equal(attempts, 0);
  assert.equal(service.status().busy, false);
  assert.equal(store.state.messages[0].content, "保留用户输入。");
  assert.equal(store.state.messages.at(-1).status, "failed");
  assert.match(store.state.messages.at(-1).error, /未向服务提交/);
  assert.deepEqual(store.state.usage, {});
  store.db.exec("DROP TRIGGER reject_chat_log");
  await service.send({ retryId: store.state.messages[0].id });
  assert.equal(attempts, 1);
  assert.equal(store.state.messages.filter((item) => item.role === "user").length, 1);
  assert.equal(store.state.messages.at(-1).content, "可用回复。");
});

test("failed completion logging preserves original replies and records uncertainty rather than provider failure", async (t) => {
  const { store, service } = setup(t, { completion: async () => "原来已保存的回复。" });
  await service.send({ content: "再聊一次。" });
  const before = structuredClone(store.state.messages[1]), save = store.persistence.save.bind(store.persistence);
  let failed = false;
  store.persistence.save = (state, previous) => {
    if (!failed && state.calls.length === 2 && state.calls.at(-1).status === "completed") {
      failed = true; throw new Error(config.apiKey);
    }
    return save(state, previous);
  };
  service.completion = async () => "不应交付的替换。";
  await assert.rejects(service.send({ retryId: store.state.messages[0].id }), status(503));
  assert.deepEqual(store.state.messages.find((item) => item.id === before.id), before);
  assert.equal(store.state.calls.at(-1).status, "unknown");
  assert.equal(store.state.messages.at(-1).status, "failed");
  assert.match(store.state.messages.at(-1).error, /原回复已保留/);
  assert.equal(JSON.stringify(store.snapshot()).includes("不应交付的替换"), false);
  assert.equal(JSON.stringify(store.state.calls).includes(config.apiKey), false);
  assert.equal(service.status().busy, false);
});

test("persistent completion-log faults leave pending for restart without locking future chat", async (t) => {
  const { store, service } = setup(t, { completion: async () => "不得交付。" });
  store.db.exec(`CREATE TEMP TRIGGER reject_chat_completion BEFORE UPDATE ON main.call_records
    WHEN json_extract(new.data,'$.status')<>'pending' BEGIN SELECT RAISE(ABORT,'isolated-chat-secret'); END`);
  await assert.rejects(service.send({ content: "已保存输入。" }), (error) => error.status === 503 && !error.message.includes(config.apiKey));
  assert.equal(store.state.calls[0].status, "pending");
  assert.equal(store.state.messages.at(-1).status, "failed");
  assert.equal(service.status().busy, false);
});

test("ignored chat cancellation keeps the serial lock and records unknown without storing late text", async (t) => {
  const pending = deferred();
  const { store, service } = setup(t, { completion: async () => pending.promise });
  const request = service.send({ content: "等待中的问题。" });
  service.cancel();
  await assert.rejects(service.send({ content: "重复提交。" }), status(409));
  pending.resolve("停止后的迟到回复。");
  await assert.rejects(request, status(504));
  assert.equal(store.state.calls[0].status, "unknown");
  assert.equal(store.state.messages.at(-1).status, "cancelled");
  assert.equal(JSON.stringify(store.snapshot()).includes("停止后的迟到回复"), false);
});

test("an ignored connection-test cancellation cannot report success", async (t) => {
  const pending = deferred();
  const { store, service } = setup(t, { completion: async () => pending.promise });
  const request = service.testConnection();
  service.cancel();
  pending.resolve("OK");
  await assert.rejects(request, status(504));
  assert.equal(store.state.calls[0].kind, "test");
  assert.equal(store.state.calls[0].status, "unknown");
  assert.equal(store.state.messages.length, 0);
});

test("an active chat keeps its confirmed connection until the request settles", async (t) => {
  const pending = deferred();
  let used;
  const { service } = setup(t, { completion: async (connection) => { used = connection; return pending.promise; } });
  const request = service.send({ content: "固定本次服务配置。" });
  assert.throws(() => service.configure({ ...config, model: "unconfirmed-replacement" }), status(409));
  assert.equal(used.model, config.model);
  pending.resolve("原配置的回复。");
  await request;
  service.configure({ ...config, model: "confirmed-after-completion" });
  assert.equal(service.status().model, "confirmed-after-completion");
});

test("adapter-level timeouts stay unknown even if the shared signal was not aborted", async (t) => {
  for (const error of [new ServiceError(504, "isolated timeout"), new DOMException(config.apiKey, "TimeoutError"), new DOMException(config.apiKey, "AbortError")]) {
    const { store, service } = setup(t, { completion: async () => { throw error; } });
    await assert.rejects(service.send({ content: "测试独立超时。" }), (error) => error.status === 504 && !error.message.includes(config.apiKey));
    assert.equal(store.state.calls[0].status, "unknown");
    assert.equal(store.state.messages.at(-1).status, "cancelled");
    assert.equal(service.status().busy, false);
  }
});

test("the production text adapter preserves independent transport timeout uncertainty", async () => {
  for (const name of ["TimeoutError", "AbortError"]) {
    const controller = new AbortController();
    await assert.rejects(complete(config, [{ role: "user", content: "隔离输入。" }], {
      signal: controller.signal,
      fetchImpl: async () => { throw new DOMException(config.apiKey, name); }
    }), (error) => error.status === 504 && !error.message.includes(config.apiKey));
    assert.equal(controller.signal.aborted, false);
  }
});

test("restore of either the same or a new identity never attaches an old result or failure", async (t) => {
  for (const changeId of [false, true]) {
    const pending = deferred();
    const { store, service } = setup(t, { completion: async () => pending.promise });
    const request = service.send({ content: "原请求。" }), replacement = store.snapshot();
    if (changeId) replacement.identity.id = randomUUID();
    replacement.messages.at(-1).content = "恢复资料里保留的待处理标记。";
    store.restore(replacement);
    const before = store.snapshot();
    pending.resolve("恢复前的旧回复。");
    await assert.rejects(request, status(409));
    assert.deepEqual(store.snapshot(), before);
    assert.equal(service.status().busy, false);
  }
});

test("a failed reply-state write reports local storage failure without leaking exceptions", async (t) => {
  const { store, service } = setup(t, { completion: async () => { throw new ServiceError(502, "隔离服务失败。"); } });
  store.db.exec(`CREATE TEMP TRIGGER reject_failed_reply BEFORE UPDATE ON main.message_records
    WHEN json_extract(new.data,'$.role')='assistant' AND json_extract(new.data,'$.status')='failed'
    BEGIN SELECT RAISE(ABORT,'isolated-chat-secret'); END`);
  await assert.rejects(service.send({ content: "保留文字。" }), (error) => error.status === 503 && !error.message.includes(config.apiKey));
  assert.equal(service.status().busy, false);
  assert.equal(store.state.calls[0].status, "failed");
  assert.equal(store.state.messages.at(-1).status, "pending");
});

test("memory result-log failure never turns the completed text reply into a failed chat", async (t) => {
  let attempts = 0;
  const { store, service } = setup(t, { completion: async () => ++attempts === 1
    ? "已经保存好的文字。" : '{"memories":[{"content":"不应采用的整理","kind":"fact"}]}' });
  store.settings({ autoMemory: true });
  const save = store.persistence.save.bind(store.persistence);
  let fail = true;
  store.persistence.save = (state, previous) => {
    if (fail && state.calls.at(-1)?.kind === "memory" && state.calls.at(-1).status === "completed") {
      fail = false; throw new Error(config.apiKey);
    }
    return save(state, previous);
  };
  await service.send({ content: "我有一个稳定喜好。" });
  assert.equal(store.state.messages.at(-1).content, "已经保存好的文字。");
  assert.equal(store.state.messages.at(-1).status, "completed");
  assert.equal(store.state.calls.at(-1).status, "unknown");
  assert.equal(store.state.memories.length, 0);
  assert.equal(attempts, 2);
});

test("closing a connection-test HTTP response aborts only its own upstream attempt", async (t) => {
  const entered = deferred();
  const { store, service, post } = await httpFixture(t, { completion: async (_, __, { signal }) => {
    entered.resolve(signal);
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("isolated disconnect")), { once: true }));
  } });
  const controller = new AbortController(), request = post("/api/connection/test", {}, controller.signal);
  const signal = await entered.promise;
  controller.abort();
  await assert.rejects(request, (error) => error.name === "AbortError");
  await waitFor(() => signal.aborted && store.state.calls[0].status === "unknown");
  assert.equal(service.status().busy, false);
});

test("a rejected duplicate chat HTTP response never cancels the active request", async (t) => {
  const entered = deferred(), pending = deferred();
  const { store, post } = await httpFixture(t, { completion: async (_, __, { signal }) => {
    entered.resolve(signal); return pending.promise;
  } });
  const first = post("/api/chat", { content: "第一个问题。" }), signal = await entered.promise;
  assert.equal((await post("/api/chat", { content: "重复问题。" })).status, 409);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(signal.aborted, false);
  pending.resolve("第一个请求的回复。");
  assert.equal((await first).status, 200);
  assert.equal(store.state.calls.length, 1);
});
