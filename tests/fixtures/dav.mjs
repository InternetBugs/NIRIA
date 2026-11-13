import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";

export async function davFixture({ ignoreConditions = false, weakETag = false, auth = "", onPut } = {}) {
  const objects = new Map();
  const directories = new Set();
  const calls = [];
  let revision = 0;
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const data = Buffer.concat(chunks);
    calls.push({ method: request.method, path: request.url, body: data, headers: request.headers });
    if (auth && request.headers.authorization !== auth) { response.writeHead(401); response.end("credentials must not leak"); return; }
    const path = request.url;
    const current = objects.get(path);
    if (request.method === "MKCOL") {
      const exists = directories.has(path);
      directories.add(path); response.writeHead(exists ? 405 : 201); response.end(); return;
    }
    if (request.method === "PROPFIND") {
      if (!directories.has(path)) { response.writeHead(404); response.end(); return; }
      response.writeHead(207, { "Content-Type": "application/xml" });
      response.end('<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>');
      return;
    }
    if (request.method === "PUT") {
      if (onPut) await onPut({ path, data, objects, request });
      const latest = objects.get(path);
      if (!ignoreConditions && ((request.headers["if-none-match"] === "*" && latest) ||
          (request.headers["if-match"] && request.headers["if-match"] !== latest?.etag))) {
        response.writeHead(412); response.end(); return;
      }
      const etag = `"${++revision}-${createHash("sha256").update(data).digest("hex").slice(0, 10)}"`;
      objects.set(path, { data, etag });
      response.writeHead(latest ? 204 : 201, { ETag: etag }); response.end(); return;
    }
    if (request.method === "GET") {
      if (!current) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { ETag: weakETag ? `W/${current.etag}` : current.etag, "Content-Type": "application/octet-stream" });
      response.end(current.data); return;
    }
    if (request.method === "DELETE") { objects.delete(path); response.writeHead(204); response.end(); return; }
    response.writeHead(405); response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/dav/`, objects, calls,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); })
  };
}
