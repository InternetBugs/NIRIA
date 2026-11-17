import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { CompanionStore } from "../core/store.mjs";
import { CompanionService } from "../core/chat-service.mjs";
import { createPrototypeServer } from "../prototype/server.mjs";

const wait = async (evaluate, condition) => {
  for (let index = 0; index < 240; index++) {
    if (await evaluate(condition)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Model picker condition failed: ${condition}`);
};

export async function verifyChatModels({ evaluate, navigate, capture = async () => {} }) {
  const checks = {}, calls = [];
  let mode = "models";
  const unsafeId = '<img src=x onerror="window.__modelUnsafe=true">';
  const ids = ["chat-alpha", "chat-beta", unsafeId, "x".repeat(150),
    ...Array.from({ length: 230 }, (_, index) => `catalog-${String(index).padStart(3, "0")}`)];
  const upstream = http.createServer((request, response) => {
    calls.push({ path: request.url, method: request.method, key: request.headers.authorization });
    response.setHeader("Content-Type", "application/json");
    if (mode === "denied") { response.writeHead(401); response.end('{"error":"isolated-key-must-stay-private"}'); }
    else if (mode === "unsupported") { response.writeHead(404); response.end("{}"); }
    else response.end(JSON.stringify({ data: mode === "empty" ? [] : ids.map((id) => ({ id })) }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`;
  const store = new CompanionStore(), companion = new CompanionService(store);
  const server = createPrototypeServer({ store, companion });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const open = () => evaluate("document.querySelector('#open-settings').click()");
  const clickFetch = () => evaluate("document.querySelector('#chat-models-fetch').click()");
  const loaded = () => wait(evaluate, "document.querySelector('#chat-model-results').children.length>0 && document.querySelector('#chat-models-fetch').textContent==='获取模型'");
  const search = (value) => evaluate(`(() => {
    const input=document.querySelector('#chat-model-search');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input'));
  })()`);
  try {
    await navigate(`http://127.0.0.1:${server.address().port}`);
    await wait(evaluate, "document.querySelector('#calls-list')?.children.length>0");
    await open();
    await evaluate(`(() => {
      document.querySelector('#chat-base').value=${JSON.stringify(baseUrl)};
      document.querySelector('#chat-key').value='isolated-key-must-stay-private';
    })()`);
    await clickFetch(); await loaded();
    checks.modelsUseDraftBeforeApplying = !companion.connection && server.connections.current.size === 0 &&
      calls.length === 1 && calls[0].path === "/v1/models" && calls[0].method === "GET" &&
      calls[0].key === "Bearer isolated-key-must-stay-private";
    checks.modelsDoNotSelectAutomatically = await evaluate("document.querySelector('#chat-model').value===''");
    checks.largeCatalogIsBounded = await evaluate("document.querySelector('#chat-model-results').children.length===100 && document.querySelector('#chat-models-status').textContent.includes('234')");
    await search("CHAT-");
    checks.modelSearchIsLocalAndCaseInsensitive = calls.length === 1 && await evaluate("document.querySelector('#chat-model-results').children.length===2");
    await evaluate("document.querySelector('#chat-model-results button').click()");
    checks.modelSelectionFillsInputWithoutApplying = !companion.connection && await evaluate("document.querySelector('#chat-model').value==='chat-alpha' && document.querySelector('#chat-models-status').textContent.includes('已选择')");
    await search("<img");
    checks.modelsRenderAsText = await evaluate(`document.querySelector('#chat-model-results').textContent===${JSON.stringify(unsafeId)} &&
      !document.querySelector('#chat-model-results img') && !window.__modelUnsafe`);
    await search("x".repeat(140));
    await capture();
    await search("no-such-model");
    checks.unmatchedSearchRetainsManualEntry = await evaluate("document.querySelector('#chat-model-results').children.length===0 && document.querySelector('#chat-model').value==='chat-alpha'");
    await evaluate(`(() => {
      document.querySelector('#chat-model').value='manual-chat';
      document.querySelector('#chat-model').dispatchEvent(new Event('input'));
      document.querySelector('#connection-form').requestSubmit();
    })()`);
    await wait(evaluate, "!document.querySelector('#settings-dialog').open && document.querySelector('#connection-status').textContent.includes('manual-chat')");
    checks.manualModelCanStillApply = companion.connection.model === "manual-chat";
    await open(); await clickFetch(); await loaded();
    checks.modelsReuseCurrentKeyExplicitly = calls.at(-1).key === "Bearer isolated-key-must-stay-private" &&
      await evaluate("document.querySelector('#chat-key').value==='' && document.querySelector('#chat-reuse').checked");
    const count = calls.length;
    await evaluate(`(() => {
      const input=document.querySelector('#chat-base');input.value+='/changed';input.dispatchEvent(new Event('input'));
    })()`);
    await clickFetch();
    await wait(evaluate, "document.querySelector('#chat-models-status').textContent.includes('服务地址已改变')");
    checks.modelsNeverForwardOldKeyToChangedAddress = count === calls.length && companion.connection.baseUrl === baseUrl;
    await evaluate(`(() => {
      document.querySelector('#chat-base').value=${JSON.stringify(baseUrl)};
      const reuse=document.querySelector('#chat-reuse');reuse.checked=false;reuse.dispatchEvent(new Event('change'));
    })()`);
    await clickFetch(); await loaded();
    checks.modelsSupportKeylessServices = calls.at(-1).key === undefined;

    for (const [nextMode, expected] of [["empty", "空模型列表"], ["unsupported", "手动填写"], ["denied", "被拒绝"]]) {
      mode = nextMode;
      await clickFetch();
      await wait(evaluate, `document.querySelector('#chat-models-status').textContent.includes(${JSON.stringify(expected)})`);
      checks[`modelListHandles${nextMode}`] = await evaluate("document.querySelector('#chat-model').value==='manual-chat' && document.querySelector('#chat-models-panel').hidden && !document.querySelector('#chat-models-status').textContent.includes('isolated-key')");
    }
    mode = "models";
    await evaluate(`(() => {
      window.__modelOriginalFetch=window.fetch;window.__modelHeld=[];window.__modelHold=false;
      window.fetch=async (...args)=>{
        const response=await window.__modelOriginalFetch(...args);
        if (new URL(String(args[0]),location.href).pathname==='/api/connection/models' && window.__modelHold) {
          const payload=await response.json();window.__modelHold=false;
          await new Promise(resolve=>window.__modelHeld.push(resolve));
          return new Response(JSON.stringify(payload),{status:response.status,headers:{'Content-Type':'application/json'}});
        }
        return response;
      };
    })()`);
    for (const reason of ["key", "tab", "close", "programmaticClose", "cancel"]) {
      await evaluate("window.__modelHold=true");
      await clickFetch();
      await wait(evaluate, "window.__modelHeld.length===1");
      if (reason === "key") {
        await evaluate("document.querySelector('#chat-key').value='new-draft';document.querySelector('#chat-key').dispatchEvent(new Event('input'))");
      } else if (reason === "tab") await evaluate("document.querySelector('[data-tab=\"identity\"]').click()");
      else if (reason === "close") await evaluate("document.querySelector('[data-close=\"settings-dialog\"]').click()");
      else if (reason === "programmaticClose") await evaluate("document.querySelector('#settings-dialog').close()");
      else await clickFetch();
      await evaluate("window.__modelHeld.shift()()");
      // A later event-loop turn lets the deliberately uncancelable result reach the picker.
      await evaluate("new Promise(resolve=>setTimeout(resolve,30))");
      checks[`modelLateResultDiscardedAfter${reason}`] = await evaluate("document.querySelector('#chat-models-panel').hidden && document.querySelector('#chat-model-results').children.length===0");
      if (reason === "tab") await evaluate("document.querySelector('[data-tab=\"connection\"]').click()");
      if (reason === "close" || reason === "programmaticClose") await open();
    }
    await evaluate("window.__modelHold=true");
    await clickFetch();
    await wait(evaluate, "window.__modelHeld.length===1");
    await evaluate("document.querySelector('#chat-model').value='typed-while-waiting';document.querySelector('#chat-model').dispatchEvent(new Event('input'));window.__modelHeld.shift()()");
    await loaded();
    checks.modelsNeverOverwriteAManualChoiceWhileLoading = await evaluate("document.querySelector('#chat-model').value==='typed-while-waiting'");
    await clickFetch(); await loaded(); await search("chat-beta");
    await evaluate("document.querySelector('#chat-model-results button').click()");
    checks.modelsRecoverAfterCancellation = await evaluate("document.querySelector('#chat-model').value==='chat-beta'");
    checks.discoveryDoesNotChangeAppliedConnectionOrHistory = companion.connection.model === "manual-chat" &&
      store.state.calls.length === 0 && store.state.messages.length === 0 && store.state.memories.length === 0;
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    return checks;
  } finally {
    try {
      await navigate("/");
      await wait(evaluate, "document.querySelector('#calls-list')?.children.length>0");
    } finally {
      await Promise.all([server, upstream].map((item) => new Promise((resolve) => { item.close(resolve); item.closeAllConnections(); })));
      server.connections.services.sync.lock(); store.close();
    }
  }
}
