export function forgetReview({ api, refresh, notice, stopAudio, openHistory, data }) {
  const $ = (selector) => document.querySelector(selector);
  const dialog = $("#forget-dialog"), list = $("#forget-list"), status = $("#forget-status");
  let target = null, plan = null, controller = null, sequence = 0, baseline = "", committing = false;
  const signature = () => {
    const current = data();
    return JSON.stringify([current.identity.id, current.messageWindow?.revision, current.memoryWindow?.revision]);
  };
  function clear() {
    plan = null;
    list.replaceChildren();
    $("#forget-counts").textContent = "";
    $("#forget-confirm").disabled = true;
    $("#forget-more").hidden = true;
  }
  function append(items) {
    for (const item of items) {
      const card = document.createElement("article");
      card.className = "forget-item";
      card.dataset.id = item.id;
      const label = document.createElement("p");
      label.className = "forget-item-label";
      label.textContent = { target: "这条记忆", derived: "衍生记忆", source: "来源消息", reply: "关联回复" }[item.relationship] +
        (item.conflicted ? " · 包含冲突版本" : "");
      const content = document.createElement("p");
      content.textContent = item.content || "消息尚未完成，没有正文。";
      card.append(label, content);
      if (item.kind === "message") {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "text-button";
        button.textContent = item.truncated ? "查看完整消息" : "查看前后聊天";
        button.addEventListener("click", () => openHistory(item.id));
        card.append(button);
      }
      list.append(card);
    }
  }
  async function load(more = false, changed = false) {
    controller?.abort();
    controller = new AbortController();
    const request = ++sequence, id = target, previous = plan;
    baseline = signature();
    if (!more) clear();
    $("#forget-confirm").disabled = true;
    $("#forget-more").disabled = true;
    status.textContent = changed ? "相关记录已变化，正在重新计算清单；请查看后再确认。" : "正在核对本机的来源和回复关系…";
    try {
      const result = await api("/api/memories/forget-preview", {
        id, ...(more ? { token: previous.token, offset: previous.nextOffset } : {})
      }, { signal: controller.signal });
      if (request !== sequence || !dialog.open) return;
      if (signature() !== baseline) return load(false, true);
      plan = result;
      const counts = result.counts;
      $("#forget-counts").textContent = `将删除 ${counts.memories} 条记忆、${counts.sourceMessages} 条来源消息、${counts.replies} 条关联回复。` +
        (counts.unavailableSources ? `另有 ${counts.unavailableSources} 条本机已不可读的来源会保留遗忘标记。` : "");
      append(result.items);
      status.textContent = `${changed ? "清单已更新，请重新查看。 " : ""}已列出 ${list.children.length} / ${result.total} 条本机记录。`;
      $("#forget-more").hidden = result.nextOffset === null;
      $("#forget-more").disabled = false;
      $("#forget-confirm").disabled = false;
    } catch (error) {
      if (request !== sequence || !dialog.open || error.name === "AbortError") return;
      if (error.status === 409) return load(false, true);
      clear();
      status.textContent = error.message;
    }
  }
  $("#forget-more").addEventListener("click", () => plan?.nextOffset !== null && plan && load(true));
  $("#forget-refresh").addEventListener("click", () => load());
  $("#forget-confirm").addEventListener("click", async () => {
    if (!plan || committing) return;
    const selected = plan, request = ++sequence;
    committing = true;
    controller?.abort();
    $("#forget-confirm").disabled = true;
    $("#forget-more").disabled = true;
    $("#forget-refresh").disabled = true;
    status.textContent = "正在保存遗忘标记…";
    try {
      stopAudio();
      await api("/api/memories/delete", { id: selected.id, forgetSources: true, previewToken: selected.token });
      if (request === sequence) dialog.close();
      await refresh();
      notice("清单中的记忆和聊天已遗忘；已保存删除标记，旧资料不会自动恢复。");
    } catch (error) {
      if (request !== sequence || !dialog.open) return;
      if (error.status === 409) await load(false, true);
      else { clear(); status.textContent = error.message; }
    } finally {
      committing = false;
      $("#forget-refresh").disabled = false;
    }
  });
  dialog.addEventListener("close", () => {
    // A close event can arrive after the same dialog has already reopened.
    if (dialog.open) return;
    ++sequence;
    controller?.abort();
    target = null;
    baseline = "";
    clear();
    status.textContent = "";
  });
  return {
    open(id) {
      if (committing) return notice("正在保存上一份遗忘清单，请稍候。");
      target = id;
      if (!dialog.open) dialog.showModal();
      return load();
    },
    update() {
      if (dialog.open && !committing && signature() !== baseline) load(false, true);
    }
  };
}
