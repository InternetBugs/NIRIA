import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import { validateAvatar } from "../core/store.mjs";

// Real localhost transport through /api/generate and the image adapter.
// The provider echoes synthetic pixels; this does not test model quality.
export async function verifyImageGeneration({ store, evaluate, navigate }) {
  const original = store.snapshot(), result = {}, errors = [];
  const model = "isolated-image-call-model", key = "isolated-image-call-key";
  let mode = "hold", attempts = 0, disconnected = false, release;
  const upstream = http.createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/private-image-path/v1/images/edits");
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      const body = new Request("http://fixture.local", {
        method: "POST", headers: request.headers, body: Readable.toWeb(request), duplex: "half"
      });
      const form = await body.formData();
      assert.equal(form.get("n"), "1");
      assert.equal(form.get("model"), model);
      assert.equal(form.get("image").type, "image/png");
      const encoded = Buffer.from(await form.get("image").arrayBuffer()).toString("base64");
      attempts++;
      const reply = () => {
        if (!response.destroyed) {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ data: [{ b64_json: encoded }] }));
        }
      };
      if (mode === "hold") {
        response.on("close", () => { if (!response.writableFinished) disconnected = true; });
        release = reply;
      } else if (mode === "fail") {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: key }));
      } else reply();
    } catch (error) {
      errors.push(error.message);
      if (!response.destroyed) { response.writeHead(500); response.end("{}"); }
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/private-image-path/v1`;
  const wait = async (check) => {
    for (let index = 0; index < 200; index++) {
      if (typeof check === "function" ? await check() : await evaluate(check)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Image call condition failed: ${check}`);
  };
  const calls = () => store.state.calls.filter((call) => call.kind === "image" && call.model === model);
  const start = async (action) => {
    await evaluate(`document.querySelector('[data-generate="${action}"]').click()`);
    await wait("document.querySelector('#confirm-dialog').open");
    await evaluate("document.querySelector('#confirm-generate').click()");
  };
  const home = async () => {
    await navigate("/");
    await wait("document.readyState === 'complete' && document.querySelector('#calls-list')?.children.length > 0");
    await evaluate("document.querySelector('#open-settings').click()");
    await wait("document.querySelector('#settings-dialog').open");
    await evaluate("document.querySelector('[data-tab=\"backup\"]').click()");
    await wait("!document.querySelector('[data-settings=\"backup\"]').hidden");
  };
  try {
    const avatar = await evaluate(`(() => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 480;
      const context = canvas.getContext('2d');
      context.fillStyle = '#2e5078'; context.fillRect(60,140,200,300);
      context.fillStyle = '#e7c8b0'; context.fillRect(110,45,100,110);
      context.fillStyle = '#332738'; context.fillRect(120,80,16,8); context.fillRect(183,80,16,8);
      return {format:'niria-avatar-prototype',version:1,original:canvas.toDataURL('image/png'),actions:{}};
    })()`);
    store.mutate((state) => { state.avatar = validateAvatar(avatar); });
    const avatarKey = store.avatarKey;
    await navigate("/avatar");
    await wait("document.querySelector('#source-caption')?.textContent.includes('已载入') && !document.querySelector('#save-companion').disabled");
    await evaluate(`(() => {
      document.querySelector('#settings-button').click();
      document.querySelector('#base-url').value = ${JSON.stringify(baseUrl)};
      document.querySelector('#model').value = ${JSON.stringify(model)};
      document.querySelector('#api-key').value = ${JSON.stringify(key)};
      document.querySelector('#image-remember').checked = false;
      document.querySelector('#image-reuse').checked = false;
      document.querySelector('#settings-form').requestSubmit();
    })()`);
    await wait("!document.querySelector('#settings-dialog').open && !document.querySelector('[data-generate=\"blink\"]').disabled");
    result.imageCallLocationExplained = await evaluate("!document.querySelector('#image-log-location').hidden");
    await start("blink");
    await wait(() => attempts === 1 && calls()[0]?.status === "pending");
    result.imagePendingLoggedBeforeResponse = store.db.prepare(
      "SELECT json_extract(data,'$.status') AS status FROM call_records WHERE json_extract(data,'$.model')=?"
    ).get(model)?.status === "pending";
    result.imageStopAvailableWhileWaiting = await evaluate("!document.querySelector('#stop-generation').hidden");
    await evaluate("document.querySelector('#stop-generation').click()");
    await wait("document.querySelector('#stop-generation').hidden && document.querySelector('#notice').textContent.includes('可能已经处理并计费')");
    await wait(() => disconnected && calls()[0]?.status === "unknown");
    result.imageStopAbortsUpstreamAndRecordsUnknown = true;
    result.imageStopExplainsUncertainBilling = await evaluate("document.querySelector('#request-log').textContent.includes('结果未知，可能已计费')");
    release();
    await evaluate("new Promise(resolve => setTimeout(resolve, 100))");
    result.imageLateResponseCannotOpenReview = await evaluate("!document.querySelector('#review-dialog').open && document.querySelector('#asset-count').textContent === '0 / 4'");
    result.imageStopHasNoRetry = attempts === 1;

    mode = "success";
    await start("smile");
    await wait("document.querySelector('#review-dialog').open && !document.querySelector('#accept-result').disabled && !document.querySelector('[data-generate=\"smile\"]').disabled");
    result.imageReturnedRecordPrecedesAdoption = calls()[1]?.status === "completed" && store.avatarKey === avatarKey;
    result.imageStopHiddenDuringReview = await evaluate("document.querySelector('#stop-generation').hidden");
    await evaluate("document.querySelector('#discard-result').click()");
    await wait("!document.querySelector('#review-dialog').open");
    result.imageDiscardPreservesReturnedRecord = calls()[1]?.status === "completed" && store.avatarKey === avatarKey;

    mode = "fail";
    await start("curious");
    await wait(() => calls()[2]?.status === "failed");
    await wait("!document.querySelector('[data-generate=\"curious\"]').disabled && document.querySelector('#request-log').textContent.includes('没有自动重试')");
    result.imageFailurePreservesAvatar = store.avatarKey === avatarKey && await evaluate("!document.querySelector('#notice').textContent.includes('isolated-image-call-key')");
    await home();
    await wait("document.querySelector('#calls-list').textContent.includes('图片生成 · 闭眼')");
    result.imageCallHistoryHasChineseActions = await evaluate(`(() => {
      const text = document.querySelector('#calls-list').textContent;
      return ['图片生成 · 闭眼','结果未知','图片生成 · 微笑','已返回','图片生成 · 疑惑','失败'].every(value=>text.includes(value));
    })()`);
    await home(); // Fresh document/session proves the record is not page state.
    await wait("document.querySelectorAll('#calls-list .call-item').length >= 3");
    result.imageCallHistorySurvivesReload = await evaluate("document.querySelector('#calls-list').textContent.includes('图片生成 · 闭眼') && document.querySelector('#calls-list').textContent.includes('结果未知')");
    const serialized = JSON.stringify(calls());
    result.imageCallRecordsContainNoPayloadOrSecret = [key, "private-image-path", "data:image", "prompt"].every((value) => !serialized.includes(value));
    result.imageExplicitRequestsOnly = attempts === 3 && calls().length === 3 &&
      store.state.usage[calls()[0].day].image === (original.usage[calls()[0].day]?.image || 0) + 3;
    assert.deepEqual(errors, []);
    assert.ok(Object.values(result).every(Boolean), JSON.stringify(result));
    return result;
  } finally {
    release?.();
    await new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); });
    store.mutate(() => { store.state = original; });
    await navigate("/");
    await wait("document.readyState === 'complete' && document.querySelector('#calls-list')?.children.length > 0");
  }
}
