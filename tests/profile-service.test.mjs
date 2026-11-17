import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { CompanionStore, validateSnapshot } from "../core/store.mjs";
import { CompanionService, complete } from "../core/chat-service.mjs";
import { ProfileService, profileFields } from "../core/profile-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";

const draft = { name: "月见", persona: "性格坦诚，喜欢观察星空。", style: "简洁自然，偶尔幽默。", relationship: "正在彼此了解。" };
const image = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const avatar = { format: "niria-avatar-prototype", version: 1, source: image, actions: {} };
function setup(t, { completion, timeoutMs = 1000, connected = true } = {}) {
  const store = new CompanionStore(), requests = [];
  const companion = new CompanionService(store, { completion: completion || (async (_, messages) => {
    requests.push(structuredClone(messages)); return JSON.stringify(draft);
  }) });
  if (connected) companion.configure({ baseUrl: "http://localhost:8181/v1", model: "fixture-profile", apiKey: "private-profile-key" });
  const profile = new ProfileService(store, companion, { timeoutMs });
  t.after(() => store.close());
  return { store, companion, profile, requests,
    input: (overrides = {}) => ({ basis: profile.basis(), mode: "text", text: "人物名叫月见，喜欢星空，说话自然。", ...overrides }) };
}

test("long description creates a reviewable draft without changing identity, history, avatar or memories", async (t) => {
  const { store, profile, requests, input } = setup(t);
  store.identity({ userName: "朋友" });
  store.addUser("不得发送的私人聊天");
  store.addMemory({ content: "不得发送的私人记忆" });
  const before = store.snapshot();
  const result = await profile.generate(input({ text: "月见喜欢星空。".repeat(1000) }));
  assert.deepEqual(result.draft, draft);
  assert.equal(result.basis, profile.basis());
  assert.equal(requests.length, 1);
  const payload = JSON.stringify(requests[0]);
  for (const privateText of ["不得发送的私人聊天", "不得发送的私人记忆", "private-profile-key", "朋友"]) {
    assert.equal(payload.includes(privateText), false);
  }
  assert.deepEqual(store.state.identity, before.identity);
  assert.deepEqual(store.state.messages, before.messages);
  assert.deepEqual(store.state.memories, before.memories);
  assert.equal(store.state.avatar, before.avatar);
  assert.equal(store.state.calls[0].purpose, "profile");
  assert.equal(store.state.calls[0].kind, "test");
  assert.equal(store.state.calls[0].status, "completed");
  assert.equal(profile.status().remaining, 9);
  assert.doesNotThrow(() => validateSnapshot(store.snapshot()));
});

test("avatar generation sends a PNG snapshot through the existing multimodal adapter without model files", async (t) => {
  const { store, profile, requests, input } = setup(t);
  store.mutate((state) => { state.avatar = avatar; });
  const result = await profile.generate(input({ mode: "avatar", image, text: "" }));
  const content = requests[0][1].content;
  assert.equal(content[1].type, "image_url");
  assert.equal(content[1].image_url.url, image);
  assert.deepEqual(result.draft, draft);
  let received;
  await complete({ baseUrl: "http://localhost:8181/v1", model: "vision", apiKey: "" }, requests[0], {
    fetchImpl: async (_, options) => {
      received = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] }));
    }
  });
  assert.deepEqual(received.messages, requests[0]);
  assert.equal(JSON.stringify(received).includes(".moc3"), false);
});

test("confirmed drafts accept edits but preserve identity ID, username, avatar and existing records", async (t) => {
  const { store, profile, input } = setup(t);
  store.identity({ userName: "主人自己设定的称呼" });
  store.mutate((state) => { state.avatar = avatar; });
  store.addUser("共同经历");
  const before = store.snapshot(), result = await profile.generate(input());
  profile.apply({ ...result, draft: { ...result.draft, name: "修改后的月见" } });
  assert.equal(store.state.identity.name, "修改后的月见");
  assert.equal(store.state.identity.userName, before.identity.userName);
  assert.equal(store.state.identity.id, before.identity.id);
  assert.deepEqual(store.state.avatar, before.avatar);
  assert.deepEqual(store.state.messages, before.messages);
  assert.deepEqual(store.state.memories, before.memories);
});

for (const [label, change] of [
  ["identity", ({ store }) => store.identity({ name: "用户的新资料" })],
  ["avatar", ({ store }) => store.mutate((state) => { state.avatar = avatar; })],
  ["connection", ({ companion }) => { companion.connection = { ...companion.connection, model: "changed" }; }],
  ["history restore", ({ store }) => { store.restoreVersion = "different-restored-history"; }]
]) {
  test(`pending and generated profile drafts are rejected after ${label} changes`, async (t) => {
    let release;
    const context = setup(t, { completion: async () => new Promise((resolve) => { release = resolve; }) });
    const pending = context.profile.generate(context.input());
    change(context); release(JSON.stringify(draft));
    await assert.rejects(pending, { status: 409 });
    assert.equal(context.companion.active, null);
    const oldBasis = context.profile.basis();
    change(context);
    if (label === "avatar") context.store.mutate((state) => { state.avatar = null; });
    if (label === "connection") context.companion.connection.model = "changed-again";
    if (label === "history restore") context.store.restoreVersion = "yet-another-restore";
    if (label === "identity") context.store.identity({ name: "又一份资料" });
    assert.throws(() => context.profile.apply({ basis: oldBasis, draft }), { status: 409 });
  });
}

test("invalid local inputs never submit a request or add usage", async (t) => {
  const { store, profile, requests, input } = setup(t);
  for (const overrides of [
    { mode: "unknown" }, { basis: "stale" }, { text: "" }, { text: "x".repeat(20001) },
    { image }, { mode: "avatar", image }, { text: [] }
  ]) await assert.rejects(profile.generate(input(overrides)));
  store.mutate((state) => { state.avatar = avatar; });
  for (const badImage of ["https://example.invalid/image.png", "", "data:image/png;base64,AAA="]) {
    await assert.rejects(profile.generate(input({ mode: "avatar", image: badImage })));
  }
  assert.equal(requests.length, 0);
  assert.equal(store.state.calls.length, 0);
});

test("profile generation requires a configured model and rejects concurrent paid requests", async (t) => {
  const context = setup(t, { connected: false });
  await assert.rejects(context.profile.generate(context.input()), /先配置对话服务/);
  context.companion.configure({ baseUrl: "http://localhost:8181/v1", model: "fixture" });
  const other = new AbortController();
  context.companion.active = other;
  await assert.rejects(context.profile.generate(context.input()), { status: 409 });
  assert.equal(context.companion.active, other);
  assert.equal(context.store.state.calls.length, 0);
  context.companion.active = null;
});

for (const raw of ["not JSON", "[]", "{}", JSON.stringify({ ...draft, id: "bad" }),
  JSON.stringify({ ...draft, name: "" }), JSON.stringify({ ...draft, persona: "x".repeat(4001) })]) {
  test(`malformed model draft is rejected without overwriting existing profile: ${raw.slice(0, 30)}`, async (t) => {
    const { store, profile, input } = setup(t, { completion: async () => raw });
    const before = structuredClone(store.state.identity);
    await assert.rejects(profile.generate(input()), { status: 502 });
    assert.deepEqual(store.state.identity, before);
    assert.equal(store.state.calls.length, 1);
    assert.equal(profile.status().remaining, 9);
    assert.equal(profile.active, null);
  });
}

test("fenced JSON can be reviewed while extra or missing draft fields cannot be applied", async (t) => {
  const { store, profile, input } = setup(t, { completion: async () => `\`\`\`json\n${JSON.stringify(draft)}\n\`\`\`` });
  const result = await profile.generate(input());
  assert.deepEqual(result.draft, draft);
  for (const value of [{ ...draft, userName: "overwrite" }, { name: "missing" }, { ...draft, style: " " }]) {
    assert.throws(() => profile.apply({ basis: profile.basis(), draft: value }), { status: 400 });
  }
  assert.equal(store.state.identity.name, "Niria");
  assert.throws(() => profileFields(null), { status: 400 });
});

test("cancellation or timeout discards even an uncancelable late draft and records unknown without retry", async (t) => {
  let release;
  const { profile, companion, store, input } = setup(t, { timeoutMs: 15,
    completion: async () => new Promise((resolve) => { release = resolve; }) });
  const pending = profile.generate(input());
  await new Promise((resolve) => setTimeout(resolve, 25));
  release(JSON.stringify(draft));
  await assert.rejects(pending, { status: 504 });
  assert.equal(store.state.calls.length, 1);
  assert.equal(store.state.calls[0].status, "unknown");
  assert.equal(companion.active, null);
  assert.equal(store.state.identity.name, "Niria");
});

test("daily profile limit includes failed attempts but does not consume chat or memory allowances", async (t) => {
  const { profile, store, input } = setup(t, { completion: async () => { throw new Error("synthetic failure"); } });
  for (let index = 0; index < 10; index++) await assert.rejects(profile.generate(input()));
  await assert.rejects(profile.generate(input()), { status: 429 });
  assert.equal(store.state.calls.length, 10);
  const counts = Object.values(store.state.usage)[0];
  assert.equal(counts.profile, 10);
  assert.equal(counts.chat, undefined);
  assert.equal(counts.memory, undefined);
});

test("call recording failures prevent external profile requests", async (t) => {
  const { profile, store, requests, input } = setup(t);
  const mutate = store.mutate;
  store.mutate = () => { throw new Error("isolated disk failure"); };
  try { await assert.rejects(profile.generate(input()), { status: 503 }); }
  finally { store.mutate = mutate; }
  assert.equal(requests.length, 0);
  assert.equal(profile.active, null);
});

test("authenticated API previews, validates stale bases and applies only reviewed fields", async (t) => {
  const { store, companion } = setup(t);
  const server = createPrototypeServer({ store, companion });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    server.connections.services.sync.lock();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { token } = await (await fetch(`${origin}/api/session`)).json();
  const state = () => fetch(`${origin}/api/state`, { headers: { "X-Niria-Token": token } }).then((response) => response.json());
  const post = async (path, body, headers = {}) => {
    const response = await fetch(`${origin}${path}`, { method: "POST",
      headers: { "X-Niria-Token": token, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const input = { basis: (await state()).profile.basis, text: "一大段人物设定", mode: "text" };
  assert.equal((await post("/api/identity/draft", input, { "X-Niria-Token": "invalid" })).status, 403);
  assert.equal((await post("/api/identity/draft", input, { Origin: "https://other.invalid" })).status, 403);
  assert.equal(store.state.calls.length, 0);
  const result = await post("/api/identity/draft", input);
  assert.equal(result.status, 200);
  assert.equal(store.state.identity.name, "Niria");
  assert.equal((await post("/api/identity/draft/apply", { ...result.body, draft: { ...draft, userName: "forbidden" } })).status, 400);
  assert.equal((await post("/api/identity/draft/apply", result.body)).status, 200);
  assert.equal(store.state.identity.name, draft.name);
  assert.equal((await post("/api/identity/draft/apply", result.body)).status, 409);
});
