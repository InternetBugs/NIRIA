import assert from "node:assert/strict";

// Completion substitutes and controlled SQLite persistence faults only.
// Browser/Electron still use the real authenticated application HTTP API.
export async function verifyChatFaults({ store, companion, evaluate, navigate }) {
  const original = store.snapshot(), connection = companion.connection, completion = companion.completion;
  const persistenceSave = store.persistence.save, lastInteraction = companion.lastInteraction;
  const checks = {}, model = "isolated-chat-faults", secret = "isolated-chat-fault-secret";
  let attempts = 0, fault = "", mode = "success", held, release;
  const wait = async (check) => {
    for (let index = 0; index < 200; index++) {
      if (typeof check === "function" ? await check() : await evaluate(check)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Chat fault condition failed: ${check}`);
  };
  const idle = () => wait("!document.querySelector('#send-message').disabled && document.querySelector('#stop-chat').hidden");
  const retry = async () => {
    await evaluate("[...document.querySelectorAll('#messages .message.user button')].find(button=>button.textContent==='重新回复').click()");
  };
  try {
    companion.configure({ baseUrl: "http://127.0.0.1:9/private-chat/v1", model, apiKey: secret });
    companion.completion = async (_, messages, { signal }) => {
      attempts++;
      if (mode === "hold") { held = signal; return new Promise((resolve) => { release = resolve; }); }
      if (mode === "test-disconnect") {
        held = signal;
        return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error(secret)), { once: true }));
      }
      if (messages[0]?.content.includes("记忆整理器")) return '{"memories":[{"content":"不应采用的整理","kind":"fact"}]}';
      return mode === "new" ? "成功之后才替换的回复。" : mode === "memory" ? "整理失败仍保留的文字。" : "最初保存的可用回复。";
    };
    store.persistence.save = function(state, before) {
      const call = state.calls.at(-1);
      const changed = before?.calls.find((item) => item.id === call?.id)?.status !== call?.status;
      if (changed && call?.model === model && ((fault === "initial" && call.status === "pending") ||
          (fault === "completion" && call.status === "completed") ||
          (fault === "memory" && call.kind === "memory" && call.status === "completed"))) {
        fault = "";
        throw new Error(secret);
      }
      return persistenceSave.call(this, state, before);
    };
    store.mutate((state) => {
      state.messages = []; state.memories = []; state.tombstones = []; state.calls = []; state.usage = {}; state.conflicts = [];
      state.settings.autoMemory = false; state.settings.care.enabled = false;
    });
    await navigate("/");
    await wait("document.readyState==='complete' && document.querySelector('#connection-status')?.textContent.includes('isolated-chat-faults')");
    await evaluate("document.querySelector('#message-input').value='唯一一条原始问题';document.querySelector('#composer').requestSubmit()");
    await wait("document.querySelector('#messages .message.completed.assistant')?.textContent.includes('最初保存的可用回复') && !document.querySelector('#send-message').disabled");
    const firstReply = structuredClone(store.state.messages.find((message) => message.role === "assistant"));
    await evaluate("document.querySelector('#message-input').value='下一条尚未发送的草稿';document.querySelector('#message-input').dispatchEvent(new Event('input'))");
    fault = "initial";
    await retry();
    await wait("document.querySelector('#messages .message.failed')?.textContent.includes('未向服务提交')");
    await idle();
    checks.chatInitialLogFaultPreventsProviderCall = attempts === 1 && store.state.calls.length === 1;
    checks.chatInitialLogFaultPreservesOriginal = await evaluate(`document.querySelector('.message[data-id="${firstReply.id}"]')?.textContent.includes('最初保存的可用回复')`);
    checks.chatFaultKeepsDraft = await evaluate("document.querySelector('#message-input').value==='下一条尚未发送的草稿'");

    fault = "completion";
    await retry();
    await wait(() => store.state.calls.at(-1)?.status === "unknown");
    await idle();
    await wait("document.querySelector('#messages .message.failed:last-child')?.textContent.includes('未能保存结果状态')");
    checks.chatResultLogFaultExplainsUncertainty = attempts === 2 && await evaluate("document.querySelector('#messages').textContent.includes('原回复已保留') && !document.querySelector('#notice').textContent.includes('isolated-chat-fault-secret')");
    checks.chatResultLogFaultPreservesOriginal = JSON.stringify(store.state.messages.find((message) => message.id === firstReply.id)) === JSON.stringify(firstReply);

    mode = "new";
    await retry();
    await wait("document.querySelector('#messages').textContent.includes('成功之后才替换的回复') && !document.querySelector('#send-message').disabled");
    checks.chatLaterRetrySucceedsWithoutDuplicateUser = attempts === 3 &&
      store.state.messages.filter((message) => message.role === "user" && !message.deleted).length === 1 &&
      store.state.messages.find((message) => message.id === firstReply.id).deleted;

    mode = "hold";
    await retry();
    await wait(() => held && attempts === 4);
    await evaluate("document.querySelector('#stop-chat').click()");
    await wait(() => held.aborted);
    checks.chatIgnoredCancelKeepsBusyUntilSettlement = await evaluate("document.querySelector('#send-message').disabled");
    release("停止后不应采用的回复。");
    await idle();
    checks.chatIgnoredCancelRecordsUnknown = store.state.calls.at(-1).status === "unknown" &&
      await evaluate("!!document.querySelector('#messages .message.cancelled') && !document.querySelector('#messages').textContent.includes('停止后不应采用')");
    checks.chatStoppedRetryKeepsDraftAndReply = await evaluate("document.querySelector('#message-input').value==='下一条尚未发送的草稿' && document.querySelector('#messages').textContent.includes('成功之后才替换的回复')");

    mode = "memory"; fault = "memory";
    store.settings({ autoMemory: true });
    await wait("document.querySelector('#request-hint').textContent.includes('记忆整理')");
    await evaluate("document.querySelector('#message-input').value='新消息：有个稳定喜好';document.querySelector('#message-input').dispatchEvent(new Event('input'));document.querySelector('#composer').requestSubmit()");
    await wait(() => attempts === 6 && store.state.calls.at(-1)?.status === "unknown");
    await idle();
    checks.chatMemoryFaultPreservesCompletedReply = await evaluate("document.querySelector('#messages').textContent.includes('整理失败仍保留的文字') && document.querySelector('#message-input').value===''");
    checks.chatMemoryFaultMakesNoRetryOrMemory = store.state.memories.length === 0 && store.state.calls.at(-1).kind === "memory";

    mode = "test-disconnect"; held = null;
    await evaluate("document.querySelector('#open-settings').click();document.querySelector('#test-connection').click()");
    await wait(() => held && attempts === 7 && store.state.calls.at(-1)?.kind === "test");
    await navigate("/avatar");
    await wait(() => held.aborted && !companion.active && store.state.calls.at(-1).status === "unknown");
    checks.chatTestDisconnectCancelsOwnRequest = true;
    await navigate("/");
    await wait("document.querySelector('#calls-list')?.textContent.includes('结果未知')");
    checks.chatUnknownRecordsSurviveNavigation = store.state.calls.length === 7 &&
      store.state.calls.map((call) => call.status).join(",") === "completed,unknown,completed,unknown,completed,unknown,unknown";
    checks.chatFaultsExposeNoSecrets = !JSON.stringify(store.state.calls).includes(secret) &&
      !JSON.stringify(store.state.calls).includes("private-chat") &&
      await evaluate("!document.querySelector('#messages').textContent.includes('isolated-chat-fault-secret')");
    checks.chatFaultsNeverAutoRetry = attempts === 7;
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    return checks;
  } finally {
    companion.cancel(); release?.("isolated cleanup");
    await wait(() => !companion.active);
    store.persistence.save = persistenceSave;
    companion.connection = connection; companion.completion = completion; companion.lastInteraction = lastInteraction;
    store.mutate(() => { store.state = original; });
    await navigate("/");
    await wait("document.readyState==='complete' && document.querySelector('#calls-list')?.children.length > 0");
  }
}
