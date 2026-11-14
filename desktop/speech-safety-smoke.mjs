import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { now } from "../core/store.mjs";

// Real localhost TTS transport with synthetic silent WAV, never a voice model.
export async function verifySpeechSafety({ store, evaluate, navigate, capture }) {
  const original = store.snapshot(), result = {}, errors = [];
  const model = "isolated-speech-safety", key = "isolated-speech-secret";
  let mode = "hold", attempts = 0, disconnects = 0, release;
  const wav = Buffer.alloc(1644);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(1600, 40);
  let content = "这是一条隔离的朗读测试文字。";
  const upstream = http.createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/private-speech/v1/audio/speech");
      assert.equal(request.headers.authorization, `Bearer ${key}`);
      let body = "";
      for await (const chunk of request) body += chunk;
      assert.deepEqual(JSON.parse(body), { model, voice: "isolated-voice", input: content, response_format: "wav" });
      attempts++;
      const reply = () => {
        if (!response.destroyed) { response.writeHead(200, { "Content-Type": "audio/wav" }); response.end(wav); }
      };
      if (mode === "hold") {
        response.on("close", () => { if (!response.writableFinished) disconnects++; });
        release = reply;
      } else if (mode === "fail") {
        response.writeHead(500); response.end(key);
      } else reply();
    } catch (error) {
      errors.push(error.message);
      if (!response.destroyed) { response.writeHead(500); response.end("{}"); }
    }
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/private-speech/v1`;
  const wait = async (check) => {
    for (let index = 0; index < 200; index++) {
      if (typeof check === "function" ? await check() : await evaluate(check)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Speech safety condition failed: ${check}`);
  };
  const calls = () => store.state.calls.filter((call) => call.kind === "speech" && call.model === model);
  const message = { id: randomUUID(), role: "assistant", content, revision: 1, status: "completed",
    deleted: false, createdAt: now(), updatedAt: now() };
  const start = async () => {
    await wait("document.querySelector('#speech-player')?.getAttribute('aria-busy') !== 'true'");
    await evaluate(`[...document.querySelectorAll('.message[data-id="${message.id}"] button')].find(button=>button.textContent.includes('朗读')).click()`);
  };
  const stopped = async () => wait("document.querySelector('#speech-player').hidden && document.querySelector('#speech-player').getAttribute('aria-busy') === 'false' && !document.querySelector('#speech-audio').getAttribute('src')");
  try {
    store.mutate((state) => { state.messages = [message]; });
    await navigate("/");
    await wait("document.readyState === 'complete' && document.querySelector('#calls-list')?.children.length > 0");
    await evaluate(`(() => {
      document.querySelector('#open-settings').click();
      document.querySelector('[data-tab="speech"]').click();
      document.querySelector('#speech-base').value = ${JSON.stringify(baseUrl)};
      document.querySelector('#speech-model').value = ${JSON.stringify(model)};
      document.querySelector('#speech-voice').value = 'isolated-voice';
      document.querySelector('#speech-key').value = ${JSON.stringify(key)};
      document.querySelector('#speech-auto').checked = false;
      document.querySelector('#speech-limit').value = '20';
      document.querySelector('#speech-reuse').checked = false;
      document.querySelector('#speech-remember').checked = false;
      document.querySelector('#speech-form').requestSubmit();
    })()`);
    await wait(`!document.querySelector('#settings-dialog').open && [...document.querySelectorAll('.message[data-id="${message.id}"] button')].some(button=>button.textContent.includes('朗读'))`);
    result.speechConfigurationMakesNoRequest = attempts === 0;
    await start();
    await wait(() => attempts === 1 && calls()[0]?.status === "pending");
    result.speechWaitingHasVisibleStop = await evaluate("!document.querySelector('#speech-player').hidden && document.querySelector('#speech-audio').hidden && document.querySelector('#speech-stop').textContent.includes('停止等待')");
    if (capture) {
      await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
      await capture();
    }
    await evaluate(`[...document.querySelectorAll('.message[data-id="${message.id}"] button')].find(button=>button.textContent.includes('朗读')).click()`);
    result.speechDuplicateClickMakesNoRequest = attempts === 1;
    await evaluate("document.querySelector('#speech-stop').click()");
    await stopped();
    await wait(() => disconnects === 1 && calls()[0]?.status === "unknown");
    result.speechStopAbortsUpstream = true;
    result.speechStopExplainsBilling = await evaluate("document.querySelector('#notice').textContent.includes('可能已经处理并计费')");
    release();
    result.speechStoppedResultNeverPlays = await evaluate("!document.querySelector('#speech-audio').getAttribute('src')");

    // Buffer a complete real response, then deliberately ignore the page's
    // AbortSignal. This isolates the UI's own late-delivery check.
    mode = "success";
    await evaluate(`(() => {
      window.__speechSafetyFetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await window.__speechSafetyFetch(...args);
        if (args[0] !== '/api/speech/speak') return response;
        const text = await response.text();
        window.__speechSafetyBuffered = true;
        await new Promise(resolve=>window.__speechSafetyRelease=resolve);
        return new Response(text,{status:response.status,headers:{'Content-Type':'application/json'}});
      };
    })()`);
    await start();
    await wait("window.__speechSafetyBuffered === true");
    assert.equal(calls()[1]?.status, "completed");
    await evaluate("document.querySelector('#speech-stop').click(); window.__speechSafetyRelease(); window.fetch=window.__speechSafetyFetch; void 0");
    await stopped();
    result.speechBufferedLateResponseCannotPlay = attempts === 2 && calls()[1].status === "completed";

    await start();
    await wait("!document.querySelector('#speech-player').hidden && !document.querySelector('#speech-audio').hidden && document.querySelector('#speech-audio').src.startsWith('blob:') && document.querySelector('#speech-player').getAttribute('aria-busy') === 'false'");
    result.speechSuccessOffersAudio = attempts === 3 && calls()[2]?.status === "completed";
    await evaluate("document.querySelector('#speech-stop').click()");
    await stopped();
    result.speechStopPlaybackRevokesAudio = attempts === 3;

    mode = "fail";
    await start();
    await wait(() => calls()[3]?.status === "failed");
    await stopped();
    result.speechFailurePreservesText = await evaluate(`document.querySelector('.message[data-id="${message.id}"]').textContent.includes(${JSON.stringify(content)}) && !document.querySelector('#notice').textContent.includes(${JSON.stringify(key)})`);

    mode = "hold";
    await start();
    await wait(() => attempts === 5 && calls()[4]?.status === "pending");
    content = "这条文字已经更正，旧音频不能播放。";
    store.mutate((state) => {
      const selected = state.messages.find((item) => item.id === message.id);
      selected.content = content; selected.revision++; selected.updatedAt = now();
    });
    await stopped();
    await wait(() => disconnects === 2 && calls()[4]?.status === "unknown");
    result.speechSourceChangeStopsWaiting = true;
    release();

    await start();
    await wait(() => attempts === 6 && calls()[5]?.status === "pending");
    await navigate("/avatar");
    await wait(() => disconnects === 3 && calls()[5]?.status === "unknown");
    result.speechLeavingPageAbortsUpstream = true;
    release();
    await navigate("/");
    await wait(`document.querySelector('.message[data-id="${message.id}"]') && document.querySelector('#calls-list')?.textContent.includes('结果未知')`);
    result.speechHistorySurvivesNavigation = calls().length === 6 &&
      calls().map((call) => call.status).join(",") === "unknown,completed,completed,failed,unknown,unknown";

    // Recovered history belongs to a new identity, not new live replies.
    await evaluate(`(async () => {
      const {token}=await(await fetch('/api/session')).json();
      const response=await fetch('/api/speech/configure',{method:'POST',headers:{'Content-Type':'application/json','X-Niria-Token':token},
        body:JSON.stringify({baseUrl:${JSON.stringify(baseUrl)},model:${JSON.stringify(model)},voice:'isolated-voice',
          reuseSecret:true,auto:true,dailyLimit:20,remember:false})});
      if(!response.ok) throw new Error('isolated speech auto configuration failed');
    })()`);
    const sameIdentity = store.snapshot();
    sameIdentity.messages.push({ ...message, id: randomUUID(), content: "同一位伴侣备份中的旧回复。" });
    store.restore(sameIdentity);
    await wait("document.querySelectorAll('.message.assistant').length === 2");
    await evaluate("new Promise(resolve=>setTimeout(resolve,150))");
    result.speechSameIdentityRestoreDoesNotAutoplay = attempts === 6;
    const replacement = store.snapshot();
    replacement.identity.id = randomUUID();
    replacement.identity.name = "隔离恢复的伴侣";
    replacement.messages.push({ ...message, id: randomUUID(), content: "恢复时带来的旧聊天。" });
    store.restore(replacement);
    await wait("document.querySelector('#companion-name')?.textContent === '隔离恢复的伴侣'");
    await evaluate("new Promise(resolve=>setTimeout(resolve,150))");
    result.speechRecoveredHistoryDoesNotAutoplay = attempts === 6;
    const serialized = JSON.stringify(calls());
    result.speechRecordsContainNoTextOrSecret = [content, message.content, key, "private-speech", "RIFF"].every((value) => !serialized.includes(value));
    result.speechOnlyExplicitRequests = attempts === 6 && calls().length === 6;
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
