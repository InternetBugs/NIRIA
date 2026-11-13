export function syncSecurity({ api, refresh, notice }) {
  const $ = (selector) => document.querySelector(selector);
  let plan = null, busy = false, downloaded = false, status = {};
  const render = () => {
    const rotation = status.rotation || {};
    if (!rotation.prepared && !rotation.pending && !busy) {
      plan = null; downloaded = false;
      $("#rotation-code").value = "";
      $("#rotation-saved").checked = false;
    }
    $("#rotation-prepare").disabled = busy || status.busy || !status.unlocked || !status.configured || rotation.pending;
    $("#rotation-prepare").hidden = !!rotation.prepared && !!plan;
    $("#rotation-prepare").textContent = rotation.prepared && !plan ? "重新显示待确认配对码" : "准备新配对码";
    $("#rotation-plan").hidden = !plan || !rotation.prepared || rotation.pending;
    $("#rotation-recovery").hidden = !rotation.pending;
    $("#rotation-activate").disabled = busy || status.busy || !downloaded || !$("#rotation-saved").checked;
    $("#rotation-saved").disabled = busy || !downloaded;
    $("#rotation-cancel").disabled = busy || status.busy;
    $("#rotation-download").disabled = busy || status.busy;
    $("#rotation-recover").disabled = busy || status.busy || !status.configured || !$("#rotation-recovery-code").value.trim();
    $("#rotation-status").textContent = rotation.pending ? "换钥结果待核对，已暂停上传。请保留恢复文件，并只读核对。" :
      rotation.prepared ? "配对码已准备，尚未更换远端密钥。请先保存恢复文件。" :
      "准备只生成配对码，不上传资料。自动同步会暂停，完成后可手动重新开启。";
  };
  const run = async (operation) => {
    if (busy) return;
    busy = true; render();
    try { await operation(); }
    catch (error) { notice(error.message, true); }
    finally { busy = false; await refresh().catch(() => {}); render(); }
  };
  $("#rotation-prepare").addEventListener("click", () => run(async () => {
    plan = await api("/api/sync/rotation/prepare", {});
    $("#rotation-code").value = plan.code;
    $("#rotation-saved").checked = false;
    $("#sync-auto").checked = false;
    downloaded = false;
    await refresh();
  }));
  $("#rotation-download").addEventListener("click", () => {
    if (!plan || busy) return;
    const content = JSON.stringify({
      format: "niria-key-change-recovery", version: 1, createdAt: new Date().toISOString(), id: plan.id,
      previousCode: plan.previousCode, code: plan.code
    }, null, 2);
    const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = `niria-key-change-${plan.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    downloaded = true; render();
  });
  $("#rotation-saved").addEventListener("change", render);
  $("#rotation-recovery-code").addEventListener("input", render);
  $("#rotation-cancel").addEventListener("click", () => run(async () => {
    await api("/api/sync/rotation/cancel", {});
    plan = null;
    notice("本次准备已取消，远端密钥未改变。自动同步仍暂停，可按需重新开启。");
  }));
  $("#rotation-activate").addEventListener("click", () => run(async () => {
    if (!plan || !downloaded || !$("#rotation-saved").checked) return;
    const result = await api("/api/sync/rotation/activate", {
      id: plan.id, confirmed: true, rememberPair: $("#pair-remember").checked
    });
    $("#sync-code").value = "";
    $("#sync-auto").checked = false;
    notice(result.credentialWarning || "同步密钥已更换。请在其他设备使用恢复文件中的新配对码解锁；自动同步仍暂停。", !!result.credentialWarning);
    plan = null;
  }));
  $("#rotation-recover").addEventListener("click", () => run(async () => {
    const result = await api("/api/sync/rotation/recover", {
      code: $("#rotation-recovery-code").value.trim(), rememberPair: $("#pair-remember").checked
    });
    $("#rotation-recovery-code").value = "";
    $("#sync-code").value = "";
    $("#sync-auto").checked = false;
    plan = null;
    notice(result.credentialWarning || (result.keyChanged
      ? "只读核对完成：远端已使用新密钥。其他设备请换用新配对码。"
      : "只读核对完成：远端仍使用原密钥。本次未重新换钥，自动同步仍暂停。"), !!result.credentialWarning);
  }));
  return (value) => { status = value; render(); };
}
