import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CredentialVault } from "../core/credential-vault.mjs";
import { Connections } from "../core/connections.mjs";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { SpeechService } from "../core/speech-service.mjs";
import { SyncService } from "../core/sync-service.mjs";
import { davFixture } from "./fixtures/dav.mjs";

function protector() {
  const key = randomBytes(32);
  return {
    available: async () => true,
    encrypt: async (input) => {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      const bytes = Buffer.concat([cipher.update(input), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
    },
    decrypt: async (bytes) => {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
    }
  };
}
async function setup(t, protection = protector()) {
  const directory = await mkdtemp(join(tmpdir(), "niria-credentials-"));
  const filename = join(directory, "credentials.sqlite");
  const vault = new CredentialVault(filename, protection);
  await vault.initialize();
  const store = new CompanionStore();
  const companion = new CompanionService(store);
  const speech = new SpeechService(store);
  const synchronization = new SyncService(store);
  const connections = new Connections({ companion, speech, synchronization, vault });
  t.after(async () => { store.close(); if (vault.db.isOpen) await vault.close(); await rm(directory, { recursive: true, force: true }); });
  return { vault, filename, connections, companion, speech, synchronization, store, protection };
}
const chatConfig = { baseUrl: "http://localhost:8181/v1", model: "test-model", apiKey: "secret-for-vault-test" };

test("remembering is opt-in and encrypted saved configuration survives reopening the vault", async (t) => {
  const { connections, vault, filename, protection } = await setup(t);
  await connections.configure("chat", chatConfig);
  assert.deepEqual(vault.status().saved, []);
  await connections.configure("chat", { ...chatConfig, remember: true });
  assert.equal((await vault.read("chat")).apiKey, chatConfig.apiKey);
  assert.equal((await readFile(filename)).includes(Buffer.from(chatConfig.apiKey)), false);
  assert.equal(JSON.stringify(connections.status()).includes(chatConfig.apiKey), false);
  await vault.close();
  const reopened = new CredentialVault(filename, protection);
  try {
    await reopened.initialize();
    assert.equal((await reopened.read("chat")).apiKey, chatConfig.apiKey);
  } finally { await reopened.close(); }
});
test("changing endpoint never reuses a credential, and model-only changes preserve it explicitly", async (t) => {
  const { connections, companion } = await setup(t);
  await connections.configure("chat", chatConfig);
  await connections.configure("chat", { ...chatConfig, model: "second-model", apiKey: "", reuseSecret: true });
  assert.equal(companion.connection.apiKey, chatConfig.apiKey);
  await assert.rejects(connections.configure("chat", { ...chatConfig, apiKey: "", baseUrl: "https://other.example/v1", reuseSecret: true }), /地址或账号已改变/);
  assert.equal(companion.connection.baseUrl, chatConfig.baseUrl);
  await connections.configure("chat", { ...chatConfig, apiKey: "", reuseSecret: false });
  assert.equal(companion.connection.apiKey, "");
});
test("Windows protection unavailable refuses disk saving without plaintext fallback", async (t) => {
  let encrypted = 0;
  const { vault, connections } = await setup(t, { available: async () => false, encrypt: async () => { encrypted++; }, decrypt: async () => {} });
  await assert.rejects(connections.configure("chat", { ...chatConfig, remember: true }), /不能安全记住/);
  assert.equal(encrypted, 0);
  assert.deepEqual(vault.status().saved, []);
  await connections.configure("chat", chatConfig);
  assert.equal(connections.status().chat.configured, true);
});
test("failed encryption rolls back active connection and never exposes raw encryption errors", async (t) => {
  const { connections, companion } = await setup(t, { available: async () => true, encrypt: async () => { throw new Error(chatConfig.apiKey); }, decrypt: async () => {} });
  await connections.configure("chat", chatConfig);
  await assert.rejects(connections.configure("chat", { ...chatConfig, model: "must-not-apply", remember: true }),
    (error) => !error.message.includes(chatConfig.apiKey));
  assert.equal(companion.connection.model, "test-model");
});
test("encrypted slot substitution cannot restore one service's data as another service", async (t) => {
  const { vault } = await setup(t);
  await vault.write("chat", chatConfig);
  const row = vault.db.prepare("SELECT ciphertext FROM credentials WHERE slot='chat'").get();
  vault.db.prepare("INSERT INTO credentials(slot,ciphertext) VALUES('speech',?)").run(row.ciphertext);
  assert.equal(await vault.read("speech"), null);
  assert.match(vault.status().warning, /无法解锁/);
});
test("stored service connections restore without paid calls and pairing saving is separate", async (t) => {
  const { connections, store, vault, synchronization } = await setup(t);
  await connections.configure("chat", { ...chatConfig, remember: true });
  await connections.configure("speech", { ...chatConfig, voice: "voice", dailyLimit: 10, auto: false, remember: true });
  await connections.configure("image", { ...chatConfig, remember: true });
  await connections.configure("sync", { baseUrl: "http://localhost:8181/dav/", username: "tester", password: "private-dav-password", auto: false, remember: true });
  const pair = synchronization.createPair();
  assert.equal(vault.status().saved.includes("pair"), false);
  await connections.rememberPair(true);
  synchronization.lock();
  const restoredChat = new CompanionService(store);
  const restoredSpeech = new SpeechService(store);
  const restored = new Connections({ companion: restoredChat, speech: restoredSpeech, synchronization, vault });
  await restored.restore();
  assert.equal(restoredChat.connection.apiKey, chatConfig.apiKey);
  assert.equal(restoredSpeech.connection.apiKey, chatConfig.apiKey);
  assert.equal(synchronization.exportPair().code, pair.code);
  assert.equal(store.state.calls.length, 0);
  const backup = JSON.stringify(store.exportData());
  assert.equal(backup.includes(chatConfig.apiKey), false);
  assert.equal(backup.includes(pair.code), false);
  await restored.forget("all");
  assert.deepEqual(vault.status().saved, []);
  assert.equal(restoredChat.connection.apiKey, chatConfig.apiKey);
});
test("image requests stay bound to the configuration that was explicitly confirmed", async (t) => {
  const { connections } = await setup(t);
  await connections.configure("image", chatConfig);
  const connectionId = connections.status().image.connectionId;
  const request = { useConnection: true, connectionId, action: "blink", image: "fixture" };
  assert.equal(connections.image(request).apiKey, chatConfig.apiKey);
  await connections.configure("image", { ...chatConfig, baseUrl: "https://another-provider.example/v1" });
  assert.throws(() => connections.image(request), /配置已经改变/);
});
test("rotation replaces the encrypted saved pair, persists auto-off, and distinguishes remote success from local save failure", async (t) => {
  const { connections, vault, synchronization, protection } = await setup(t);
  const dav = await davFixture(); t.after(() => dav.close());
  await connections.configure("sync", { baseUrl: dav.baseUrl, auto: true, remember: true });
  synchronization.createPair();
  await connections.rememberPair(true);
  await synchronization.sync();
  const plan = await connections.prepareSyncRotation();
  assert.equal((await vault.read("sync")).auto, false);
  await connections.rotateSync({ id: plan.id, confirmed: true, rememberPair: true });
  assert.equal((await vault.read("pair")).code, plan.code);
  synchronization.lock();
  await connections.restore();
  assert.equal(synchronization.exportPair().code, plan.code);
  assert.equal(synchronization.auto, false);
  const next = await connections.prepareSyncRotation();
  const encrypt = protection.encrypt;
  protection.encrypt = async (input) => {
    if (JSON.parse(input).slot === "pair") throw new Error(next.code);
    return encrypt(input);
  };
  const result = await connections.rotateSync({ id: next.id, confirmed: true, rememberPair: true });
  assert.match(result.credentialWarning, /未能/);
  assert.equal(synchronization.exportPair().code, next.code);
  assert.equal(await vault.read("pair"), null);
  assert.ok(!JSON.stringify(result).includes(next.code));
});
test("unsafe pair storage requests fail before remote key changes and before deleting the old saved pair", async (t) => {
  const { connections, vault, synchronization } = await setup(t);
  const dav = await davFixture(); t.after(() => dav.close());
  await connections.configure("sync", { baseUrl: dav.baseUrl, auto: false, remember: true });
  const original = synchronization.createPair();
  await connections.rememberPair(true); await synchronization.sync();
  const plan = await connections.prepareSyncRotation();
  const bytes = [...dav.objects.values()][0].data;
  vault.available = false;
  await assert.rejects(connections.rotateSync({ id: plan.id, confirmed: true, rememberPair: true }), /安全保存/);
  assert.equal(synchronization.exportPair().code, original.code);
  assert.ok([...dav.objects.values()][0].data.equals(bytes));
  assert.ok(vault.status().saved.includes("pair"));
});
