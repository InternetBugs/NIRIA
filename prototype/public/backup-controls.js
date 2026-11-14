export function backupControls({ api, refresh, data, notice, download, beforeRestore }) {
  const $ = (selector) => document.querySelector(selector);
  let task = null, remote = {}, leaving = false;
  function render() {
    const busy = !!task || remote.busy;
    $("#export-backup").disabled = busy;
    $("#restore-backup").disabled = busy;
    $("#backup-stop").hidden = !busy;
    $("#backup-stop").disabled = !!task?.stopping || !!task?.committed || !!remote.committed;
    $("#backup-status").textContent = remote.committed ? "资料已恢复，正在清理已保存配对码；已提交的恢复无法撤销。" :
      task?.stopping ? "已请求停止，正在等待本机任务结束；已提交的恢复不会撤销。" :
      task?.phase === "file" ? "正在本机读取备份文件，可停止。" :
      task?.operation === "restore" || remote.operation === "restore" ? "正在本机解密并核对资料，保存前可停止。" :
      busy ? "正在本机加密备份，可停止等待。" : "";
    $("#backup-status").setAttribute("aria-busy", String(!!busy));
  }
  const current = (value) => !leaving && task === value && !value.controller.signal.aborted;
  function begin(operation, secret) {
    const next = { operation, secret, controller: new AbortController(), phase: "file", stopping: false, committed: false };
    task = next; render(); return next;
  }
  function clearPassword(value) {
    if ($("#backup-password").value === value.secret) $("#backup-password").value = "";
  }
  function checkPassword(secret) {
    if (secret.length < 10 || secret.length > 256) throw new Error("备份口令需要 10 到 256 个字符，请单独妥善保存。");
  }
  async function finish(value) {
    if (task !== value) return;
    task = null;
    if (value.committed) remote = {};
    if (!leaving) await refresh().catch(() => {});
    render();
  }
  async function stop() {
    const value = task;
    if (value?.committed || remote.committed || value?.stopping) return;
    if (value?.phase === "file") {
      value.controller.abort(); task = null; render();
      notice("已停止读取备份文件，未提交恢复。");
      return;
    }
    if (value) { value.stopping = true; render(); }
    try {
      const result = await api("/api/backup/cancel", {});
      if (!leaving) {
        notice(result.committed ? "资料已恢复，已提交的恢复无法撤销；请核对当前资料。" : "已请求停止备份操作，正在等待本机任务结束。");
        await refresh();
      }
    } catch (error) { if (!leaving) notice(error.message, true); }
    finally { render(); }
  }
  $("#backup-stop").addEventListener("click", () => { void stop(); });
  $("#settings-dialog").addEventListener("close", () => {
    if (!$("#settings-dialog").open && task && !task.committed) void stop();
  });
  window.addEventListener("pagehide", () => {
    leaving = true; task?.controller.abort(); task = null;
  }, { once: true });
  $("#export-backup").addEventListener("click", async () => {
    if (task || remote.busy) return;
    const value = begin("export", $("#backup-password").value);
    try {
      checkPassword(value.secret); value.phase = "request"; render();
      const result = await api("/api/backup/export", { password: value.secret }, { signal: value.controller.signal });
      if (!current(value) || value.stopping) return;
      download(result, `niria-${new Date().toISOString().slice(0, 10)}.niria`);
      clearPassword(value);
      notice("加密备份已导出，请单独保管口令。");
    } catch (error) { if (current(value)) notice(error.message, true); }
    finally { await finish(value); }
  });
  $("#restore-backup").addEventListener("change", async (event) => {
    const file = event.target.files[0]; event.target.value = ""; if (!file) return;
    if (task?.phase === "file") { task.controller.abort(); task = null; }
    if (task || remote.busy) { notice("已有备份或恢复任务正在处理，请停止或等候结束。", true); return; }
    const value = begin("restore", $("#backup-password").value);
    try {
      checkPassword(value.secret);
      if (file.size > 100 * 1024 * 1024) throw new Error("备份超过当前 100 MB 上限。");
      await refresh();
      if (!current(value)) return;
      const expectedBasis = data()?.backup?.basis;
      if (!expectedBasis) throw new Error("页面无法核对当前资料，请重新载入后再恢复。");
      if (!confirm("恢复将替换本机的伴侣、聊天、记忆和形象。请先导出当前资料。确定恢复吗？")) return;
      const backup = JSON.parse(await file.text());
      if (!current(value)) return;
      value.phase = "request"; beforeRestore(); render();
      const result = await api("/api/backup/restore", { backup, password: value.secret, expectedBasis }, { signal: value.controller.signal });
      if (!current(value)) return;
      value.committed = true; clearPassword(value);
      $("#settings-dialog").close();
      let refreshWarning = "";
      try { await refresh(true); }
      catch { refreshWarning = "资料已恢复，但页面刷新未完成，请重新载入核对；不要重复恢复。"; }
      notice([result.credentialWarning, refreshWarning].filter(Boolean).join(" ") || "伴侣与共同记忆已恢复。",
        !!result.credentialWarning || !!refreshWarning);
    } catch (error) { if (current(value)) notice(error.message, true); }
    finally { await finish(value); }
  });
  return (value = {}) => { remote = value; render(); };
}
