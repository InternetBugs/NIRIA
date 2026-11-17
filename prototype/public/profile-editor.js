export function profileEditor({ api, data, refresh, notice, snapshot }) {
  const $ = (id) => document.getElementById(id), dialog = $("profile-dialog");
  const fields = ["name", "persona", "style", "relationship"];
  let basis, resultBasis, controller, generation = 0, saving = false, busy = false;
  const status = (message) => { $("profile-status").textContent = message; };
  function controls() {
    const avatar = $("profile-source").value === "avatar";
    $("profile-image-note").hidden = !avatar;
    $("profile-source-note").textContent = avatar
      ? "将当前形象的一张截图和补充描述发送给已配置的对话模型，需要模型支持读图；不发送 Live2D 模型文件、聊天或记忆。外观对应的性格和背景属于创作建议。"
      : "只将下面的人物描述发送给已配置的对话模型，不附带聊天、记忆或当前资料。";
    $("profile-generate").disabled = busy || saving || !basis || !data()?.service.connected;
    $("profile-stop").hidden = !busy;
    $("profile-apply").disabled = !resultBasis || busy || saving;
    $("profile-result").disabled = busy || saving;
    $("profile-description").disabled = saving;
    $("profile-source").disabled = saving;
    for (const button of dialog.querySelectorAll("[data-close]")) button.disabled = saving;
  }
  function cancel(message = "") {
    ++generation;
    controller?.abort(); controller = null; busy = false;
    resultBasis = null; $("profile-result").hidden = true;
    $("profile-image").removeAttribute("src"); $("profile-image").hidden = true;
    status(message); controls();
  }
  function open(mode = "text") {
    cancel();
    basis = data()?.profile?.basis;
    $("profile-source").value = mode;
    $("profile-description").value = "";
    controls();
    if (!dialog.open) dialog.showModal();
    status(data()?.service.connected ? "生成一次调用 1 次模型，每日最多 10 次，失败也计入。先预览和修改，再确认保存。" : "请先在“对话服务”中配置并应用模型连接。");
    $("profile-description").focus();
  }
  async function generate() {
    if (busy || saving) return;
    cancel();
    const current = ++generation, expected = basis, mode = $("profile-source").value;
    const description = $("profile-description").value;
    const request = new AbortController(); controller = request; busy = true; controls();
    try {
      if (!description.trim() && mode === "text") throw new Error("请先粘贴一段人物描述。");
      status(mode === "avatar" ? "正在准备形象截图…" : "正在整理资料…");
      const input = { mode, text: description, basis: expected };
      if (mode === "avatar") {
        input.image = await snapshot();
        if (current !== generation || request.signal.aborted || !dialog.open) return;
        $("profile-image").src = input.image; $("profile-image").hidden = false;
      }
      if (expected !== data()?.profile?.basis) throw new Error("资料或形象已变化，请重新打开资料生成。");
      status("正在生成资料草稿，可以停止等待…");
      const result = await api("/api/identity/draft", input, { signal: request.signal });
      if (current !== generation || request.signal.aborted || !dialog.open || result.basis !== basis ||
          basis !== data()?.profile?.basis) return;
      for (const field of fields) $(`profile-${field}`).value = result.draft[field];
      resultBasis = result.basis; $("profile-result").hidden = false;
      status("草稿已生成，尚未保存。请检查并修改下面的内容，再点击“确认采用资料”。");
    } catch (error) {
      if (current === generation && !request.signal.aborted) status(error.message);
    } finally {
      if (current === generation) { controller = null; busy = false; controls(); }
      refresh().catch(() => {});
    }
  }
  async function apply() {
    if (!resultBasis || busy || saving) return;
    if (!$("profile-form").reportValidity()) return;
    saving = true; controls();
    try {
      const draft = Object.fromEntries(fields.map((field) => [field, $(`profile-${field}`).value]));
      await api("/api/identity/draft/apply", { basis: resultBasis, draft });
      dialog.close();
      if ($("settings-dialog").open) {
        for (const field of fields) $(`identity-${field}`).value = draft[field];
      }
      $("avatar-profile-offer").hidden = true;
      try { await refresh(); }
      catch { notice("伴侣资料已保存，但页面刷新未完成；请刷新页面查看，无需重新采用。", true); return; }
      notice("伴侣资料已更新。形象、聊天、记忆和对你的称呼继续保留。");
    } catch (error) { status(error.message); }
    finally { saving = false; controls(); }
  }
  $("profile-generate").addEventListener("click", generate);
  $("profile-stop").addEventListener("click", () => cancel("已停止等待，原资料保留；服务可能已处理并计费，请先查看调用记录。"));
  $("profile-apply").addEventListener("click", apply);
  $("profile-form").addEventListener("submit", (event) => { event.preventDefault(); apply(); });
  $("profile-description").addEventListener("input", () => cancel("描述已改变，请重新生成资料草稿。"));
  $("profile-source").addEventListener("change", () => cancel());
  for (const button of dialog.querySelectorAll("[data-close]")) button.addEventListener("click", () => { if (!saving) cancel(); });
  dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); else cancel(); });
  dialog.addEventListener("close", () => { if (!dialog.open) cancel(); });
  window.addEventListener("pagehide", () => cancel(), { once: true });
  $("profile-from-avatar").addEventListener("click", () => open("avatar"));
  $("profile-from-text").addEventListener("click", () => open("text"));
  $("avatar-profile-create").addEventListener("click", () => open("avatar"));
  $("avatar-profile-later").addEventListener("click", () => { $("avatar-profile-offer").hidden = true; });
  controls();
  return {
    open,
    offerAvatar() { $("avatar-profile-offer").hidden = false; },
    update() {
      if (dialog.open && !saving && basis !== data()?.profile?.basis) {
        cancel("伴侣资料、形象或对话连接已变化，旧草稿已清除；请关闭后重新打开。");
        basis = null;
      }
      controls();
    }
  };
}
