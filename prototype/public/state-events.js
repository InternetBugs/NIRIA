export function watchState(token, refresh) {
  const lifetime = new AbortController();
  let retry, refreshing = false, dirty = false;
  const changed = async () => {
    dirty = true;
    if (refreshing || document.hidden || lifetime.signal.aborted) return;
    refreshing = true;
    try {
      do {
        dirty = false;
        await refresh();
      } while (dirty && !document.hidden && !lifetime.signal.aborted);
    } catch { /* Periodic refresh and reconnect retain local data on failure. */ }
    finally { refreshing = false; }
  };
  const connect = async () => {
    let reader;
    try {
      const response = await fetch("/api/events", {
        headers: { "X-Niria-Token": token }, signal: lifetime.signal
      });
      if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream")) throw new Error("State stream unavailable");
      document.documentElement.dataset.liveUpdates = "connected";
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!lifetime.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 16384) throw new Error("State event exceeds limit");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (event.split("\n").some((line) => line === "event: state")) changed();
        }
      }
    } catch { /* A disconnected local stream never retries a provider request. */ }
    finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      document.documentElement.dataset.liveUpdates = "disconnected";
      if (!lifetime.signal.aborted) retry = setTimeout(connect, 3000);
    }
  };
  const visible = () => { if (!document.hidden) changed(); };
  const stop = () => {
    lifetime.abort();
    clearTimeout(retry);
    document.removeEventListener("visibilitychange", visible);
  };
  document.addEventListener("visibilitychange", visible);
  window.addEventListener("pagehide", stop, { once: true });
  connect();
  return stop;
}
