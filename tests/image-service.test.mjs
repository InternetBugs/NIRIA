import test from "node:test";
import assert from "node:assert/strict";
import { generateAction, imageEndpoint, pngBytes, ServiceError } from "../prototype/image-service.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const image = `data:image/png;base64,${PNG}`;
const input = {
  baseUrl: "https://images.example/v1/",
  model: "test-image-model",
  apiKey: "test-secret",
  action: "blink",
  image
};

test("uses one multipart image edit and keeps secrets out of returned assets", async () => {
  let calls = 0;
  const result = await generateAction(input, {
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, "https://images.example/v1/images/edits");
      assert.equal(options.method, "POST");
      assert.equal(options.headers.Authorization, "Bearer test-secret");
      assert.equal(options.redirect, "error");
      assert.equal(options.body.get("n"), "1");
      assert.equal(options.body.get("model"), input.model);
      assert.equal(options.body.get("image").type, "image/png");
      assert.match(options.body.get("prompt"), /Close both eyes/);
      assert.match(options.body.get("prompt"), /Preserve the exact identity/);
      assert.equal(options.body.has("input_fidelity"), false);
      assert.equal(options.body.has("background"), false);
      return Response.json({ data: [{ b64_json: PNG }] });
    }
  });
  assert.equal(calls, 1);
  assert.deepEqual(result, { image, action: "blink", label: "闭眼" });
  assert.equal(JSON.stringify(result).includes(input.apiKey), false);
});

test("optional provider capabilities are sent only when requested", async () => {
  await generateAction({ ...input, highFidelity: true, transparent: true }, {
    fetchImpl: async (_, options) => {
      assert.equal(options.body.get("input_fidelity"), "high");
      assert.equal(options.body.get("background"), "transparent");
      return Response.json({ data: [{ b64_json: PNG }] });
    }
  });
});

test("local services can omit authorization", async () => {
  await generateAction({ ...input, apiKey: "", baseUrl: "http://127.0.0.1:9090/v1" }, {
    fetchImpl: async (_, options) => {
      assert.equal(Object.hasOwn(options.headers, "Authorization"), false);
      return Response.json({ data: [{ b64_json: PNG }] });
    }
  });
});

test("rejects credential-bearing URLs, insecure remote URLs and full endpoint URLs", () => {
  for (const url of [
    "https://user:password@example.com/v1",
    "https://example.com/v1?key=secret",
    "http://example.com/v1",
    "file:///C:/private",
    "https://example.com/v1/images/edits"
  ]) assert.throws(() => imageEndpoint(url), ServiceError);
  assert.equal(imageEndpoint("https://example.com/v1"), "https://example.com/v1/images/edits");
});

test("invalid or inherited actions never invoke a paid request", async () => {
  let calls = 0;
  for (const action of ["constructor", "__proto__", "dance"]) {
    await assert.rejects(generateAction({ ...input, action }, {
      fetchImpl: async () => { calls++; }
    }), /请选择一个支持的动作/);
  }
  assert.equal(calls, 0);
});

test("validates source image before making an upstream request", async () => {
  let called = false;
  await assert.rejects(generateAction({ ...input, image: "data:image/png;base64,YWJj" }, {
    fetchImpl: async () => { called = true; }
  }), /有效的 PNG/);
  assert.equal(called, false);
  assert.throws(() => pngBytes("data:image/svg+xml;base64,AAAA"), ServiceError);
});
test("PNG dimensions and header are checked before upload and on returned assets", async () => {
  const huge = Buffer.from(PNG, "base64");
  huge.writeUInt32BE(5000, 16); huge.writeUInt32BE(5000, 20);
  const oversized = `data:image/png;base64,${huge.toString("base64")}`;
  let calls = 0;
  await assert.rejects(generateAction({ ...input, image: oversized }, { fetchImpl: async () => { calls++; } }), /2000 万像素/);
  assert.equal(calls, 0);
  await assert.rejects(generateAction(input, { fetchImpl: async () => { calls++; return Response.json({ data: [{ b64_json: huge.toString("base64") }] }); } }), /2000 万像素/);
  assert.equal(calls, 1);
  assert.throws(() => pngBytes(`data:image/png;base64,${Buffer.from(PNG, "base64").subarray(0, 12).toString("base64")}`), /有效的 PNG/);
});

test("provider failures are not retried or allowed to echo a secret", async () => {
  let calls = 0;
  await assert.rejects(generateAction(input, {
    fetchImpl: async () => {
      calls++;
      return Response.json({ error: `unauthorized ${input.apiKey}` }, { status: 401 });
    }
  }), (error) => {
    assert.equal(error.status, 502);
    assert.match(error.message, /访问权限/);
    assert.equal(error.message.includes(input.apiKey), false);
    return true;
  });
  assert.equal(calls, 1);
});

test("does not follow provider image URLs or accept malformed output", async () => {
  let calls = 0;
  await assert.rejects(generateAction(input, {
    fetchImpl: async () => {
      calls++;
      return Response.json({ data: [{ url: "https://untrusted.example/private" }] });
    }
  }), /Base64 PNG/);
  assert.equal(calls, 1);
  await assert.rejects(generateAction(input, {
    fetchImpl: async () => new Response("not json")
  }), /无法读取/);
});

test("timeout communicates unknown provider outcome rather than retrying", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(generateAction(input, {
    signal: controller.signal,
    fetchImpl: async () => { throw new DOMException("aborted", "AbortError"); }
  }), /服务可能已处理请求/);
});
