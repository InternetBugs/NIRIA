import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { animeGray, detectAnimeFaces } from "../prototype/public/animeface.js";

const model = JSON.parse(await readFile(new URL("../prototype/public/vendor/animeface/model.json", import.meta.url)));
test("local classifier retains fixed provenance and returns no faces for empty/flat input", () => {
  assert.equal(model.stages.length, 20);
  assert.equal(model.features.length, 642);
  assert.equal(model.stages.reduce((sum, [, trees]) => sum + trees.length, 0), 771);
  for (const value of [0, 127, 255])
    assert.deepEqual(detectAnimeFaces(new Uint8Array(80 * 80).fill(value), 80, 80, model), []);
});
test("RGBA conversion composites transparent colors onto white and equalizes opaque grayscale", () => {
  const image = { width: 3, height: 1, data: new Uint8ClampedArray([0,0,0,0, 10,10,10,255, 100,100,100,255]) };
  assert.deepEqual([...animeGray(image)], [255, 0, 128]);
  image.data.set([255, 0, 100, 0]);
  assert.deepEqual([...animeGray(image)], [255, 0, 128]);
});
test("face scan rejects invalid input and bounds grouping work on pathological candidates", () => {
  assert.throws(() => animeGray({ width: 641, height: 1, data: new Uint8Array(2564) }));
  assert.throws(() => detectAnimeFaces(new Uint8Array(4), 2, 2, {}));
  const alwaysPass = { format: "niria-animeface-lbp", version: 1, size: 24, features: [], stages: [] };
  assert.throws(() => detectAnimeFaces(new Uint8Array(100 * 100), 100, 100, alwaysPass), /过多/);
});
