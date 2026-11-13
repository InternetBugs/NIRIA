// Only notify the local process that the composer is in use. Draft text never
// leaves the input through this path; activity is neither stored nor synced.
export function chatActivity({ api, throttleMs = 1000 }) {
  const lifetime = new AbortController();
  let timer, inFlight = false, dirty = false, lastSent = -Infinity;
  const schedule = () => {
    if (lifetime.signal.aborted || inFlight || timer !== undefined || !dirty) return;
    const delay = Math.max(0, throttleMs - (Date.now() - lastSent));
    if (delay) timer = setTimeout(flush, delay);
    else flush();
  };
  const flush = () => {
    timer = undefined;
    if (lifetime.signal.aborted || inFlight || !dirty) return;
    dirty = false;
    inFlight = true;
    lastSent = Date.now();
    Promise.resolve().then(() => {
      if (!lifetime.signal.aborted) return api("/api/chat/activity", {}, { signal: lifetime.signal });
    }).catch(() => {
      // A later user interaction may try again; never retry on an idle page.
    }).finally(() => { inFlight = false; schedule(); });
  };
  return {
    changed() { dirty = true; schedule(); },
    stop() { dirty = false; clearTimeout(timer); timer = undefined; lifetime.abort(); }
  };
}
