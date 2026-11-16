// src/index.ts
var loading;
function loadWs() {
  var _a, _b;
  (_a = process.env).WS_NO_BUFFER_UTIL || (_a.WS_NO_BUFFER_UTIL = "1");
  (_b = process.env).WS_NO_UTF_8_VALIDATE || (_b.WS_NO_UTF_8_VALIDATE = "1");
  return loading ?? (loading = import("ws"));
}
var HEARTBEAT_MS = 5e3;
function settings(options) {
  const host = options.host ?? process.env.DB_TUNNEL_HOST;
  const clientId = options.clientId ?? process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = options.clientSecret ?? process.env.CF_ACCESS_CLIENT_SECRET;
  const missing = [
    !host && "DB_TUNNEL_HOST",
    !clientId && "CF_ACCESS_CLIENT_ID",
    !clientSecret && "CF_ACCESS_CLIENT_SECRET"
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `pg-access-tunnel: ${missing.join(", ")} not set. The database is only reachable through the Cloudflare tunnel, so this app cannot connect without them.`
    );
  }
  return {
    // A full ws:// or wss:// address is accepted so tests can use a local server.
    url: /^wss?:\/\//.test(host) ? host : `wss://${host}`,
    clientId,
    clientSecret,
    timeoutMs: options.timeoutMs ?? 1e4,
    heartbeatMs: options.heartbeatMs ?? HEARTBEAT_MS
  };
}
function refused(url, status) {
  const why = status === 401 || status === 403 ? "Cloudflare refused the service token. Check CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET." : status === 502 || status === 530 ? "Cloudflare could not reach the database server. Check the cloudflared service on it." : "Cloudflare did not open the tunnel.";
  return new Error(`pg-access-tunnel: ${url} answered HTTP ${status}. ${why}`);
}
function closeWithTunnel(ws, stream) {
  ws.once("close", (code) => {
    if (stream.destroyed) return;
    stream.destroy(
      stream.writableEnded ? void 0 : new Error(`pg-access-tunnel: the tunnel closed the connection (WebSocket code ${code}).`)
    );
  });
}
function closeWhenSilent(ws, stream, heartbeatMs) {
  let heardAt = Date.now();
  const heard = () => {
    heardAt = Date.now();
  };
  ws.on("message", heard);
  ws.on("pong", heard);
  let waiting;
  const ping = () => {
    if (waiting || ws.readyState !== ws.OPEN) return;
    const sentAt = Date.now();
    ws.ping();
    waiting = setTimeout(() => {
      waiting = void 0;
      if (heardAt >= sentAt) return;
      if (ws.isPaused || Date.now() - sentAt > 2 * heartbeatMs) return ping();
      setImmediate(() => {
        if (heardAt >= sentAt || stream.destroyed || stream.writableEnded) return;
        stream.destroy(
          new Error(
            `pg-access-tunnel: the tunnel did not answer for ${heartbeatMs} ms, so the connection was closed.`
          )
        );
      });
    }, heartbeatMs);
    waiting.unref();
  };
  const every = setInterval(ping, heartbeatMs);
  every.unref();
  ws.once("close", () => {
    clearInterval(every);
    clearTimeout(waiting);
  });
}
async function open(s) {
  const mod = await loadWs();
  const WebSocketClass = mod.default ?? mod;
  const createWebSocketStream = mod.createWebSocketStream ?? WebSocketClass.createWebSocketStream;
  return new Promise((resolve, reject) => {
    const ws = new WebSocketClass(s.url, {
      headers: {
        "CF-Access-Client-Id": s.clientId,
        "CF-Access-Client-Secret": s.clientSecret
      },
      handshakeTimeout: s.timeoutMs,
      // Postgres TLS runs inside the tunnel, so compressing it gains nothing.
      perMessageDeflate: false
    });
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    ws.on("error", fail);
    ws.once("unexpected-response", (request, response) => {
      fail(refused(s.url, response.statusCode));
      request.destroy();
    });
    ws.once("open", () => {
      settled = true;
      ws.off("error", fail);
      const stream = createWebSocketStream(ws);
      closeWithTunnel(ws, stream);
      closeWhenSilent(ws, stream, s.heartbeatMs);
      Object.defineProperty(stream, "readyState", {
        get: () => ws.readyState === ws.OPEN ? "open" : "closed"
      });
      resolve(stream);
    });
  });
}
function tunnelSocket(options = {}) {
  const s = settings(options);
  return () => open(s);
}
function viaTunnel(config, options) {
  const { host: _host, port: _port, ...rest } = config;
  const ssl = config.ssl;
  return { ...rest, ssl: ssl || "require", socket: tunnelSocket(options) };
}
export {
  tunnelSocket,
  viaTunnel
};
