import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { CompanionStore, now } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { SpeechService } from "../core/speech-service.mjs";
import { ServiceError } from "../prototype/image-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";

const config = { baseUrl: "http://127.0.0.1:8181/private/v1", model: "speech-lifecycle-test",
  voice: "isolated-voice", apiKey: "isolated-secret", auto: true, dailyLimit: 20 };
const audio = { mime: "audio/wav", audio: "isolated-audio" };
const status = (value) => (error) => error.status === value;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(t, options = {}) {
  const store = new CompanionStore();
  t.after(() => store.close());
  const message = { id: randomUUID(), role: "assistant", content: "保留的文字回复。", revision: 1,
    createdAt: now(), updatedAt: now(), deleted: false, status: "completed" };
  store.mutate((state) => state.messages.push(message));
  const speech = new SpeechService(store, { timeoutMs: 1000, ...options });
  speech.configure(config);
  return { store, speech, message };
}
async function waitFor(check) {
  for (let index = 0; index < 40; index++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("isolated speech condition timed out");
}
async function httpFixture(t, options) {
  const fixture = setup(t, options), companion = new CompanionService(fixture.store, { completion: async () => "独立的文字回复。" });
  const server = createPrototypeServer({ ...fixture, companion });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  const post = (body = { id: fixture.message.id }, signal, headers = {}) => fetch(`${base}/api/speech/speak`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Niria-Token": token, ...headers },
    body: JSON.stringify(body), signal
  });
  return { ...fixture, companion, post };
}

test("invalid speech switches never submit text or count an attempt", async (t) => {
  let attempts = 0;
  const { store, speech, message } = setup(t, { synthesis: async () => { attempts++; return audio; } });
  for (const value of [{ id: message.id, automatic: "false" }, { test: "true" }, { test: true, automatic: true }]) {
    await assert.rejects(speech.speak(value), status(400));
  }
  assert.equal(attempts, 0);
  assert.equal(store.state.calls.length, 0);
});

test("a failed initial speech log releases busy state and permits a later automatic attempt", async (t) => {
  let attempts = 0;
  const { store, speech, message } = setup(t, { synthesis: async () => { attempts++; return audio; } });
  store.db.exec("CREATE TEMP TRIGGER reject_speech_log BEFORE INSERT ON main.call_records BEGIN SELECT RAISE(ABORT,'isolated speech log failure'); END");
  await assert.rejects(speech.speak({ id: message.id, automatic: true }), status(503));
  assert.equal(speech.status().busy, false);
  assert.equal(attempts, 0);
  assert.deepEqual(store.state.usage, {});
  assert.equal(store.state.calls.length, 0);
  store.db.exec("DROP TRIGGER reject_speech_log");
  await speech.speak({ id: message.id, automatic: true });
  assert.equal(attempts, 1);
  assert.equal(store.state.messages[0].content, message.content);
});

test("a failed completion write reports uncertainty and never delivers unrecorded audio", async (t) => {
  const { store, speech, message } = setup(t, { synthesis: async () => audio });
  const save = store.persistence.save.bind(store.persistence);
  let fail = true;
  store.persistence.save = (state, before) => {
    if (fail && state.calls.at(-1)?.status === "completed") { fail = false; throw new Error("isolated completion failure"); }
    return save(state, before);
  };
  await assert.rejects(speech.speak({ id: message.id }), status(503));
  assert.equal(store.state.calls[0].status, "unknown");
  assert.equal(speech.status().busy, false);
  assert.equal(store.state.messages[0].content, message.content);
});

test("persistent speech log failure leaves pending for restart and releases the service", async (t) => {
  const { store, speech, message } = setup(t, { synthesis: async () => audio });
  store.db.exec(`CREATE TEMP TRIGGER reject_speech_completion BEFORE UPDATE ON main.call_records
    WHEN json_extract(new.data,'$.status')<>'pending' BEGIN SELECT RAISE(ABORT,'isolated speech completion failure'); END`);
  await assert.rejects(speech.speak({ id: message.id }), status(503));
  assert.equal(store.state.calls[0].status, "pending");
  assert.equal(speech.status().busy, false);
  assert.equal(store.state.usage[store.state.calls[0].day].speech, 1);
});

test("ignored speech cancellation discards late audio and holds the duplicate lock until settlement", async (t) => {
  const pending = deferred();
  const { store, speech, message } = setup(t, { synthesis: async () => pending.promise });
  const request = speech.speak({ id: message.id });
  speech.cancel();
  await assert.rejects(speech.speak({ id: message.id }), status(409));
  pending.resolve(audio);
  await assert.rejects(request, status(504));
  assert.equal(store.state.calls[0].status, "unknown");
  assert.equal(speech.status().busy, false);
});

test("independent adapter timeouts and aborts remain unknown without leaking provider details", async (t) => {
  for (const error of [new ServiceError(504, "isolated timeout"), new DOMException("isolated-secret", "TimeoutError"), new DOMException("isolated-secret", "AbortError")]) {
    const { store, speech, message } = setup(t, { synthesis: async () => { throw error; } });
    await assert.rejects(speech.speak({ id: message.id }), (error) => error.status === 504 && !error.message.includes(config.apiKey));
    assert.equal(store.state.calls[0].status, "unknown");
    assert.equal(speech.status().busy, false);
  }
});

test("changing companion identity rejects old speech even when the same message survives intact", async (t) => {
  const pending = deferred();
  const { store, speech, message } = setup(t, { synthesis: async () => pending.promise });
  const replacement = store.snapshot();
  replacement.identity.id = randomUUID();
  const request = speech.speak({ id: message.id });
  store.restore(replacement);
  const before = store.snapshot();
  pending.resolve(audio);
  await assert.rejects(request, status(409));
  assert.deepEqual(store.snapshot(), before);
  assert.equal(speech.status().busy, false);
});

test("same-identity restore invalidates waiting audio and failed restore preserves its history marker", async (t) => {
  const pending = deferred();
  const { store, speech, message } = setup(t, { synthesis: async () => pending.promise });
  const initial = speech.status().historyId, replacement = store.snapshot();
  const request = speech.speak({ id: message.id });
  store.restore(replacement);
  assert.notEqual(speech.status().historyId, initial);
  pending.resolve(audio);
  await assert.rejects(request, status(409));
  const current = speech.status().historyId;
  const reject = () => { throw new Error("isolated restore listener failure"); };
  store.listeners.add(reject);
  assert.throws(() => store.restore(replacement), /isolated restore listener failure/);
  store.listeners.delete(reject);
  assert.equal(speech.status().historyId, current);
  assert.equal(Object.hasOwn(store.exportData(), "restoreVersion"), false);
  assert.equal(JSON.stringify(store.exportData()).includes(current), false);
});

test("closing a speech HTTP request aborts its synthesis and preserves one unknown attempt", async (t) => {
  const entered = deferred();
  let attempts = 0;
  const { store, post } = await httpFixture(t, { synthesis: async (_, __, { signal }) => {
    attempts++;
    entered.resolve(signal);
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("isolated disconnect")), { once: true }));
  } });
  const controller = new AbortController(), request = post(undefined, controller.signal);
  const signal = await entered.promise;
  controller.abort();
  await assert.rejects(request, (error) => error.name === "AbortError");
  await waitFor(() => signal.aborted && store.state.calls[0].status === "unknown");
  assert.equal(attempts, 1);
});

test("speech authentication and foreign origins reject requests without provider calls", async (t) => {
  let attempts = 0;
  const { store, post } = await httpFixture(t, { synthesis: async () => { attempts++; return audio; } });
  assert.equal((await post(undefined, undefined, { "X-Niria-Token": "wrong" })).status, 403);
  assert.equal((await post(undefined, undefined, { Origin: "https://foreign.example" })).status, 403);
  assert.equal(attempts, 0);
  assert.equal(store.state.calls.length, 0);
});

test("rejecting a duplicate HTTP request cannot cancel the first speech request", async (t) => {
  const entered = deferred(), pending = deferred();
  let attempts = 0;
  const { store, post } = await httpFixture(t, { synthesis: async (_, __, { signal }) => {
    attempts++; entered.resolve(signal); return pending.promise;
  } });
  const first = post(), signal = await entered.promise;
  assert.equal((await post()).status, 409);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(signal.aborted, false);
  assert.equal(attempts, 1);
  pending.resolve(audio);
  assert.equal((await first).status, 200);
  assert.equal(store.state.calls[0].status, "completed");
});

test("text chat stays usable while a separately configured speech request is pending", async (t) => {
  const pending = deferred();
  const { store, speech, message } = setup(t, { synthesis: async () => pending.promise });
  store.settings({ autoMemory: false });
  const companion = new CompanionService(store, { completion: async () => "文字聊天继续正常。" });
  companion.configure({ baseUrl: "http://127.0.0.1:9/v1", model: "isolated-chat" });
  const request = speech.speak({ id: message.id });
  await companion.send({ content: "继续聊聊。" });
  assert.equal(store.state.messages.at(-1).content, "文字聊天继续正常。");
  pending.resolve(audio);
  assert.deepEqual(await request, audio);
});

test("speech call metadata and retained daily counts stay bounded without text or secrets", async (t) => {
  const { store, speech, message } = setup(t, { synthesis: async () => audio });
  store.mutate((state) => {
    for (let i = 0; i < 500; i++) state.calls.push({ id: `old-${i}`, kind: "test", status: "completed",
      model: "isolated", endpoint: "https://old.example", at: now() });
    for (let i = 1; i <= 31; i++) state.usage[`2026-01-${String(i).padStart(2, "0")}`] = { speech: 1 };
    for (let i = 1; i <= 20; i++) state.usage[`2026-02-${String(i).padStart(2, "0")}`] = { speech: 1 };
  });
  await speech.speak({ id: message.id });
  assert.equal(store.state.calls.length, 500);
  assert.equal(Object.keys(store.state.usage).length, 40);
  const call = store.state.calls.at(-1);
  assert.equal(call.endpoint, "http://127.0.0.1:8181");
  for (const value of [message.content, config.apiKey, "private", audio.audio]) assert.equal(JSON.stringify(call).includes(value), false);
  assert.equal(store.exportData().calls.length, 0);
});
