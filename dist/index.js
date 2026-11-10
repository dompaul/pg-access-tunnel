// src/index.ts
import WebSocket, { createWebSocketStream } from "ws";
var PING_EVERY_MS = 3e4;
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
    timeoutMs: options.timeoutMs ?? 1e4
  };
}
function refused(url, status) {
  const why = status === 401 || status === 403 ? "Cloudflare refused the service token. Check CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET." : status === 502 || status === 530 ? "Cloudflare could not reach the database server. Check the cloudflared service on it." : "Cloudflare did not open the tunnel.";
  return new Error(`pg-access-tunnel: ${url} answered HTTP ${status}. ${why}`);
}
function open(s) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(s.url, {
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
      const ping = setInterval(() => ws.ping(), PING_EVERY_MS);
      ping.unref();
      ws.once("close", () => clearInterval(ping));
      Object.defineProperty(stream, "readyState", {
        get: () => ws.readyState === WebSocket.OPEN ? "open" : "closed"
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
