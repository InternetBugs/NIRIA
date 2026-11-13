import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { CompanionStore, validateSnapshot } from "../core/store.mjs";
import { CompanionService, buildContext } from "../core/chat-service.mjs";
import { expressionOptions, expressionPrompt, parseExpressionReply } from "../core/expression.mjs";
import { expressionFor, EXPRESSION_DURATION } from "../prototype/public/avatar-player.js";
import { SpeechService } from "../core/speech-service.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";
import { davFixture } from "./fixtures/dav.mjs";
import { encryptBackup, decryptBackup } from "../core/backup.mjs";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const config = { baseUrl: "http://127.0.0.1:8181/v1", model: "expression-test" };
function setup(t, completion) {
  const store = new CompanionStore();
  t.after(() => store.close());
  store.settings({ autoMemory: false });
  store.mutate((state) => { state.avatar = { format: "niria-avatar-prototype", version: 1, source: png, actions: { smile: png, shy: png } }; });
  const service = new CompanionService(store, { completion });
  service.configure(config);
  return { store, service };
}
function snapshot(store) { return { ...store.snapshot(), avatarKey: store.avatarKey }; }

test("reply metadata accepts only a final standalone tag and degrades unknown or duplicate tags to neutral", () => {
  assert.deepEqual(parseExpressionReply("今天也很开心。\n[NIRIA_EXPRESSION:smile]"), { content: "今天也很开心。", name: "smile" });
  assert.deepEqual(parseExpressionReply("普通回复"), { content: "普通回复", name: "neutral" });
  assert.deepEqual(parseExpressionReply("引用 [NIRIA_EXPRESSION:smile] 的例子"), { content: "引用 [NIRIA_EXPRESSION:smile] 的例子", name: "neutral" });
  assert.deepEqual(parseExpressionReply("你好。\n[NIRIA_EXPRESSION:https://other.example/image]"), { content: "你好。", name: "neutral" });
  assert.deepEqual(parseExpressionReply("你好。\n[NIRIA_EXPRESSION:shy]\n[NIRIA_EXPRESSION:smile]"), { content: "你好。", name: "neutral" });
  assert.equal(parseExpressionReply("你好。\n[NIRIA_EXPRESSION:shy]", ["neutral", "smile"]).name, "neutral");
  assert.equal(parseExpressionReply("[NIRIA_EXPRESSION:smile]").content, "");
});

test("expression instructions expose only available names and do not send picture bytes", (t) => {
  const { store } = setup(t);
  assert.equal(expressionPrompt(null), "");
  assert.deepEqual(expressionOptions(store.state.avatar), ["neutral", "smile", "shy"]);
  const system = buildContext(store.state).messages[0].content;
  assert.match(system, /neutral、smile、shy/);
  assert.equal(system.includes(png), false);
  assert.equal(system.includes("、curious"), false);
});

test("one chat call supplies expression, and clean text alone reaches later context and speech", async (t) => {
  const calls = [];
  const { store, service } = setup(t, async (_, messages) => {
    calls.push(messages);
    return "听到这个消息我也很开心。\n[NIRIA_EXPRESSION:smile]";
  });
  await service.send({ content: "今天完成了一个小目标" });
  assert.equal(calls.length, 1);
  const reply = store.state.messages.at(-1);
  assert.equal(reply.content, "听到这个消息我也很开心。");
  assert.equal(reply.expression.name, "smile");
  assert.equal(reply.expression.avatarKey, store.avatarKey);
  assert.equal(expressionFor(snapshot(store)).name, "smile");
  assert.equal(buildContext(store.state).messages.at(-1).content, reply.content);
  let spoken;
  const speech = new SpeechService(store, { synthesis: async (_, content) => { spoken = content; return { audio: "fixture" }; } });
  speech.configure({ ...config, voice: "fixture", auto: false, dailyLimit: 10 });
  await speech.speak({ id: reply.id });
  assert.equal(spoken, reply.content);
  assert.equal(spoken.includes("NIRIA_EXPRESSION"), false);
});

test("plain or unsupported expression does not fail the chat, and metadata-only replies are not retried", async (t) => {
  let calls = 0, next = "没关系，我们慢慢来。";
  const { store, service } = setup(t, async () => { calls++; return next; });
  await service.send({ content: "你好" });
  assert.equal(store.state.messages.at(-1).expression.name, "neutral");
  next = "我有点好奇。\n[NIRIA_EXPRESSION:curious]";
  await service.send({ content: "继续" });
  assert.equal(store.state.messages.at(-1).content, "我有点好奇。");
  assert.equal(store.state.messages.at(-1).expression.name, "neutral");
  next = "[NIRIA_EXPRESSION:smile]";
  await assert.rejects(service.send({ content: "再继续" }), /没有聊天正文/);
  assert.equal(calls, 3);
  assert.equal(store.state.messages.at(-1).status, "failed");
});

test("expression expires without replaying old or invalid replies, and is bound to the accepted avatar", async (t) => {
  const { store, service } = setup(t, async () => "你好。\n[NIRIA_EXPRESSION:smile]");
  await service.send({ content: "你好" });
  const data = snapshot(store);
  const start = Date.parse(data.messages.at(-1).expression.at);
  assert.equal(expressionFor(data, start + 1).name, "smile");
  assert.equal(expressionFor(data, start + EXPRESSION_DURATION).name, "neutral");
  assert.equal(expressionFor(data, start - 100).name, "neutral");
  for (const mutate of [
    (s) => { s.messages.at(-1).deleted = true; },
    (s) => { s.messages.at(-1).conflicted = true; },
    (s) => { s.messages.at(-1).status = "failed"; },
    (s) => { s.avatarKey = "another-avatar"; },
    (s) => { delete s.avatar.actions.smile; },
    (s) => { s.conflicts = [{ kind: "avatar" }]; },
    (s) => { s.messages.push({ role: "user" }); }
  ]) {
    const changed = structuredClone(data); mutate(changed);
    assert.equal(expressionFor(changed, start + 1).name, "neutral");
  }
  store.editMessage(store.state.messages[0].id, "修正问候");
  assert.equal(store.state.messages.at(-1).expression, undefined);
  assert.equal(expressionFor(snapshot(store)).name, "neutral");
});

test("a late reply cannot animate a replacement avatar and old snapshots remain loadable", async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { store, service } = setup(t, async () => pending);
  const oldKey = store.avatarKey;
  const send = service.send({ content: "你好" });
  store.mutate((state) => { state.avatar = { ...state.avatar, actions: { shy: png } }; });
  release("你好。\n[NIRIA_EXPRESSION:smile]");
  await send;
  assert.equal(store.state.messages.at(-1).expression.avatarKey, oldKey);
  assert.equal(expressionFor(snapshot(store)).name, "neutral");
  const old = store.exportData();
  for (const message of old.messages) delete message.expression;
  assert.equal(validateSnapshot(old), old);
  const invalid = store.exportData();
  invalid.messages.at(-1).expression.name = "external-image";
  assert.throws(() => validateSnapshot(invalid), /无效/);
});

test("encrypted backup and WebDAV preserve expression metadata without replaying expired expressions", async (t) => {
  const { store, service } = setup(t, async () => "好呀。\n[NIRIA_EXPRESSION:shy]");
  await service.send({ content: "很高兴认识你" });
  const reply = store.state.messages.at(-1);
  reply.expression.at = "2020-01-01T00:00:00Z";
  const backup = await encryptBackup(store.exportData(), "test-expression-backup");
  const recovered = await decryptBackup(backup, "test-expression-backup");
  assert.deepEqual(recovered.messages.at(-1).expression, reply.expression);
  const dav = await davFixture(); t.after(() => dav.close());
  const localSync = new SyncService(store);
  localSync.configure({ baseUrl: dav.baseUrl, auto: false });
  const { code } = localSync.createPair();
  await localSync.sync();
  const peer = new CompanionStore(); t.after(() => peer.close());
  const peerSync = new SyncService(peer);
  peerSync.configure({ baseUrl: dav.baseUrl, auto: false });
  await peerSync.join(code);
  assert.deepEqual(peer.state.messages.find((m) => m.id === reply.id).expression, reply.expression);
  assert.equal(expressionFor(snapshot(peer)).name, "neutral");
});

test("local state notifications authenticate, reach both clients, and contain no companion data", async (t) => {
  const { store, service } = setup(t);
  const server = createPrototypeServer({ store, companion: service });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${base}/api/session`)).json();
  assert.equal((await fetch(`${base}/api/events`)).status, 403);
  assert.equal((await fetch(`${base}/api/events`, { headers: { "X-Niria-Token": token, Origin: "https://foreign.example" } })).status, 403);
  const streams = [];
  for (let i = 0; i < 2; i++) {
    const response = await fetch(`${base}/api/events`, { headers: { "X-Niria-Token": token } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /text\/event-stream/);
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), "event: state\ndata: {}\n\n");
    streams.push(reader);
  }
  store.identity({ name: "绝不放入事件正文的伴侣名字" });
  for (const reader of streams) {
    const update = await reader.read();
    assert.equal(new TextDecoder().decode(update.value), "event: state\ndata: {}\n\n");
    await reader.cancel();
  }
});
