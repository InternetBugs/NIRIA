import { AvatarPlayer } from "./avatar-player.js";
import { watchState } from "./state-events.js";

const $ = (q) => document.querySelector(q);
let token, currentData, refreshing, again = false, fullAssets = false;
const player = new AvatarPlayer($("#widget-canvas"), {
  presence: (visible) => { $("#widget-canvas").hidden = !visible; $("#widget-empty").hidden = visible; },
  error: (message) => { $("#widget-last").textContent = message; }
});
function refresh(assets = false) {
  fullAssets ||= assets;
  if (refreshing) { again = true; return refreshing; }
  refreshing = (async () => {
    do {
      again = false;
      const full = fullAssets;
      fullAssets = false;
      const response = await fetch(`/api/state?messages=recent&memories=none${full ? "" : "&assets=0"}`, { headers: { "X-Niria-Token": token } });
      if (!response.ok) throw new Error("无法读取本机资料");
      let data = await response.json();
      if (!Object.hasOwn(data, "avatar")) {
        if (data.avatarKey && data.avatarKey !== currentData?.avatarKey) {
          const assetsResponse = await fetch("/api/state?messages=recent&memories=none", { headers: { "X-Niria-Token": token } });
          if (!assetsResponse.ok) throw new Error("无法读取形象");
          data = await assetsResponse.json();
        } else data.avatar = data.avatarKey ? currentData?.avatar || null : null;
      }
      currentData = data;
      $("#widget-name").textContent = data.identity.name;
      const last = data.messages.findLast((m) => m.role === "assistant" && !m.deleted && !m.conflicted && m.status === "completed");
      $("#widget-last").textContent = last?.content || "点击和她聊聊";
      await player.update(data);
      if ($("#widget-canvas").dataset.live2dError) $("#widget-last").textContent = $("#widget-canvas").dataset.live2dError;
    } while (again || fullAssets);
  })().finally(() => { refreshing = null; });
  return refreshing;
}
$("#widget-chat").addEventListener("click", () => window.niriaDesktop?.showMain());
$("#widget-last").addEventListener("click", () => window.niriaDesktop?.showMain());
$("#widget-hide").addEventListener("click", () => window.niriaDesktop?.hideWidget());
function desktopState(state) {
  document.body.classList.toggle("collapsed", !!state.collapsed);
  $("#widget-collapse").textContent = state.collapsed ? "+" : "−";
  $("#widget-collapse").setAttribute("aria-label", state.collapsed ? "展开伴侣" : "收起伴侣");
  $("#widget-topmost").setAttribute("aria-pressed", String(!!state.alwaysOnTop));
  $("#widget-warning").textContent = state.warning || "";
  $("#widget-warning").hidden = !state.warning;
}
$("#widget-topmost").hidden = !window.niriaDesktop;
$("#widget-topmost").addEventListener("click", async () => {
  desktopState(await window.niriaDesktop.toggleTopmost());
});
$("#widget-collapse").addEventListener("click", async () => {
  const collapsed = await window.niriaDesktop?.collapseWidget();
  if (!window.niriaDesktop) document.body.classList.toggle("collapsed", !!collapsed);
});
window.niriaDesktop?.onDesktopState(desktopState);
if (window.niriaDesktop) desktopState(await window.niriaDesktop.desktopState());
try {
  token = (await (await fetch("/api/session")).json()).token;
  await refresh(true);
  watchState(token, refresh);
  setInterval(() => refresh().catch(() => {}), 15000);
} catch { $("#widget-last").textContent = "连接已中断，请重新打开 NIRIA"; }
