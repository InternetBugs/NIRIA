import { listLive2DModels, prepareLive2DImport, inspectLive2DImport } from "./live2d-import.js";
import { inspectLive2DAvatar, live2DAvatar } from "./live2d-avatar.js";
import { Live2DPlayer } from "./live2d-player.js";
import { live2DRuntimeInfo } from "./live2d-runtime.js";

export function live2DDialog({ api, refresh, notice, data, beforeOpen = () => {} }) {
  const $ = (id) => document.getElementById(id), dialog = $("live2d-dialog");
  let files = [], bundle = null, summary = null, basis = null, revision = 0, controller, player;
  let busy = false, saving = false, previewReady = false, stale = false;
  const status = (message) => { $("live2d-status").textContent = message; };
  const options = (select, values, empty, selected = "") => {
    select.replaceChildren();
    if (empty !== null) select.append(new Option(empty, ""));
    for (const [value, label] of values) select.append(new Option(label, value));
    select.value = selected ?? "";
  };
  const controls = () => {
    $("live2d-bindings").disabled = !bundle || busy || saving || stale;
    $("live2d-preview").disabled = !bundle || busy || saving || stale || !live2DRuntimeInfo.available;
    $("live2d-adopt").disabled = !previewReady || busy || saving || stale;
    $("live2d-preview-expression").disabled = !previewReady || busy || saving || stale;
    $("live2d-folder").disabled = saving;
    $("live2d-model").disabled = !files.length || busy || saving;
    for (const button of dialog.querySelectorAll("[data-close]")) button.disabled = saving;
    $("live2d-runtime-status").textContent = live2DRuntimeInfo.available ? "文件检查后可在本机预览，确认后采用。" : live2DRuntimeInfo.message;
    $("live2d-preview-canvas").hidden = !previewReady;
  };
  const invalidate = () => {
    ++revision;
    controller?.abort(); controller = null;
    player?.destroy(); player = null;
    previewReady = false;
  };
  const bindings = () => ({
    idleGroup: $("live2d-idle").value || null,
    expressions: Object.fromEntries(["smile", "curious", "shy"].flatMap((name) =>
      $(`live2d-map-${name}`).value ? [[name, $(`live2d-map-${name}`).value]] : []))
  });
  const present = (value, selected = { idleGroup: null, expressions: {} }) => {
    summary = inspectLive2DImport(value); bundle = value;
    const groups = [...new Set(summary.motions.map((motion) => motion.group))];
    options($("live2d-idle"), groups.map((group) => [group, group]), "不播放待机动作", selected.idleGroup);
    for (const name of ["smile", "curious", "shy"])
      options($(`live2d-map-${name}`), summary.expressions.map((expression) => [expression.name, expression.name]), "不映射", selected.expressions[name]);
    $("live2d-summary").textContent = `${summary.files} 个文件 · ${(summary.totalBytes / 1024 / 1024).toFixed(2)} MB · ${summary.expressions.length} 个表情 · ${summary.motions.length} 段动作` +
      (summary.ignoredSounds ? `。${summary.ignoredSounds} 处动作音频引用未导入，不会自动播放。` : "。");
    status("文件检查通过。请确认待机动作和表情映射，再预览；文件头检查不代表模型已能播放。");
    controls();
  };
  const clear = () => {
    invalidate();
    files = []; bundle = null; summary = null; basis = null;
    busy = false; saving = false; stale = false;
    $("live2d-folder").value = "";
    options($("live2d-model"), [], "选择模型");
    $("live2d-summary").textContent = "";
    status("");
    controls();
  };
  const open = () => {
    beforeOpen();
    clear();
    const current = data();
    basis = { expectedAvatarKey: current.avatarKey, identityId: current.identity.id };
    if (!dialog.open) dialog.showModal();
    if (current.avatar?.format === "niria-live2d-avatar") {
      inspectLive2DAvatar(current.avatar);
      present(structuredClone(current.avatar.package), structuredClone(current.avatar.bindings));
    } else status("选择完整的模型文件夹，保留 .model3.json、模型和纹理等文件的相对位置。");
  };
  const load = async (modelPath) => {
    invalidate();
    bundle = null; summary = null; busy = true;
    $("live2d-summary").textContent = "";
    status("正在本机检查模型引用的文件…"); controls();
    controller = new AbortController();
    const current = revision, signal = controller.signal;
    try {
      const prepared = await prepareLive2DImport(files, { modelPath, signal });
      if (!dialog.open || current !== revision || stale) return;
      present(prepared);
    } catch (error) {
      if (dialog.open && current === revision && !signal.aborted) status(error.message || "模型文件检查失败。");
    } finally {
      if (current === revision) { busy = false; controls(); }
    }
  };
  $("live2d-folder").addEventListener("change", (event) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = "";
    if (!selected.length || saving) return;
    invalidate(); files = selected; bundle = null; summary = null; busy = false;
    $("live2d-summary").textContent = "";
    try {
      const candidates = listLive2DModels(files);
      if (!candidates.length) throw new Error("所选文件夹中没有 .model3.json，请选择完整导出的模型文件夹。");
      options($("live2d-model"), candidates.map((path) => [path, path]), candidates.length > 1 ? "请选择一个模型" : null);
      if (candidates.length === 1) {
        $("live2d-model").value = candidates[0];
        load(candidates[0]);
      } else status("发现多个模型，请选择要导入的 .model3.json。");
    } catch (error) { files = []; status(error.message); }
    controls();
  });
  $("live2d-model").addEventListener("change", () => {
    if ($("live2d-model").value) load($("live2d-model").value);
    else { invalidate(); bundle = null; summary = null; $("live2d-summary").textContent = ""; controls(); }
  });
  $("live2d-bindings").addEventListener("change", () => {
    invalidate(); status("映射已改变，请重新预览后采用。"); controls();
  });
  $("live2d-preview").addEventListener("click", async () => {
    if ($("live2d-preview").disabled) return;
    invalidate(); busy = true; controls();
    const current = revision;
    const avatar = live2DAvatar(bundle, bindings());
    player = new Live2DPlayer($("live2d-preview-canvas"), { error: (message) => {
      if (dialog.open && current === revision) { previewReady = false; status(message); controls(); }
    } });
    status("正在载入本机预览…");
    try {
      await player.update({ avatar, avatarKey: `preview-${current}` });
      if (!dialog.open || current !== revision || stale) return;
      previewReady = true;
      options($("live2d-preview-expression"),
        [["neutral", "原始表情"], ...Object.keys(avatar.bindings.expressions).map((name) => [name, { smile: "微笑", curious: "疑惑", shy: "害羞" }[name]])], null, "neutral");
      status("请检查形象、待机动作和表情。采用后只更换形象，聊天与记忆继续保留。");
    } catch (error) { if (dialog.open && current === revision) status(error.message || "预览失败，原形象仍保留。"); }
    finally { if (current === revision) { busy = false; controls(); } }
  });
  $("live2d-preview-expression").addEventListener("change", () => {
    if (!previewReady || !player) return;
    const name = $("live2d-preview-expression").value;
    player.update({ avatar: live2DAvatar(bundle, bindings()), avatarKey: `preview-${revision}` },
      { name, until: name === "neutral" ? 0 : Date.now() + 8000 }).catch((error) => status(error.message));
  });
  $("live2d-adopt").addEventListener("click", async () => {
    if ($("live2d-adopt").disabled) return;
    saving = true; controls();
    controller = new AbortController();
    try {
      await api("/api/avatar/live2d", { avatar: live2DAvatar(bundle, bindings()), ...basis }, { signal: controller.signal });
      dialog.close();
      clear();
      await refresh(true);
      notice("Live2D 形象已保存到本机。聊天和记忆继续保留。");
    } catch (error) {
      if (dialog.open) status(error.message || "形象未能保存，请核对当前资料。");
    } finally { saving = false; controls(); }
  });
  dialog.addEventListener("cancel", (event) => { if (saving) event.preventDefault(); });
  dialog.addEventListener("close", () => { if (!dialog.open) clear(); });
  window.addEventListener("pagehide", clear, { once: true });
  controls();
  return {
    open,
    openPackage(value) {
      open();
      if (value.format === "niria-live2d-avatar") {
        inspectLive2DAvatar(value); present(structuredClone(value.package), structuredClone(value.bindings));
      } else present(structuredClone(value));
    },
    update() {
      if (!dialog.open || !basis || saving) return;
      const current = data();
      if (current.avatarKey === basis.expectedAvatarKey && current.identity.id === basis.identityId) return;
      stale = true; busy = false; invalidate();
      status("伴侣或形象已经改变，请关闭后重新打开，核对当前资料。"); controls();
    }
  };
}
