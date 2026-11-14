import assert from "node:assert/strict";
import { defaults } from "../core/store.mjs";
import { emptyManifest, unseal } from "../core/sync-model.mjs";

// Actual application HTTP and a parent-owned localhost WebDAV server. Only the
// response timing is controlled; PUT cancellation can follow a real remote write.
export async function verifySyncSafety({ store, sync, connections, evaluate, navigate, davBaseUrl }) {
  assert.equal(sync.active, null);
  assert.equal(sync.rotation.plan, null);
  const original = store.snapshot(), meta = structuredClone(sync.meta);
  const pair = sync.pair ? { ...sync.pair, key: Buffer.from(sync.pair.key) } : null;
  const saved = {
    connection: sync.connection, fetchImpl: sync.fetchImpl, auto: sync.auto,
    capabilities: sync.capabilities, lastAttempt: sync.lastAttempt, lastError: sync.lastError,
    current: new Map(connections.current), versions: new Map(connections.versions)
  };
  const checks = {};
  let mode = "", held, release, gate, stateWrites = 0;
  const wait = async (condition) => {
    for (let index = 0; index < 200; index++) {
      if (typeof condition === "function" ? await condition() : await evaluate(condition)) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    throw new Error(`Synchronization smoke condition failed: ${condition}`);
  };
  const post = (path, body) => evaluate(`(async()=>{
    const {token}=await (await fetch('/api/session')).json();
    const response=await fetch('/api/sync/${path}',{method:'POST',
      headers:{'Content-Type':'application/json','X-Niria-Token':token},body:${JSON.stringify(JSON.stringify(body))}});
    return {status:response.status,body:await response.json()};
  })()`);
  const open = async () => {
    await navigate("/");
    await wait("document.readyState==='complete' && document.querySelector('#calls-list')?.children.length > 0");
    await evaluate("document.querySelector('#open-settings').click();document.querySelector('[data-tab=\"sync\"]').click()");
    await wait("document.querySelector('#settings-dialog').open && !document.querySelector('[data-settings=\"sync\"]').hidden");
  };
  const click = (id) => evaluate(`document.querySelector('#${id}').click()`);
  const arm = (next) => { mode = next; held = null; gate = new Promise((resolve) => { release = resolve; }); };
  const stop = async () => { await click("sync-stop"); await wait(() => held.signal.aborted); };
  const settled = async () => {
    release(); await wait(() => !sync.active);
    await wait("document.querySelector('#sync-status').textContent.includes('停止')");
  };
  try {
    sync.lock();
    sync.applying = true;
    try { store.mutate(() => { store.state = defaults(); }); }
    finally { sync.applying = false; }
    sync.meta = { device: meta.device, vaultId: null, manifest: emptyManifest(store.state.identity.id), fingerprints: {}, lastSuccess: null };
    sync.persist();
    sync.fetchImpl = async (url, options) => {
      const state = url.endsWith("state.niria");
      if (state && options.method === "PUT") stateWrites++;
      const hold = (mode === "read" && state && options.method === "GET") ||
        (mode === "write" && state && options.method === "PUT") || (mode === "probe" && options.method === "PROPFIND");
      const response = await fetch(url, { ...options, signal: hold ? undefined : options.signal });
      if (hold) { held = { signal: options.signal }; await gate; }
      return response;
    };
    const configured = await post("configure", { baseUrl: davBaseUrl, username: "", password: "", auto: false, remember: false });
    assert.equal(configured.status, 200);
    await open();
    await click("sync-create"); await wait(() => !!sync.pair);
    const first = store.addUser("隔离同步测试：停止前保留的本机消息").id;
    await click("sync-probe");
    await wait(() => !sync.active && !!sync.capabilities);
    await wait("document.querySelector('#notice').textContent.includes('通过读写')");

    arm("read"); await click("sync-run"); await wait(() => !!held);
    await stop();
    await wait("document.querySelector('#sync-run').disabled && document.querySelector('#sync-status').textContent.includes('正在处理')");
    checks.syncStopKeepsBusyUntilTransportSettles = !!sync.active;
    await settled();
    checks.syncStoppedReadNeverStartsUpload = stateWrites === 0;
    checks.syncStoppedReadPreservesLocalMessage = store.state.messages.length === 1 && store.state.messages[0].id === first;
    checks.syncStoppedReadDoesNotReportSuccess = sync.meta.lastSuccess === null &&
      await evaluate("document.querySelector('#notice').textContent.includes('停止') && !document.querySelector('#notice').textContent.includes('同步完成')");
    checks.syncStopExplainsUnknownWrites = await evaluate("document.querySelector('#sync-status').textContent.includes('写入结果可能未知')");

    mode = ""; await click("sync-run");
    await wait(() => !sync.active && !!sync.meta.lastSuccess);
    await wait("document.querySelector('#notice').textContent.includes('本次同步完成')");
    checks.syncExplicitRetrySucceeds = stateWrites === 1 && store.state.messages[0].id === first;
    const lastSuccess = sync.meta.lastSuccess;
    const second = store.addUser("隔离同步测试：上传期间停止的另一条本机消息").id;
    arm("write"); await click("sync-run"); await wait(() => !!held);
    await stop(); await settled();
    checks.syncLatePutRemainsUnconfirmed = sync.meta.lastSuccess === lastSuccess && stateWrites === 2;
    const remote = await sync.connection.read(`${sync.folder()}state.niria`);
    const manifest = unseal(remote.data.toString("utf8"), sync.pair.key, sync.pair.vaultId, sync.pair.identityId);
    checks.syncCancelledPutMayAlreadyExistRemotely = manifest.records.some((record) => record.id === second);
    checks.syncCancelledPutPreservesBothLocalMessages = store.state.messages.length === 2 &&
      store.state.messages.some((message) => message.id === first) && store.state.messages.some((message) => message.id === second);
    mode = ""; await click("sync-run"); await wait(() => !sync.active && sync.meta.lastSuccess !== lastSuccess);
    await wait("document.querySelector('#notice').textContent.includes('本次同步完成')");
    checks.syncNextExplicitRunReconcilesWithoutDuplicates = stateWrites === 3 &&
      new Set(store.state.messages.map((message) => message.id)).size === 2 && !store.state.conflicts.length;
    checks.syncCiphertextContainsNoMessageText = !remote.data.includes(Buffer.from("隔离同步测试"));

    assert.equal((await post("configure", { baseUrl: davBaseUrl, auto: false, remember: false })).status, 200);
    await open();
    arm("probe"); await click("sync-probe"); await wait(() => !!held);
    const key = sync.pair.key;
    await click("sync-lock"); await wait(() => !sync.pair && held.signal.aborted);
    checks.syncLockClearsSessionKeyImmediately = key.every((byte) => byte === 0) && !sync.connection;
    await settled();
    checks.syncLateProbeCannotRestoreCapabilities = sync.capabilities === null && !sync.status().configured && !sync.status().unlocked;
    checks.syncSafetyNeverCallsModel = store.state.calls.length === 0;
    assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks));
    return checks;
  } finally {
    sync.lock(); release?.(); await wait(() => !sync.active);
    sync.applying = true;
    try { store.mutate(() => { store.state = original; }); }
    finally { sync.applying = false; }
    sync.meta = meta; sync.persist(); sync.pair = pair;
    Object.assign(sync, {
      connection: saved.connection, fetchImpl: saved.fetchImpl, auto: saved.auto,
      capabilities: saved.capabilities, lastAttempt: saved.lastAttempt, lastError: saved.lastError
    });
    connections.current = saved.current; connections.versions = saved.versions;
    await navigate("/");
    await wait("document.readyState==='complete' && document.querySelector('#calls-list')?.children.length > 0");
  }
}
