// Invalidation only: clients fetch the authenticated snapshot separately.
export function stateEvents(server, store) {
  const clients = new Set();
  let pending;
  const write = (response, value) => {
    if (response.destroyed || response.writableEnded || response.writableLength > 64 * 1024) {
      response.destroy();
      return;
    }
    response.write(value);
  };
  const changed = () => {
    if (pending) return;
    // Store listeners run within the transaction. Notify after its synchronous commit.
    pending = setImmediate(() => {
      pending = null;
      for (const response of clients) write(response, "event: state\ndata: {}\n\n");
    });
  };
  store.listeners.add(changed);
  server.once("close", () => {
    clearImmediate(pending);
    store.listeners.delete(changed);
    for (const response of clients) response.end();
  });
  return (response) => {
    if (clients.size >= 12) return false;
    response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" });
    clients.add(response);
    write(response, "event: state\ndata: {}\n\n");
    const heartbeat = setInterval(() => write(response, ": alive\n\n"), 25_000);
    heartbeat.unref();
    response.once("close", () => { clearInterval(heartbeat); clients.delete(response); });
    return true;
  };
}
