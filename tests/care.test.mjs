import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";

const config = { baseUrl: "http://127.0.0.1:9/v1", model: "isolated-care" };
const minute = 60_000;
function setup(t, { completion = async () => "最近想聊点什么？", care = {}, ...options } = {}) {
  let at = new Date(2026, 10, 13, 12).getTime();
  const store = new CompanionStore();
  t.after(() => store.close());
  store.settings({ autoMemory: false, care: { enabled: true, intervalMinutes: 30, dailyLimit: 2, ...care } });
  const service = new CompanionService(store, { completion, clock: () => at, ...options });
  service.configure(config);
  service.lastInteraction = at - 31 * minute;
  return { store, service, setTime: (value) => { at = value instanceof Date ? value.getTime() : value; },
    advance: (value) => { at += value; } };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function waiting(t, options) {
  const response = deferred(), entered = deferred();
  let signal;
  const instance = setup(t, { ...options, completion: async (_, __, input) => {
    signal = input.signal; entered.resolve(); return response.promise;
  } });
  t.after(() => { instance.service.cancel(); response.resolve("隔离测试清理"); });
  return { ...instance, response, entered, signal: () => signal };
}
const completedCare = (store) => store.state.messages.filter((message) =>
  message.proactive && !message.deleted && message.status === "completed");

test("care respects both sides of overnight and daytime quiet hours", async (t) => {
  const { service, setTime } = setup(t);
  for (const hour of [0, 7, 22, 23]) {
    setTime(new Date(2026, 10, 14, hour));
    service.lastInteraction = new Date(2026, 10, 12).getTime();
    assert.equal(await service.tick(), false, `overnight ${hour}`);
  }
  service.store.settings({ care: { quietStart: 9, quietEnd: 17 } });
  for (const hour of [9, 12, 16]) {
    setTime(new Date(2026, 10, 14, hour));
    assert.equal(await service.tick(), false, `daytime ${hour}`);
  }
  setTime(new Date(2026, 10, 14, 17));
  assert.equal(await service.tick(), true);
});

test("care direct sends cannot bypass disabled, quiet, activity or daily policy", async (t) => {
  const { store, service, setTime } = setup(t);
  store.settings({ care: { enabled: false } });
  await assert.rejects(service.send({}, { care: true }), /主动关心/);
  store.settings({ care: { enabled: true } });
  setTime(new Date(2026, 10, 13, 23));
  await assert.rejects(service.send({}, { care: true }), /主动关心/);
  setTime(new Date(2026, 10, 13, 12));
  service.recordInteraction();
  await assert.rejects(service.send({}, { care: true }), /主动关心/);
  assert.equal(store.state.calls.length, 0);
  assert.equal(store.state.messages.length, 0);
});

test("typing postpones care for a full inactivity interval without writing data", async (t) => {
  const { store, service, advance } = setup(t);
  const before = store.exportData();
  service.recordInteraction();
  assert.deepEqual(store.exportData(), before);
  advance(29 * minute);
  assert.equal(await service.tick(), false);
  service.recordInteraction();
  advance(29 * minute);
  assert.equal(await service.tick(), false);
  advance(minute);
  assert.equal(await service.tick(), true);
  assert.equal(completedCare(store).length, 1);
});

test("typing cancels an in-flight greeting even when the provider ignores abort", async (t) => {
  const { store, service, entered, response, signal, advance } = waiting(t);
  const pending = service.tick();
  const outcome = assert.rejects(pending, /主动关心|停止|来源/);
  await entered.promise;
  advance(minute);
  service.recordInteraction();
  assert.equal(signal().aborted, true);
  response.resolve("迟到的问候不得出现");
  await outcome;
  assert.equal(completedCare(store).length, 0);
  assert.equal(store.state.messages.at(-1).status, "cancelled");
  assert.equal(JSON.stringify(store.snapshot()).includes("迟到的问候不得出现"), false);
  assert.equal(await service.tick(), false);
  assert.equal(store.state.calls.length, 1);
  assert.equal(Object.values(store.state.usage).reduce((sum, day) => sum + (day.care || 0), 0), 1);
});

test("typing cannot cancel or discard a requested chat reply", async (t) => {
  const { store, service, entered, response, signal } = waiting(t);
  const pending = service.send({ content: "正常发送的消息" });
  await entered.promise;
  service.recordInteraction();
  assert.equal(signal().aborted, false);
  response.resolve("正常的回复");
  await pending;
  assert.equal(store.state.messages.at(-1).content, "正常的回复");
  assert.equal(store.state.messages.at(-1).status, "completed");
});

test("a greeting crossing into quiet hours is discarded and the attempt remains counted", async (t) => {
  const { store, service, setTime, entered, response } = waiting(t);
  setTime(new Date(2026, 10, 13, 21, 59, 50));
  const pending = service.tick();
  const outcome = assert.rejects(pending, /主动关心|免打扰/);
  await entered.promise;
  setTime(new Date(2026, 10, 13, 22));
  response.resolve("免打扰期间不得出现");
  await outcome;
  assert.equal(completedCare(store).length, 0);
  assert.equal(store.state.messages.at(-1).status, "cancelled");
  assert.equal(store.state.calls.length, 1);
  assert.equal(await service.tick(), false);
});

for (const change of [
  { name: "disabled care", input: { enabled: false } },
  { name: "changed frequency", input: { intervalMinutes: 60 } },
  { name: "changed daily cap", input: { dailyLimit: 1 } }
]) {
  test(`an in-flight greeting cannot outlive ${change.name}`, async (t) => {
    const { store, service, entered, response } = waiting(t);
    const pending = service.tick();
    const outcome = assert.rejects(pending, /主动关心/);
    await entered.promise;
    store.settings({ care: change.input });
    response.resolve("旧设置下的问候");
    await outcome;
    assert.equal(completedCare(store).length, 0);
    assert.equal(store.state.messages.at(-1).status, "cancelled");
  });
}

test("a new user message invalidates an in-flight greeting without resending", async (t) => {
  const { store, service, entered, response } = waiting(t);
  const pending = service.tick();
  const outcome = assert.rejects(pending, /主动关心|来源/);
  await entered.promise;
  store.addUser("另外一处刚刚写入的消息");
  response.resolve("旧话题下的问候");
  await outcome;
  assert.equal(completedCare(store).length, 0);
  assert.equal(store.state.calls.length, 1);
});

test("failed and manually stopped care attempts retain the daily cap across log pruning", async (t) => {
  const { store, service, entered, response, advance } = waiting(t, { care: { dailyLimit: 1 } });
  const pending = service.tick();
  const outcome = assert.rejects(pending);
  await entered.promise;
  service.cancel();
  response.reject(new Error("isolated provider cancelled"));
  await outcome;
  store.mutate((state) => { state.calls = []; });
  advance(31 * minute);
  assert.equal(await service.tick(), false);
  await assert.rejects(service.send({}, { care: true }), /主动关心/);
  assert.equal(store.state.calls.length, 0);
});

test("one allowed greeting is delivered at a daily limit of one", async (t) => {
  const { store, service } = setup(t, { care: { dailyLimit: 1 } });
  assert.equal(await service.tick(), true);
  assert.equal(completedCare(store).length, 1);
  assert.equal(await service.tick(), false);
  assert.equal(store.state.calls.length, 1);
});

test("care resumes on the next local day without replaying missed intervals", async (t) => {
  const { store, service, setTime } = setup(t, { care: { dailyLimit: 1 } });
  assert.equal(await service.tick(), true);
  assert.equal(await service.tick(), false);
  setTime(new Date(2026, 10, 15, 12));
  assert.equal(await service.tick(), true);
  assert.equal(await service.tick(), false);
  assert.equal(store.state.calls.length, 2);
  assert.equal(store.state.calls[1].day, "2026-11-15");
  assert.equal(Object.keys(store.state.usage).length, 2);
});

test("activity API requires local authentication, accepts no content, and does not cancel ordinary chat", async (t) => {
  const { store, service, entered, response, signal, advance } = waiting(t);
  const server = createPrototypeServer({ store, companion: service });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const activity = (body = {}, headers = {}) => fetch(`${base}/api/chat/activity`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Niria-Token": token, ...headers },
    body: JSON.stringify(body)
  });
  const original = service.lastInteraction;
  assert.equal((await activity({}, { "X-Niria-Token": "invalid" })).status, 403);
  assert.equal((await activity({}, { Origin: "https://example.invalid" })).status, 403);
  assert.equal((await activity({ draft: "不应发送草稿" })).status, 400);
  assert.equal(service.lastInteraction, original);
  const before = store.exportData();
  advance(minute);
  assert.deepEqual(await (await activity()).json(), { ok: true });
  assert.ok(service.lastInteraction > original);
  assert.deepEqual(store.exportData(), before);
  const pending = service.send({ content: "正常的请求" });
  await entered.promise;
  assert.equal((await activity()).status, 200);
  assert.equal(signal().aborted, false);
  response.resolve("正常回复");
  await pending;
  assert.equal(store.state.calls.length, 1);
  assert.equal(store.state.calls[0].kind, "chat");
});
