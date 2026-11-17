export function chatModelPicker({ api }) {
  const $ = (selector) => document.querySelector(selector);
  const button = $("#chat-models-fetch"), panel = $("#chat-models-panel");
  const search = $("#chat-model-search"), results = $("#chat-model-results");
  const status = $("#chat-models-status"), model = $("#chat-model");
  let models = [], controller, generation = 0;
  const access = () => ({
    baseUrl: $("#chat-base").value, apiKey: $("#chat-key").value, reuseSecret: $("#chat-reuse").checked
  });
  const loading = (active) => {
    button.textContent = active ? "取消获取" : "获取模型";
    results.setAttribute("aria-busy", String(active));
  };
  function reset(message = "") {
    ++generation;
    controller?.abort(); controller = null;
    models = []; results.replaceChildren(); search.value = ""; panel.hidden = true;
    loading(false); status.textContent = message;
  }
  function render() {
    const query = search.value.trim().toLowerCase();
    const matches = models.filter((id) => id.toLowerCase().includes(query));
    const fragment = document.createDocumentFragment();
    // Keep large provider catalogs responsive; narrowing the search exposes the rest.
    for (const id of matches.slice(0, 100)) {
      const choice = document.createElement("button");
      choice.type = "button"; choice.className = "model-choice"; choice.textContent = id;
      choice.setAttribute("aria-pressed", String(model.value === id));
      choice.addEventListener("click", () => {
        model.value = id;
        model.dispatchEvent(new Event("input", { bubbles: true }));
        status.textContent = `已选择 ${id}，点击“应用连接”后使用。`;
      });
      fragment.append(choice);
    }
    results.replaceChildren(fragment);
    status.textContent = matches.length
      ? `共 ${models.length} 个模型，匹配 ${matches.length} 个${matches.length > 100 ? "，显示前 100 个，请继续搜索" : "，点击选择"}。`
      : models.length ? "没有匹配的模型，可以换个关键词或手动填写模型名称。" : "服务返回了空模型列表，请手动填写模型名称。";
  }
  async function load() {
    if (controller) { reset("已取消获取，可以重新获取或手动填写模型名称。"); return; }
    reset();
    const current = ++generation, config = access(), request = new AbortController();
    controller = request; loading(true); status.textContent = "正在获取模型列表…";
    try {
      const payload = await api("/api/connection/models", config, { signal: request.signal });
      if (generation !== current || request.signal.aborted || JSON.stringify(access()) !== JSON.stringify(config)) return;
      if (!$("#settings-dialog").open || $('[data-settings="connection"]').hidden) { reset(); return; }
      models = payload.models;
      panel.hidden = models.length === 0;
      render();
      if (!panel.hidden) search.focus();
    } catch (error) {
      if (generation === current && !request.signal.aborted) status.textContent = error.message;
    } finally {
      if (generation === current) { controller = null; loading(false); }
    }
  }
  button.addEventListener("click", load);
  search.addEventListener("input", render);
  search.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      results.querySelector("button")?.focus();
    }
  });
  model.addEventListener("input", () => {
    for (const choice of results.children) choice.setAttribute("aria-pressed", String(choice.textContent === model.value));
  });
  for (const selector of ["#chat-base", "#chat-key", "#chat-reuse"]) {
    $(selector).addEventListener("input", () => reset("连接信息已改变，请重新获取模型列表。"));
    $(selector).addEventListener("change", () => reset("连接信息已改变，请重新获取模型列表。"));
  }
  $("#settings-dialog").addEventListener("close", () => { if (!$("#settings-dialog").open) reset(); });
  $("#settings-dialog").addEventListener("cancel", () => reset());
  $('[data-close="settings-dialog"]').addEventListener("click", () => reset());
  window.addEventListener("pagehide", () => reset(), { once: true });
  return { reset };
}
