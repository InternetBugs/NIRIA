import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { detectAnimeFaces } from "../prototype/public/animeface.js";

// Independent OpenCV results from rendered SDK test materials, not a synthetic
// model. Fixture generation remains local; no character image ships in the app.
const directory = new URL("../artifacts/animeface-validation/", import.meta.url);
const cases = JSON.parse(await readFile(new URL("cases.json", directory), "utf8"));
const model = JSON.parse(await readFile(new URL("../prototype/public/vendor/animeface/model.json", import.meta.url), "utf8"));
const results = [];
for (const example of cases) {
  const gray = new Uint8Array(await readFile(new URL(example.file, directory)));
  const started = performance.now();
  const actual = detectAnimeFaces(gray, example.width, example.height, model);
  const milliseconds = Math.round(performance.now() - started);
  assert.equal(actual.length, example.expected.length, example.name);
  for (const expected of example.expected) {
    assert.ok(actual.some((box) => {
      const intersection = Math.max(0, Math.min(box.x + box.width, expected[0] + expected[2]) - Math.max(box.x, expected[0])) *
        Math.max(0, Math.min(box.y + box.height, expected[1] + expected[3]) - Math.max(box.y, expected[1]));
      return intersection / (box.width * box.height + expected[2] * expected[3] - intersection) > .75;
    }), example.name);
  }
  results.push({ name: example.name, opencv: example.expected, javascript: actual, milliseconds });
}
console.log(JSON.stringify({ passed: true, results }, null, 2));
