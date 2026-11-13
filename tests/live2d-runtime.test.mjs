import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { live2DAvatarFixture } from "./fixtures/live2d.mjs";
import { live2DRuntimeInfo } from "../prototype/public/live2d-runtime.js";

test("bundled SDK manifest verifies the actual Core, compiled framework, shaders and notices", { skip: !live2DRuntimeInfo.available && "Optional SDK not installed" }, async () => {
  const root = new URL("../prototype/public/vendor/live2d/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
  assert.equal(live2DRuntimeInfo.available, true);
  assert.equal(manifest.sdk, live2DRuntimeInfo.version);
  assert.equal(manifest.files["core-LICENSE.md"].bytes > 0, true);
  assert.equal(manifest.files["framework-LICENSE.md"].bytes > 0, true);
  assert.equal(Object.keys(manifest.files).filter((path) => /\.(?:vert|frag)$/.test(path)).length, 13);
  for (const [path, expected] of Object.entries(manifest.files)) {
    assert.equal(path.split("/").includes(".."), false);
    const bytes = await readFile(new URL(path, root));
    assert.equal(bytes.byteLength, expected.bytes, path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256, path);
  }
});

test("official Core rejects structurally plausible corrupt moc bytes without changing input", { skip: !live2DRuntimeInfo.available && "Optional SDK not installed" }, async () => {
  const { validateLive2DMoc } = await import("../core/live2d-moc.mjs");
  const avatar = live2DAvatarFixture(), before = structuredClone(avatar);
  for (let index = 0; index < 20; index++)
    assert.throws(() => validateLive2DMoc(avatar), (error) => error.status === 422 && error.message.includes("损坏"));
  assert.deepEqual(avatar, before);
});
