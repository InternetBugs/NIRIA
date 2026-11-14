import assert from "node:assert/strict";

export async function verifyCare({ store, companion, evaluate, capture }) {
  const original = store.snapshot(), connection = companion.connection, completion = companion.completion,
    clock = companion.clock, lastInteraction = companion.lastInteraction, interactionRevision = companion.interactionRevision;
  let at = new Date(2026, 10, 13, 12).getTime();
  const pending = [], jobs = [], result = {};
  const minute = 60_000;
  const wait = async (code) => {
    for (let index = 0; index < 150; index++) {
      if (await evaluate(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Care condition failed: ${code}`);
  };
  const start = () => {
    const job = companion.tick();
    job.catch(() => {});
    jobs.push(job);
    return job;
  };
  try {
    await evaluate(`(() => {
      window.__careOriginalDraft = document.querySelector('#message-input').value;
      document.querySelector('#notice').hidden = true;
      window.__careOriginalFetch = window.fetch; window.__careActivities = [];
      window.fetch = (...args) => {
        if (new URL(String(args[0]), location.href).pathname === '/api/chat/activity')
          window.__careActivities.push(args[1]?.body);
        return window.__careOriginalFetch(...args);
      };
    })()`);
    // Let the previous isolated flow finish its trailing local activity notice.
    await evaluate("new Promise(resolve => setTimeout(resolve, 1100))");
    companion.configure({ baseUrl: "http://127.0.0.1:9/v1", model: "care-isolated" });
    companion.clock = () => at;
    companion.completion = (_, __, { signal }) => new Promise((resolve) => {
      // Intentionally ignore abort to exercise rejection of late provider output.
      pending.push({ resolve, signal });
    });
    store.mutate((state) => {
      state.messages = []; state.memories = []; state.tombstones = []; state.conflicts = [];
      state.calls = []; state.usage = {};
      state.settings.autoMemory = false;
      state.settings.care = { enabled: true, intervalMinutes: 30, quietStart: 22, quietEnd: 8, dailyLimit: 2 };
    });
    companion.lastInteraction = at - 31 * minute;
    await wait("document.querySelector('#connection-status').textContent.includes('care-isolated')");
    await evaluate("window.__careActivities = []");
    const interrupted = start();
    await wait("!!document.querySelector('#messages .message.pending')");
    assert.equal(pending.length, 1);
    await evaluate(`(() => {
      const input = document.querySelector('#message-input');
      input.value = '隔离关心：尚未发送的私密草稿';
      for (let index = 0; index < 8; index++) input.dispatchEvent(new Event('input'));
    })()`);
    await wait("window.__careActivities.length > 0");
    for (let index = 0; index < 100 && !pending[0].signal.aborted; index++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    result.careTypingAbortsPending = pending[0].signal.aborted;
    pending[0].resolve("隔离关心：迟到问候不得显示");
    await assert.rejects(interrupted, (error) => error.status === 504);
    await wait("!document.querySelector('#send-message').disabled");
    result.careLateReplyDiscarded = !store.state.messages.some((message) => message.content.includes("迟到问候")) &&
      !(await evaluate("document.querySelector('#messages').textContent.includes('迟到问候')"));
    await evaluate("new Promise(resolve => setTimeout(resolve, 1200))");
    const notifications = await evaluate("window.__careActivities");
    result.careActivityCoalesced = notifications.length >= 1 && notifications.length <= 2;
    result.careActivitySendsNoDraft = notifications.every((body) => body === "{}");
    result.careActivityDoesNotCallModel = pending.length === 1 && store.state.calls.length === 1;
    at += 29 * minute;
    result.careTypingPostponesInterval = await companion.tick() === false;

    at = new Date(2026, 10, 13, 21, 59, 50).getTime();
    const quiet = start();
    await wait("!!document.querySelector('#messages .message.pending')");
    assert.equal(pending.length, 2);
    at = new Date(2026, 10, 13, 22).getTime();
    pending[1].resolve("隔离关心：静默时段不得显示");
    await assert.rejects(quiet, /主动关心/);
    await wait("!document.querySelector('#send-message').disabled");
    result.careQuietBoundaryDiscardsReply = !store.state.messages.some((message) => message.content.includes("静默时段"));
    result.careQuietDoesNotRetry = await companion.tick() === false && pending.length === 2;

    at = new Date(2026, 10, 14, 12).getTime();
    store.settings({ care: { dailyLimit: 1 } });
    const greeting = start();
    await wait("!!document.querySelector('#messages .message.pending')");
    assert.equal(pending.length, 3);
    pending[2].resolve("隔离关心：允许时段的一句问候");
    assert.equal(await greeting, true);
    await wait("document.querySelector('#messages').textContent.includes('允许时段的一句问候') && !document.querySelector('#send-message').disabled");
    result.careAllowedGreetingVisible = store.state.messages.filter((message) =>
      message.proactive && message.status === "completed").length === 1;
    result.careCancelledAttemptsCounted = store.state.usage["2026-11-13"]?.care === 2;
    result.careDailyLimitAfterOneReply = await companion.tick() === false && pending.length === 3;
    result.careKeepsUnsentDraft = await evaluate("document.querySelector('#message-input').value === '隔离关心：尚未发送的私密草稿'");
    if (capture) await capture();

    await evaluate(`(() => {
      const input = document.querySelector('#message-input');
      input.value = '隔离关心：用户主动发送'; input.dispatchEvent(new Event('input'));
      document.querySelector('#composer').requestSubmit();
    })()`);
    await wait("!!document.querySelector('#messages .message.pending')");
    assert.equal(pending.length, 4);
    await evaluate(`(() => {
      const input = document.querySelector('#message-input');
      input.value = '隔离关心：回复期间继续写草稿'; input.dispatchEvent(new Event('input'));
    })()`);
    const interaction = companion.interactionRevision;
    for (let index = 0; index < 100 && companion.interactionRevision === interaction; index++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    result.careTypingKeepsRequestedChat = companion.interactionRevision > interaction && !pending[3].signal.aborted;
    pending[3].resolve("隔离关心：正常聊天回复");
    await wait("document.querySelector('#messages').textContent.includes('正常聊天回复') && !document.querySelector('#send-message').disabled");
    result.careChatDraftPreserved = await evaluate("document.querySelector('#message-input').value === '隔离关心：回复期间继续写草稿'");
    assert.ok(Object.values(result).every(Boolean), JSON.stringify(result));
    return result;
  } finally {
    companion.cancel();
    for (const entry of pending) entry.resolve("隔离测试清理");
    await Promise.allSettled(jobs);
    for (let index = 0; index < 150 && companion.active; index++)
      await new Promise((resolve) => setTimeout(resolve, 40));
    companion.connection = connection; companion.completion = completion; companion.clock = clock;
    companion.lastInteraction = lastInteraction; companion.interactionRevision = interactionRevision;
    await evaluate(`(() => {
      window.fetch = window.__careOriginalFetch;
      document.querySelector('#message-input').value = window.__careOriginalDraft || '';
      document.querySelector('#message-input').dispatchEvent(new Event('input'));
      delete window.__careOriginalFetch; delete window.__careOriginalDraft; delete window.__careActivities;
    })()`);
    store.mutate(() => { store.state = original; });
  }
}
