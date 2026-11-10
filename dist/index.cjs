"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var src_exports = {};
__export(src_exports, {
  tunnelSocket: () => tunnelSocket,
  viaTunnel: () => viaTunnel
});
module.exports = __toCommonJS(src_exports);
var loading;
function loadWs() {
  var _a, _b;
  (_a = process.env).WS_NO_BUFFER_UTIL || (_a.WS_NO_BUFFER_UTIL = "1");
  (_b = process.env).WS_NO_UTF_8_VALIDATE || (_b.WS_NO_UTF_8_VALIDATE = "1");
  return loading ?? (loading = import("ws"));
}
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
      const ping = setInterval(() => ws.ping(), PING_EVERY_MS);
      ping.unref();
      ws.once("close", () => clearInterval(ping));
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  tunnelSocket,
  viaTunnel
});
