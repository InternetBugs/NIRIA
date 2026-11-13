import test from "node:test";
import assert from "node:assert/strict";
import { CompanionStore, now } from "../core/store.mjs";
import { SpeechService, synthesize } from "../core/speech-service.mjs";
import { randomUUID } from "node:crypto";

const config = { baseUrl: "http://localhost:8181/v1", model: "speech-test", voice: "test-voice", apiKey: "private-speech-key", auto: false, dailyLimit: 2 };
export function wavFixture() {
  const buffer = Buffer.alloc(44 + 1600);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(8000, 24); buffer.writeUInt32LE(16000, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write("data", 36); buffer.writeUInt32LE(1600, 40);
  return buffer;
}
function setup(t, options) {
  const store = new CompanionStore(); t.after(() => store.close());
  const message = { id: randomUUID(), role: "assistant", content: "你好，我在这里。", revision: 1, createdAt: now(), updatedAt: now(), deleted: false, status: "completed" };
  store.mutate((state) => state.messages.push(message));
  const speech = new SpeechService(store, options); speech.configure(config);
  return { store, speech, message };
}
test("speech adapter sends only selected text, model and voice and verifies WAV", async () => {
  let received;
  const result = await synthesize(config, "你好", { fetchImpl: async (url, input) => {
    received = { url, ...input }; return new Response(wavFixture(), { headers: { "Content-Type": "audio/wav" } });
  } });
  assert.equal(received.url, "http://localhost:8181/v1/audio/speech");
  assert.deepEqual(JSON.parse(received.body), { model: config.model, voice: config.voice, input: "你好", response_format: "wav" });
  assert.equal(result.mime, "audio/wav");
  assert.equal(Buffer.from(result.audio, "base64").toString("ascii", 0, 4), "RIFF");
  await assert.rejects(synthesize(config, "你好", { fetchImpl: async () => Response.json({ error: "private-speech-key" }, { status: 401 }) }), (e) => !e.message.includes("private-speech-key"));
  await assert.rejects(synthesize(config, "你好", { fetchImpl: async () => new Response("not wave") }), /WAV/);
});
test("configuration never calls provider; requests obey daily cap and contain no credentials in state", async (t) => {
  let calls = 0;
  const { store, speech, message } = setup(t, { synthesis: async () => { calls++; return { audio: "test-only", mime: "audio/wav" }; } });
  assert.equal(calls, 0);
  await speech.speak({ id: message.id });
  await speech.speak({ test: true });
  await assert.rejects(speech.speak({ id: message.id }), /今天的朗读/);
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(store.snapshot()).includes("private-speech-key"), false);
});
test("automatic speech defaults off and makes one attempt per reply even after failure", async (t) => {
  let calls = 0;
  const { speech, message } = setup(t, { synthesis: async () => { calls++; throw new Error("provider failed"); } });
  await assert.rejects(speech.speak({ id: message.id, automatic: true }), /未开启/);
  speech.configure({ ...config, auto: true });
  await assert.rejects(speech.speak({ id: message.id, automatic: true }), /未完成/);
  await assert.rejects(speech.speak({ id: message.id, automatic: true }), /不会自动重复/);
  assert.equal(calls, 1);
});
test("deleting source while audio is generating discards stale audio", async (t) => {
  let finish, entered;
  const started = new Promise((r) => { entered = r; });
  const { store, speech, message } = setup(t, { synthesis: async () => {
    entered(); return new Promise((r) => { finish = r; });
  } });
  const pending = speech.speak({ id: message.id });
  await started;
  store.deleteMessage(message.id);
  finish({ audio: "must-not-play" });
  await assert.rejects(pending, /来源回复已经改变/);
});
