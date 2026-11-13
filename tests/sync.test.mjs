import test from "node:test";
import assert from "node:assert/strict";
import { CompanionStore, validMemory, messageHash, validateAvatar } from "../core/store.mjs";
import { SyncService, parsePairing } from "../core/sync-service.mjs";
import { WebDAV } from "../core/webdav.mjs";
import { unseal, validateManifest } from "../core/sync-model.mjs";
import { buildContext } from "../core/chat-service.mjs";
import { davFixture } from "./fixtures/dav.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function pair(t, fixtureOptions) {
  const dav = await davFixture(fixtureOptions); t.after(() => dav.close());
  const a = new CompanionStore(), b = new CompanionStore();
  t.after(() => { a.close(); b.close(); });
  const sa = new SyncService(a), sb = new SyncService(b);
  sa.configure({ baseUrl: dav.baseUrl, auto: false });
  sb.configure({ baseUrl: dav.baseUrl, auto: false });
  const { code } = sa.createPair();
  return { a, b, sa, sb, code, dav };
}
test("WebDAV checks actual conditional behavior, cleans probe and refuses unsafe providers", async (t) => {
  for (const options of [{}, { ignoreConditions: true }, { weakETag: true }]) {
    const dav = await davFixture(options);
    try {
      const client = new WebDAV({ baseUrl: dav.baseUrl });
      if (options.ignoreConditions || options.weakETag) await assert.rejects(client.probe("test/"), /条件|ETag/);
      else assert.equal((await client.probe("test/")).ok, true);
      assert.equal(dav.objects.size, 0);
    } finally { await dav.close(); }
  }
});
test("pairing restores identity and approved assets; service secrets and device settings stay local", async (t) => {
  const { a, b, sa, sb, code, dav } = await pair(t);
  a.identity({ name: "月见" }); a.addUser("最初的共同经历");
  const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  a.mutate((state) => { state.avatar = validateAvatar({ format: "niria-avatar-prototype", original: image, actions: { blink: image } }); });
  a.settings({ care: { enabled: true } });
  await sa.sync();
  const raw = [...dav.objects.values()][0].data.toString();
  assert.equal(raw.includes("月见"), false);
  assert.equal(raw.includes("最初"), false);
  assert.equal(raw.includes("identityId"), false);
  await sb.join(code);
  assert.equal(b.state.identity.id, a.state.identity.id);
  assert.equal(b.state.identity.name, "月见");
  assert.equal(b.state.messages[0].content, "最初的共同经历");
  assert.deepEqual(b.state.avatar, a.state.avatar);
  assert.equal(b.state.settings.care.enabled, false);
  assert.equal(sb.status().unlocked, true);
  assert.equal(JSON.stringify(sb.status()).includes(parsePairing(code).key.toString("base64url")), false);
});
test("offline additions merge in both directions and repeated sync stays idempotent", async (t) => {
  const { a, b, sa, sb, code } = await pair(t);
  await sa.sync(); await sb.join(code);
  a.addUser("A 的消息"); b.addUser("B 的消息");
  await sa.sync(); await sb.sync(); await sa.sync(); await sb.sync();
  assert.deepEqual(a.state.messages.map((m) => m.id).sort(), b.state.messages.map((m) => m.id).sort());
  assert.equal(a.state.messages.length, 2);
  assert.equal(a.state.conflicts.length, 0);
  const nodes = sa.meta.manifest.records.reduce((n, r) => n + r.nodes.length, 0);
  await sa.sync();
  assert.equal(sa.meta.manifest.records.reduce((n, r) => n + r.nodes.length, 0), nodes);
});
test("sync keeps a reply after its user message when timestamps are equal or the clock moves backwards", async (t) => {
  const { a, b, sa, sb, code } = await pair(t);
  const parentId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const replyId = "00000000-0000-4000-8000-000000000001";
  const at = new Date().toISOString();
  const user = { id: parentId, role: "user", content: "同一毫秒发送的消息", revision: 1, createdAt: at, updatedAt: at, status: "completed", deleted: false };
  a.mutate((state) => {
    state.messages.push(user, { ...user, id: replyId, role: "assistant", replyTo: parentId, content: "对应的回复" });
  });
  await sa.sync(); await sb.join(code);
  assert.deepEqual(b.state.messages.map((m) => m.id), [parentId, replyId]);
  a.mutate((state) => {
    const reply = state.messages.find((m) => m.id === replyId);
    reply.createdAt = new Date(Date.parse(user.createdAt) - 1000).toISOString();
    reply.revision++;
  });
  await sa.sync(); await sb.sync();
  assert.deepEqual(b.state.messages.map((m) => m.id), [parentId, replyId]);
});
test("concurrent persona changes preserve both versions and resolution converges", async (t) => {
  const { a, b, sa, sb, code } = await pair(t);
  await sa.sync(); await sb.join(code);
  a.identity({ name: "A 月见" }); b.identity({ name: "B 月见" });
  await sa.sync(); await sb.sync(); await sa.sync();
  assert.equal(a.state.conflicts.length, 1);
  assert.equal(b.state.conflicts.length, 1);
  assert.throws(() => buildContext(a.state), /同步冲突/);
  const conflict = b.state.conflicts[0];
  const selected = conflict.candidates.find((h) => h.value.name === "B 月见");
  sb.resolve(conflict.key, selected.id);
  await sb.sync(); await sa.sync();
  assert.equal(a.state.identity.name, "B 月见");
  assert.equal(a.state.conflicts.length, 0);
  assert.equal(a.state.identity.conflicted, undefined);
});
test("concurrent message edits cannot validate another branch's derived memory with equal revision numbers", async (t) => {
  const { a, b, sa, sb, code } = await pair(t);
  const message = a.addUser("喜欢茶");
  await sa.sync(); await sb.join(code);
  a.editMessage(message.id, "喜欢红茶"); b.editMessage(message.id, "喜欢乌龙茶");
  const memoryId = a.addMemory({ content: "喜欢红茶", sources: [{ id: message.id, revision: 2 }] });
  await sa.sync(); await sb.sync();
  assert.equal(b.state.messages.find((m) => m.id === message.id).conflicted, true);
  assert.equal(validMemory(b.state, b.state.memories.find((m) => m.id === memoryId)), false);
  const conflict = b.state.conflicts.find((c) => c.kind === "message");
  sb.resolve(conflict.key, conflict.candidates.find((h) => h.value.content === "喜欢乌龙茶").id);
  const memory = b.state.memories.find((m) => m.id === memoryId);
  assert.equal(validMemory(b.state, memory), false);
  assert.notEqual(memory.sources[0].hash, messageHash(b.state.messages.find((m) => m.id === message.id)));
});
test("forget propagates tombstones, purges server plaintext and defeats an offline new derived memory", async (t) => {
  const { a, b, sa, sb, code, dav } = await pair(t);
  const message = a.addUser("我的地址是某个秘密地方");
  const id = a.addMemory({ content: "地址秘密", sources: [{ id: message.id, revision: 1 }] });
  await sa.sync(); await sb.join(code);
  b.addMemory({ content: "从离线旧消息整理的地址", sources: [{ id: message.id, revision: 1 }] });
  a.deleteMemory(id, true);
  assert.equal(JSON.stringify(sa.meta.manifest).includes("秘密地方"), false, "local sync journal must not retain forgotten plaintext");
  await sa.sync(); await sb.sync(); await sa.sync();
  assert.equal(b.state.messages[0].deleted, true);
  assert.equal(b.state.memories.filter((m) => !m.deleted).length, 0);
  const pairData = parsePairing(code);
  const manifest = unseal([...dav.objects.values()][0].data.toString(), pairData.key, pairData.vaultId, pairData.identityId);
  assert.equal(JSON.stringify(manifest).includes("地址"), false);
});
test("sync permission removes private memory and source messages from uploaded payload, independently of model permission", async (t) => {
  const { a, sa, code, dav } = await pair(t);
  const message = a.addUser("不外传的秘密");
  const id = a.addMemory({ content: "不外传的秘密", sources: [{ id: message.id, revision: 1 }] });
  a.editMemory(id, { allowSync: false, allowModel: true });
  await sa.sync();
  const pairData = parsePairing(code);
  const manifest = unseal([...dav.objects.values()][0].data.toString(), pairData.key, pairData.vaultId, pairData.identityId);
  assert.equal(JSON.stringify(manifest).includes("不外传"), false);
  assert.ok(buildContext(a.state).messages[0].content.includes("不外传"));
});
test("withdrawing sync permission after upload removes remote payload and remains local after refresh", async (t) => {
  const { a, b, sa, sb, code, dav } = await pair(t);
  const message = a.addUser("隐私茶");
  const id = a.addMemory({ content: "隐私茶", sources: [{ id: message.id, revision: 1 }] });
  await sa.sync(); await sb.join(code);
  a.editMemory(id, { allowSync: false });
  await sa.sync(); await sb.sync(); await sa.sync();
  const pairData = parsePairing(code);
  const manifest = unseal([...dav.objects.values()][0].data.toString(), pairData.key, pairData.vaultId, pairData.identityId);
  assert.equal(JSON.stringify(manifest).includes("隐私茶"), false);
  assert.equal(b.state.memories[0].allowSync, false);
  assert.equal(a.state.memories[0].content, "隐私茶");
});
test("two simultaneous conditional uploads converge without losing new records", async (t) => {
  const { a, b, sa, sb, code } = await pair(t);
  await sa.sync(); await sb.join(code);
  a.addUser("并发 A"); b.addUser("并发 B");
  await Promise.all([sa.sync(), sb.sync()]);
  await sa.sync(); await sb.sync();
  assert.equal(a.state.messages.length, 2);
  assert.equal(b.state.messages.length, 2);
  assert.equal(a.state.conflicts.length, 0);
});
test("wrong key and modified ciphertext fail without replacing local state", async (t) => {
  const { a, sa, code, dav } = await pair(t);
  a.addUser("不要覆盖");
  await sa.sync();
  const remote = [...dav.objects.values()][0];
  const envelope = JSON.parse(remote.data);
  envelope.tag = Buffer.alloc(16).toString("base64");
  remote.data = Buffer.from(JSON.stringify(envelope));
  await assert.rejects(sa.sync(), /解密|验证/);
  assert.equal(a.state.messages[0].content, "不要覆盖");
  const bad = parsePairing(code); bad.key.fill(0);
  assert.throws(() => unseal(remote.data.toString(), bad.key, bad.vaultId, bad.identityId), /验证/);
});
test("cycle in revision graph is rejected before applying state", async (t) => {
  const { sa } = await pair(t);
  await sa.sync();
  const manifest = structuredClone(sa.meta.manifest);
  const node = manifest.records[0].nodes[0];
  node.parents = [node.id];
  assert.throws(() => validateManifest(manifest), /版本关系无效/);
});
test("backup restores sync lineage without secrets and preserves unresolved conflict choices", async (t) => {
  const { a, b, sa, sb, code, dav } = await pair(t);
  await sa.sync(); await sb.join(code);
  a.identity({ name: "A" }); b.identity({ name: "B" });
  await sa.sync(); await sb.sync();
  const backup = b.exportData();
  const fresh = new CompanionStore(); t.after(() => fresh.close());
  const recovered = new SyncService(fresh);
  fresh.restore(backup);
  assert.equal(fresh.state.conflicts.length, 1);
  assert.equal(recovered.status().unlocked, false);
  recovered.configure({ baseUrl: dav.baseUrl, auto: false });
  recovered.unlock(code);
  const conflict = fresh.state.conflicts[0];
  recovered.resolve(conflict.key, conflict.candidates.find((h) => h.value.name === "B").id);
  await recovered.sync(); await sa.sync();
  assert.equal(a.state.identity.name, "B");
});
test("local changes during upload are retained without producing self conflicts", async (t) => {
  let trigger;
  const { a, b, sa, sb, code } = await pair(t, { onPut: async ({ path }) => {
    if (path.endsWith("state.niria") && trigger) { const fn = trigger; trigger = null; fn(); }
  } });
  await sa.sync(); await sb.join(code);
  a.addUser("上传前");
  trigger = () => a.addUser("上传中");
  await sa.sync(); await sb.sync();
  assert.equal(a.state.messages.length, 2);
  assert.equal(b.state.messages.length, 2);
  assert.equal(a.state.conflicts.length, 0);
});
test("unknown successful PUT is reconciled idempotently after restart and re-unlock", async (t) => {
  const dav = await davFixture(); t.after(() => dav.close());
  const folder = await mkdtemp(join(tmpdir(), "niria-sync-restart-"));
  const filename = join(folder, "companion.sqlite");
  const first = new CompanionStore(filename);
  let second;
  t.after(async () => {
    if (first.db.isOpen) first.close();
    if (second?.db.isOpen) second.close();
    await rm(folder, { recursive: true, force: true });
  });
  let lost = true;
  const initial = new SyncService(first, { fetchImpl: async (url, options) => {
    const result = await fetch(url, options);
    if (options.method === "PUT" && url.endsWith("state.niria") && lost) {
      lost = false; await result.body?.cancel(); throw new Error("lost response");
    }
    return result;
  } });
  initial.configure({ baseUrl: dav.baseUrl, auto: false });
  const { code } = initial.createPair();
  first.addUser("只能保留一份的消息");
  await assert.rejects(initial.sync(), /无法连接/);
  const device = initial.status().device;
  initial.lock(); first.close();
  second = new CompanionStore(filename);
  const resumed = new SyncService(second);
  assert.equal(resumed.status().device, device);
  assert.equal(resumed.status().unlocked, false);
  resumed.configure({ baseUrl: dav.baseUrl, auto: false }); resumed.unlock(code);
  await resumed.sync();
  assert.equal(second.state.messages.length, 1);
  assert.equal(second.state.conflicts.length, 0);
  assert.equal(resumed.meta.manifest.records.find((r) => r.kind === "message").nodes.length, 1);
});
test("concurrent deletion of a conflicted memory removes all preserved plaintext", async (t) => {
  const { a, b, sa, sb, code } = await pair(t);
  const id = a.addMemory({ content: "原始记忆" });
  await sa.sync(); await sb.join(code);
  a.editMemory(id, { content: "A 的秘密" }); b.editMemory(id, { content: "B 的秘密" });
  await sa.sync(); await sb.sync();
  assert.equal(b.state.conflicts.length, 1);
  b.deleteMemory(id);
  assert.equal(b.state.conflicts.length, 0);
  assert.equal(JSON.stringify(sb.meta.manifest).includes("秘密"), false);
  await sb.sync(); await sa.sync();
  assert.equal(a.state.memories[0].deleted, true);
});
test("withdrawal defeats a concurrent offline content edit without retaining its plaintext in remote heads", async (t) => {
  const { a, b, sa, sb, code, dav } = await pair(t);
  const id = a.addMemory({ content: "共享记忆" });
  await sa.sync(); await sb.join(code);
  a.editMemory(id, { allowSync: false });
  b.editMemory(id, { content: "离线端新编辑的隐私内容" });
  await sa.sync(); await sb.sync(); await sa.sync();
  const parsed = parsePairing(code);
  const manifest = unseal([...dav.objects.values()][0].data.toString(), parsed.key, parsed.vaultId, parsed.identityId);
  assert.equal(JSON.stringify(manifest).includes("隐私内容"), false);
  assert.equal(b.state.memories[0].allowSync, false);
  assert.equal(b.state.conflicts.length, 0);
});
