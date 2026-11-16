import type { Duplex } from "node:stream";
import type WebSocket from "ws";

type Ws = typeof import("ws");
let loading: Promise<Ws> | undefined;

// Next.js builds with webpack unless told to use Turbopack, and webpack swaps
// ws's optional native helpers (bufferutil, utf-8-validate) for empty modules.
// ws then believes they loaded, and the first frame of 48 bytes or more throws
// "mask is not a function". These flags make ws use its own JavaScript
// versions instead, so ws is loaded here, after they are set, and not at the
// top of the file.
function loadWs(): Promise<Ws> {
  process.env.WS_NO_BUFFER_UTIL ||= "1";
  process.env.WS_NO_UTF_8_VALIDATE ||= "1";
  return (loading ??= import("ws"));
}

export interface TunnelOptions {
  /** Tunnel hostname, such as `db.example.com`. Defaults to `DB_TUNNEL_HOST`. */
  host?: string;
  /** Cloudflare Access service token ID. Defaults to `CF_ACCESS_CLIENT_ID`. */
  clientId?: string;
  /** Cloudflare Access service token secret. Defaults to `CF_ACCESS_CLIENT_SECRET`. */
  clientSecret?: string;
  /** How long to wait for Cloudflare to open the tunnel, in milliseconds. */
  timeoutMs?: number;
  /**
   * How often an open connection checks the tunnel still answers, and how long
   * it waits for the answer, in milliseconds. A connection that does not answer
   * in time is closed. Defaults to 5000.
   */
  heartbeatMs?: number;
}

interface Settings {
  url: string;
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
  heartbeatMs: number;
}

// Short enough that a dead connection fails its query well inside a serverless
// function's time limit, rather than hanging until the platform kills it. The
// same pings keep an idle connection from being dropped.
const HEARTBEAT_MS = 5_000;

function settings(options: TunnelOptions): Settings {
  const host = options.host ?? process.env.DB_TUNNEL_HOST;
  const clientId = options.clientId ?? process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = options.clientSecret ?? process.env.CF_ACCESS_CLIENT_SECRET;

  const missing = [
    !host && "DB_TUNNEL_HOST",
    !clientId && "CF_ACCESS_CLIENT_ID",
    !clientSecret && "CF_ACCESS_CLIENT_SECRET",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `pg-access-tunnel: ${missing.join(", ")} not set. The database is only ` +
        "reachable through the Cloudflare tunnel, so this app cannot connect without them.",
    );
  }

  return {
    // A full ws:// or wss:// address is accepted so tests can use a local server.
    url: /^wss?:\/\//.test(host!) ? host! : `wss://${host}`,
    clientId: clientId!,
    clientSecret: clientSecret!,
    timeoutMs: options.timeoutMs ?? 10_000,
    heartbeatMs: options.heartbeatMs ?? HEARTBEAT_MS,
  };
}

function refused(url: string, status: number | undefined): Error {
  const why =
    status === 401 || status === 403
      ? "Cloudflare refused the service token. Check CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET."
      : status === 502 || status === 530
        ? "Cloudflare could not reach the database server. Check the cloudflared service on it."
        : "Cloudflare did not open the tunnel.";
  return new Error(`pg-access-tunnel: ${url} answered HTTP ${status}. ${why}`);
}

/**
 * Closes the stream when the tunnel closes the WebSocket.
 *
 * ws's stream only ends its readable side when the WebSocket closes, and under
 * postgres.js's TLS socket that never becomes a "close". postgres.js then keeps
 * the dead connection in its pool: a query already sent waits for ever, and the
 * next one fails with "WebSocket is not open". Destroying the stream tells
 * postgres.js the connection has gone, which fails the query in flight and
 * opens a fresh connection for the next one.
 */
function closeWithTunnel(ws: WebSocket, stream: Duplex): void {
  ws.once("close", (code: number) => {
    if (stream.destroyed) return;
    // The app ending its own connection is the normal way to close, not a fault.
    stream.destroy(
      stream.writableEnded
        ? undefined
        : new Error(`pg-access-tunnel: the tunnel closed the connection (WebSocket code ${code}).`),
    );
  });
}

/**
 * Closes the stream when the tunnel stops answering.
 *
 * A connection can die without closing: the far end goes away and no packet
 * says so. A query sent down it waits for a reply that never comes. The tunnel
 * answers a ping in milliseconds, so a ping left unanswered for `heartbeatMs`
 * means the connection is dead, and closing it fails the query in flight
 * instead of leaving it to hang.
 */
function closeWhenSilent(ws: WebSocket, stream: Duplex, heartbeatMs: number): void {
  let heardAt = Date.now();
  const heard = () => {
    heardAt = Date.now();
  };
  ws.on("message", heard);
  ws.on("pong", heard);

  let waiting: NodeJS.Timeout | undefined;
  const ping = () => {
    if (waiting || ws.readyState !== ws.OPEN) return;
    const sentAt = Date.now();
    ws.ping();
    waiting = setTimeout(() => {
      waiting = undefined;
      if (heardAt >= sentAt) return;
      // A timer this late means the process was frozen between requests or
      // busy, and a paused socket means the app has not read what arrived.
      // Neither says the tunnel went quiet, so ask again rather than judge.
      if (ws.isPaused || Date.now() - sentAt > 2 * heartbeatMs) return ping();
      // Let anything already waiting on the socket be read before deciding.
      setImmediate(() => {
        // An app already closing its own connection is not a fault either.
        if (heardAt >= sentAt || stream.destroyed || stream.writableEnded) return;
        stream.destroy(
          new Error(
            `pg-access-tunnel: the tunnel did not answer for ${heartbeatMs} ms, so the connection was closed.`,
          ),
        );
      });
    }, heartbeatMs);
    // Unref'd, so neither timer ever holds a serverless function open.
    waiting.unref();
  };

  const every = setInterval(ping, heartbeatMs);
  every.unref();
  ws.once("close", () => {
    clearInterval(every);
    clearTimeout(waiting);
  });
}

async function open(s: Settings): Promise<Duplex> {
  const mod = await loadWs();
  // ESM gives the class as `default`; CommonJS interop gives the module itself.
  const WebSocketClass = (mod.default ?? mod) as typeof WebSocket;
  const createWebSocketStream =
    mod.createWebSocketStream ?? (WebSocketClass as unknown as Ws).createWebSocketStream;

  return new Promise((resolve, reject) => {
    const ws = new WebSocketClass(s.url, {
      headers: {
        "CF-Access-Client-Id": s.clientId,
        "CF-Access-Client-Secret": s.clientSecret,
      },
      handshakeTimeout: s.timeoutMs,
      // Postgres TLS runs inside the tunnel, so compressing it gains nothing.
      perMessageDeflate: false,
    });

    let settled = false;
    const fail = (error: Error) => {
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

      // postgres.js only sends its goodbye message to a socket that reports
      // itself open, as a net.Socket would.
      Object.defineProperty(stream, "readyState", {
        get: () => (ws.readyState === ws.OPEN ? "open" : "closed"),
      });

      resolve(stream);
    });
  });
}

/**
 * A postgres.js `socket` option that opens each connection through the
 * Cloudflare tunnel. Settings are checked straight away, so a missing
 * variable fails the build or the first request, never silently.
 */
export function tunnelSocket(options: TunnelOptions = {}): () => Promise<Duplex> {
  const s = settings(options);
  return () => open(s);
}

/**
 * Wraps a postgres.js config so every connection goes through the tunnel.
 *
 *   const sql = postgres(viaTunnel({ database, username, password, ssl }))
 *
 * `host` and `port` are dropped because the tunnel decides where to connect.
 * Postgres TLS is switched on when the config leaves it off, so Cloudflare
 * only ever carries encrypted bytes.
 */
export function viaTunnel<T extends object>(config: T, options?: TunnelOptions): T {
  const { host: _host, port: _port, ...rest } = config as T & { host?: unknown; port?: unknown };
  const ssl = (config as { ssl?: unknown }).ssl;
  return { ...rest, ssl: ssl || "require", socket: tunnelSocket(options) } as T;
}
