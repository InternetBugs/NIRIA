import { EDGE_BACKGROUND, backgroundReady } from "./image-background.js";

export function backgroundEditor({ avatar, unpack, apply, basis, busy, setBusy, invalidate, notice }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#background-dialog"), status = $("#background-status");
  let controller = null, sequence = 0, preview = null, working = false;
  const same = (before) => before.every((value, i) => value === basis()[i]);
  function work(value) { working = value; setBusy(value); }
  function clear() {
    $("#background-before").removeAttribute("src");
    $("#background-after").removeAttribute("src");
    $("#background-frame").replaceChildren();
    $("#background-report").replaceChildren();
    $("#background-accept").disabled = true;
  }
  function cancel(close = true) {
    ++sequence;
    controller?.abort();
    controller = null; preview = null;
    if (working) work(false);
    if (close) dialog.close();
    clear();
  }
  function showFrame() {
    const frame = preview?.frames[$("#background-frame").value];
    if (!frame) return;
    $("#background-before").src = frame.raw;
    $("#background-after").src = frame.data;
  }
  async function open() {
    const current = avatar();
    if (!current || busy()) return;
    invalidate();
    const before = basis(), request = ++sequence;
    controller = new AbortController();
    work(true); clear();
    status.textContent = "正在本机检查原图和已有动作的边缘背景…";
    dialog.showModal();
    try {
      const prepared = await unpack({ ...current, background: EDGE_BACKGROUND }, { signal: controller.signal, previewBackground: true });
      if (request !== sequence || !dialog.open || !same(before)) return;
      const frames = { source: prepared.source, ...prepared.assets };
      preview = { prepared, before, frames };
      let changed = 0, compatible = true;
      for (const [name, frame] of Object.entries(frames)) {
        const label = { source: "原始形象", blink: "闭眼", smile: "微笑", curious: "疑惑", shy: "害羞" }[name];
        const report = frame.backgroundReport;
        changed += report?.status === "applied" ? 1 : 0;
        compatible &&= backgroundReady(report);
        const option = document.createElement("option");
        option.value = name; option.textContent = label;
        $("#background-frame").append(option);
        const item = document.createElement("li");
        item.textContent = `${label}：${report?.message || "保留原素材。"}`;
        $("#background-report").append(item);
      }
      status.textContent = !compatible ? "有素材无法可靠处理，当前形象保持原样。可换图或重做对应动作后再检查。"
        : changed ? "请逐张比较人物、头发和衣服。采用后仍保存原始素材，可随时恢复背景。"
        : "已有透明轮廓，未发现需要移除的纯色背景。";
      $("#background-accept").disabled = !compatible || !changed;
      showFrame();
    } catch (error) {
      if (request === sequence && error.name !== "AbortError") status.textContent = error.message;
    } finally { if (request === sequence) work(false); }
  }
  async function restore() {
    const current = avatar();
    if (!current?.background || busy()) return;
    invalidate();
    const before = basis(), request = ++sequence;
    controller = new AbortController();
    delete current.background;
    work(true);
    try {
      const prepared = await unpack(current, { signal: controller.signal });
      if (request !== sequence || !same(before)) return;
      work(false);
      apply(prepared);
      notice("已恢复原始背景，原图和动作素材均保留。保存到伴侣后生效。");
    } catch (error) {
      if (request === sequence && error.name !== "AbortError") notice(error.message, true);
    } finally { if (request === sequence) work(false); }
  }
  $("#background-button").addEventListener("click", () => avatar()?.background ? restore() : open());
  $("#background-frame").addEventListener("change", showFrame);
  $("#background-accept").addEventListener("click", () => {
    const selected = preview;
    if (!selected || $("#background-accept").disabled) return;
    if (!same(selected.before)) { cancel(); return notice("形象已改变，请重新检查背景。", true); }
    cancel();
    apply(selected.prepared);
    notice("已应用透明背景预览，原始素材仍保留。保存到伴侣后生效。");
  });
  dialog.addEventListener("close", () => { if (!dialog.open) cancel(false); });
  return { cancel };
}
