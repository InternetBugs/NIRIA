import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export async function verifyContextReview({ store, companion, evaluate, capture }) {
  const original = store.snapshot(), connection = companion.connection, completion = companion.completion,
    lastInteraction = companion.lastInteraction;
  const result = {}, pending = [], calls = [];
  const wait = async (code) => {
    for (let i = 0; i < 140; i++) {
      if (await evaluate(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Context review condition failed: ${code}`);
  };
  const ready = () => wait("document.querySelector('#context-dialog').open && document.querySelector('#context-content').getAttribute('aria-busy') === 'false'");
  const open = async (draft) => {
    await evaluate(`(() => {
      document.querySelector('#message-input').value = ${JSON.stringify(draft)};
      document.querySelector('#message-input').dispatchEvent(new Event('input'));
      document.querySelector('#preview-context').click();
    })()`);
    await ready();
  };
  const close = () => evaluate("document.querySelector('[data-close=\"context-dialog\"]').click()");
  const at = new Date().toISOString();
  try {
    await evaluate(`(() => {
      window.__contextOriginalFetch = window.fetch; window.__contextReplies = []; window.__contextReleases = [];
      window.__contextOriginalDraft = document.querySelector('#message-input').value;
      window.__holdContext = false;
      window.__contextStaleFlashes = 0;
      window.__contextObserver = new MutationObserver(() => {
        if (document.querySelector('#context-content').textContent.includes('不应显示的旧响应')) window.__contextStaleFlashes++;
      });
      window.__contextObserver.observe(document.querySelector('#context-content'), {childList:true,subtree:true,characterData:true});
      window.fetch = async (...args) => {
        const response = await window.__contextOriginalFetch(...args);
        if (new URL(String(args[0]),location.href).pathname === '/api/context/preview') {
          const body = JSON.parse(args[1].body), payload = await response.clone().json();
          if (window.__contextBadStamp || window.__contextExpiredReply) {
            payload.memoryPreview = [{content:'不应显示的旧响应',reason:'related'}];
            if (window.__contextBadStamp) payload.previewBasis = 'isolated-older-window';
            if (window.__contextExpiredReply) payload.validUntil = Date.now()-1;
            window.__contextBadStamp = window.__contextExpiredReply = false;
            window.__contextReplies.push({draft:body.draft,payload});
            return new Response(JSON.stringify(payload), {status:response.status,headers:{'Content-Type':'application/json'}});
          }
          window.__contextReplies.push({draft:body.draft,payload});
          if (window.__holdContext) await new Promise(resolve => window.__contextReleases.push(resolve));
        }
        return response;
      };
    })()`);
    companion.configure({ baseUrl: "http://127.0.0.1:9/v1", model: "context-first" });
    companion.completion = (_, messages, { signal }) => {
      calls.push(structuredClone(messages));
      return new Promise((resolve, reject) => {
        let finished = false;
        const done = (callback, value) => {
          if (finished) return; finished = true;
          signal.removeEventListener("abort", abort); callback(value);
        };
        const abort = () => done(reject, new Error("isolated cancelled context request"));
        signal.addEventListener("abort", abort, { once: true });
        pending.push({ resolve: (value) => done(resolve, value), reject: (value) => done(reject, value) });
        if (signal.aborted) abort();
      });
    };
    store.mutate((state) => {
      state.messages = Array.from({ length: 28 }, (_, index) => ({
        id: randomUUID(), role: index % 2 ? "assistant" : "user", content: `隔离范围聊天 ${index}`,
        revision: 1, status: "completed", deleted: false, createdAt: at, updatedAt: at
      }));
      state.memories = []; state.conflicts = [];
      state.settings.allowModel = true; state.settings.autoMemory = false; state.settings.care.enabled = false;
    });
    const id = store.addMemory({ content: "隔离范围：旧称呼 <img src=x onerror=window.__contextXss=1>" });
    await wait("document.querySelector('#connection-status').textContent.includes('context-first')");
    await open("隔离范围的称呼");
    const first = await evaluate("window.__contextReplies.at(-1).payload");
    result.previewAccountsForDraft = first.refs.messageRefs.length === 23 && first.draftIncluded;
    result.previewLiteralTextSafe = await evaluate("!window.__contextXss && !document.querySelector('#context-content img')");
    store.editMemory(id, { content: "隔离范围：新称呼" });
    await wait("document.querySelector('#context-content').textContent.includes('新称呼') && !document.querySelector('#context-content').textContent.includes('旧称呼')");
    result.previewCorrectionRefreshes = true;
    store.settings({ allowModel: false });
    await wait("document.querySelector('#context-content').textContent.includes('暂无可发送') && !document.querySelector('#context-content').textContent.includes('新称呼')");
    result.previewPermissionRefreshes = true;
    store.settings({ allowModel: true });
    await wait("document.querySelector('#context-content').textContent.includes('新称呼')");
    companion.configure({ baseUrl: "http://127.0.0.1:9/v1", model: "context-second" });
    store.mutate(() => {});
    await wait("document.querySelector('#context-content').textContent.includes('context-second')");
    result.previewModelRefreshes = true;
    await evaluate("window.__holdContext = true; document.querySelector('#context-refresh').click()");
    await wait("window.__contextReleases.length > 0");
    await evaluate("document.querySelector('#message-input').value = '新的草稿话题'; document.querySelector('#message-input').dispatchEvent(new Event('input'))");
    result.previewDraftImmediatelyClears = await evaluate("!document.querySelector('#context-content').textContent.includes('新称呼')");
    await close();
    await wait("document.querySelector('#context-content').children.length === 0");
    await evaluate("window.__holdContext = false; window.__contextReleases.splice(0).forEach(release => release())");
    await wait("!document.querySelector('#context-dialog').open && document.querySelector('#context-content').children.length === 0");
    result.previewLateClosedResultIgnored = true;
    await open("再次核对");
    await evaluate("document.querySelector('[data-close=\"context-dialog\"]').click(); document.querySelector('#preview-context').click()");
    await ready();
    result.previewFastReopenRetainsResults = await evaluate("document.querySelector('#context-content').textContent.includes('新称呼')");
    for (const [flag, check] of [["__contextBadStamp", "previewServerStampChecked"], ["__contextExpiredReply", "previewExpiredResponseDiscarded"]]) {
      const before = await evaluate("window.__contextReplies.length");
      await evaluate(`window.${flag} = true; document.querySelector('#context-refresh').click()`);
      await wait(`window.__contextReplies.length >= ${before + 2} && document.querySelector('#context-content').getAttribute('aria-busy') === 'false' &&
        document.querySelector('#context-content').textContent.includes('新称呼')`);
      result[check] = true;
    }
    result.previewNoStaleFlash = await evaluate("window.__contextStaleFlashes === 0");
    const temporary = store.addMemory({ content: "隔离范围：即将到期的线索" });
    store.mutate((state) => { state.memories.find((memory) => memory.id === temporary).expiresAt = new Date(Date.now() + 1200).toISOString(); });
    await wait("document.querySelector('#context-content').textContent.includes('即将到期')");
    await evaluate("window.__holdContext = true");
    await wait("window.__contextReleases.length > 0 && !document.querySelector('#context-content').textContent.includes('即将到期')");
    result.previewExpiryClearsBeforeResponse = true;
    await evaluate("window.__holdContext = false; window.__contextReleases.splice(0).forEach(release => release())");
    await ready();
    result.previewExpiryRefreshes = await evaluate("!document.querySelector('#context-content').textContent.includes('即将到期')");
    store.deleteMemory(id);
    await wait("document.querySelector('#context-content').textContent.includes('暂无可发送')");
    result.previewDeletionRefreshes = true;
    result.previewNoModelCalls = calls.length === 0;
    await close();
    const draft = "隔离范围：已发送的消息";
    await open(draft);
    const preview = await evaluate("window.__contextReplies.at(-1).payload");
    if (capture) await capture();
    await close();
    await evaluate("document.querySelector('#composer').requestSubmit()");
    for (let i = 0; i < 140 && calls.length < 1; i++) await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(1), preview.messages.slice(1));
    result.previewMatchesActualMessageSelection = true;
    await evaluate("document.querySelector('#message-input').value = '隔离范围：尚未发送的新草稿'; document.querySelector('#message-input').dispatchEvent(new Event('input'))");
    pending[0].resolve("隔离范围：第一条回复");
    await wait("!document.querySelector('#send-message').disabled && document.querySelector('#messages').textContent.includes('第一条回复')");
    result.newDraftSurvivesReply = await evaluate("document.querySelector('#message-input').value === '隔离范围：尚未发送的新草稿'");
    const userCount = store.state.messages.filter((message) => message.role === "user" && !message.deleted).length;
    await evaluate("[...document.querySelectorAll('#messages .message.user button')].find(button => button.textContent === '重新回复').click()");
    for (let i = 0; i < 140 && calls.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.length, 2);
    pending[1].resolve("隔离范围：重新回复");
    await wait("!document.querySelector('#send-message').disabled && document.querySelector('#messages').textContent.includes('重新回复')");
    result.retryKeepsDraftAndUserCount = await evaluate("document.querySelector('#message-input').value === '隔离范围：尚未发送的新草稿'") &&
      store.state.messages.filter((message) => message.role === "user" && !message.deleted).length === userCount;
    await evaluate("document.querySelector('#composer').requestSubmit()");
    for (let i = 0; i < 140 && calls.length < 3; i++) await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.length, 3);
    pending[2].resolve("隔离范围：草稿正常发送");
    await wait("!document.querySelector('#send-message').disabled && document.querySelector('#message-input').value === ''");
    result.unchangedSentDraftClears = true;
    await evaluate("document.querySelector('#message-input').value = '隔离范围：失败后保留草稿'; document.querySelector('#message-input').dispatchEvent(new Event('input')); document.querySelector('#composer').requestSubmit()");
    for (let i = 0; i < 140 && calls.length < 4; i++) await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(calls.length, 4);
    pending[3].reject(new Error("isolated provider failure"));
    await wait("!document.querySelector('#send-message').disabled && document.querySelector('#messages .message.failed')");
    result.failedSendKeepsDraft = await evaluate("document.querySelector('#message-input').value === '隔离范围：失败后保留草稿'");
    assert.ok(Object.values(result).every(Boolean), JSON.stringify(result));
    return result;
  } finally {
    companion.cancel();
    for (const entry of pending) entry.reject(new Error("isolated test cleanup"));
    for (let i = 0; i < 140 && companion.active; i++) await new Promise((resolve) => setTimeout(resolve, 40));
    companion.connection = connection; companion.completion = completion; companion.lastInteraction = lastInteraction;
    await evaluate(`(() => {
      document.querySelector('#context-dialog').close();
      window.__contextObserver?.disconnect();
      window.__holdContext = false; window.__contextReleases?.splice(0).forEach(release => release());
      if (window.__contextOriginalFetch) window.fetch = window.__contextOriginalFetch;
      document.querySelector('#message-input').value = window.__contextOriginalDraft || '';
      document.querySelector('#message-input').dispatchEvent(new Event('input'));
    })()`);
    store.mutate(() => { store.state = original; });
  }
}
