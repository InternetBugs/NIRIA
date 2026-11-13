import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { createPrototypeServer } from "../prototype/server.mjs";
import { ServiceError } from "../prototype/image-service.mjs";

async function start(t, options) {
  const server = createPrototypeServer(options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = await (await fetch(`${base}/api/session`)).json();
  const post = (body = "{}", extra = {}) => fetch(`${base}/api/generate`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Niria-Token": session.token,
      ...extra
    },
    body
  });
  return { base, post, token: session.token };
}

test("serves a working page without exposing arbitrary workspace files", async (t) => {
  const { base } = await start(t);
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /NIRIA 形象实验台/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  for (const path of ["/package.json", "/prototype/server.mjs", "/.env"]) {
    assert.equal((await fetch(`${base}${path}`)).status, 404);
  }
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
});

test("rejects foreign origins and forged Host headers", async (t) => {
  const { base, post, token } = await start(t);
  assert.equal((await fetch(`${base}/api/session`, { headers: { Origin: "https://other.example" } })).status, 403);
  // fetch normalizes Host; use the HTTP transport to exercise DNS rebinding defense.
  const forgedStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/generate`, {
      method: "POST",
      headers: {
        Host: "attacker.example",
        "Content-Type": "application/json",
        "X-Niria-Token": token
      }
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    req.once("error", reject);
    req.end("{}");
  });
  assert.equal(forgedStatus, 403);
  assert.equal((await post("{}", { Origin: "https://other.example" })).status, 403);
});

test("requires a session token before any generation", async (t) => {
  let calls = 0;
  const { post } = await start(t, { generator: async () => { calls++; return {}; } });
  assert.equal((await post("{}", { "X-Niria-Token": "wrong" })).status, 403);
  assert.equal(calls, 0);
});

test("one pending generation blocks duplicate paid requests", async (t) => {
  let finish;
  let entered;
  let calls = 0;
  const pending = new Promise((resolve) => { finish = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const { post } = await start(t, {
    generator: async () => { calls++; entered(); return pending; }
  });
  const first = post();
  await started;
  const second = await post();
  assert.equal(second.status, 409);
  finish({ action: "blink", image: "test-only" });
  assert.equal((await first).status, 200);
  assert.equal(calls, 1);
});

test("malformed JSON does not call the provider", async (t) => {
  let calls = 0;
  const { post } = await start(t, { generator: async () => { calls++; } });
  assert.equal((await post("{")).status, 400);
  assert.equal((await post("{}", { "Content-Type": "text/plain" })).status, 415);
  assert.equal(calls, 0);
});

test("unexpected errors do not expose secret-bearing exception details", async (t) => {
  const { post } = await start(t, {
    generator: async () => { throw new Error("secret-test-key"); }
  });
  const response = await post();
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes("secret-test-key"), false);
});

test("generation timeouts release the request slot", async (t) => {
  let calls = 0;
  const { post } = await start(t, {
    timeoutMs: 30,
    generator: async (_, { signal }) => {
      calls++;
      if (calls > 1) return { image: "test-only" };
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new ServiceError(504, "生成超时")), { once: true });
      });
    }
  });
  assert.equal((await post()).status, 504);
  assert.equal((await post()).status, 200);
});
