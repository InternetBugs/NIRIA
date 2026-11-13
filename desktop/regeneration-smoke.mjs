import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ServiceError } from "../prototype/image-service.mjs";

export async function verifyRegeneration({ store, companion, evaluate, capture }) {
  const originalState = store.snapshot(), connection = companion.connection,
    completion = companion.completion, lastInteraction = companion.lastInteraction;
  const pending = [], calls = [], result = {};
  const userId = randomUUID(), replyId = randomUUID(), at = new Date().toISOString();
  const oldText = "隔离重生成：原来可用的回复";
  const memoryText = "隔离重生成：原回复的衍生资料";
  const wait = async (code) => {
    for (let i = 0; i < 150; i++) {
      if (await evaluate(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Regeneration condition failed: ${code}`);
  };
  const retry = () => evaluate("[...document.querySelectorAll('#messages .message.user button')].find(button => button.textContent === '重新回复').click()");
  const idle = () => wait("!document.querySelector('#send-message').disabled");
  try {
    await evaluate("window.__regenerationDraft = document.querySelector('#message-input').value");
    companion.configure({ baseUrl: "http://127.0.0.1:9/v1", model: "regeneration-isolated" });
    companion.completion = (_, messages, { signal }) => {
      calls.push(structuredClone(messages));
      return new Promise((resolve, reject) => {
        let finished = false;
        const done = (callback, value) => {
          if (finished) return;
          finished = true; signal.removeEventListener("abort", abort); callback(value);
        };
        const abort = () => done(reject, new Error("isolated regeneration cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        pending.push({ resolve: (value) => done(resolve, value), reject: (error) => done(reject, error) });
      });
    };
    store.mutate((state) => {
      state.messages = [
        { id: userId, role: "user", content: "隔离重生成：今天想聊聊", revision: 1,
          status: "completed", deleted: false, createdAt: at, updatedAt: at },
        { id: replyId, role: "assistant", content: oldText, replyTo: userId, revision: 1,
          status: "completed", deleted: false, createdAt: at, updatedAt: at }
      ];
      state.memories = []; state.tombstones = []; state.conflicts = [];
      state.settings.autoMemory = false; state.settings.care.enabled = false;
    });
    const memoryId = store.addMemory({ content: memoryText, sources: [{ id: replyId, revision: 1 }] });
    await wait(`document.querySelector('#messages').textContent.includes(${JSON.stringify(oldText)})`);
    await evaluate("document.querySelector('#message-input').value = '隔离重生成：未发送草稿'; document.querySelector('#message-input').dispatchEvent(new Event('input'))");
    await retry();
    await wait("document.querySelector('#messages .message.pending') && document.querySelector('#messages').textContent.includes('成功后替换原回复')");
    assert.equal(pending.length, 1);
    result.retryOriginalVisibleWhileWaiting = await evaluate(`document.querySelector('[data-id="${replyId}"]')?.textContent.includes(${JSON.stringify(oldText)})`);
    result.retryExcludesOldReplyAndMemory = !JSON.stringify(calls[0]).includes(oldText) && !JSON.stringify(calls[0]).includes(memoryText);
    pending[0].reject(new ServiceError(502, "隔离测试：对话服务暂时不可用。"));
    await idle();
    await wait("document.querySelector('#messages .message.failed')?.textContent.includes('原回复已保留')");
    result.retryFailureKeepsOriginal = await evaluate(`document.querySelector('[data-id="${replyId}"]')?.textContent.includes(${JSON.stringify(oldText)})`) &&
      store.state.memories.find((item) => item.id === memoryId).invalidated === false;
    result.retryFailureKeepsDraft = await evaluate("document.querySelector('#message-input').value === '隔离重生成：未发送草稿'");
    if (capture) await capture();
    await retry();
    await wait("document.querySelector('#messages .message.pending')");
    assert.equal(pending.length, 2);
    await evaluate("document.querySelector('#stop-chat').click()");
    await idle();
    await wait("document.querySelector('#messages .message.cancelled')");
    result.retryStopKeepsOriginal = await evaluate(`document.querySelector('[data-id="${replyId}"]')?.textContent.includes(${JSON.stringify(oldText)})`);
    await retry();
    await wait("document.querySelector('#messages .message.pending')");
    assert.equal(pending.length, 3);
    pending[2].resolve("隔离重生成：成功替换后的新回复");
    await idle();
    await wait("document.querySelector('#messages').textContent.includes('成功替换后的新回复')");
    result.retrySuccessReplacesOriginal = !(await evaluate(`!!document.querySelector('[data-id="${replyId}"]')`)) &&
      store.state.messages.find((item) => item.id === replyId).deleted;
    result.retrySuccessInvalidatesDerivedMemory = store.state.memories.find((item) => item.id === memoryId).invalidated;
    result.retrySuccessClearsFailedAttempts = await evaluate("!document.querySelector('#messages .message.failed, #messages .message.cancelled')");
    result.retryOnlyOneUserMessage = store.state.messages.filter((item) => item.role === "user" && !item.deleted).length === 1;
    result.retryAllOutcomesKeepDraft = await evaluate("document.querySelector('#message-input').value === '隔离重生成：未发送草稿'");
    assert.equal(calls.length, 3);
    assert.ok(Object.values(result).every(Boolean), JSON.stringify(result));
    return result;
  } finally {
    companion.cancel();
    for (const entry of pending) entry.reject(new Error("isolated regeneration cleanup"));
    for (let i = 0; i < 150 && companion.active; i++) await new Promise((resolve) => setTimeout(resolve, 40));
    companion.connection = connection; companion.completion = completion; companion.lastInteraction = lastInteraction;
    await evaluate("document.querySelector('#message-input').value = window.__regenerationDraft || ''; document.querySelector('#message-input').dispatchEvent(new Event('input')); delete window.__regenerationDraft");
    store.mutate(() => { store.state = originalState; });
  }
}
