import type { Duplex } from "node:stream";
import WebSocket, { createWebSocketStream } from "ws";

export interface TunnelOptions {
  /** Tunnel hostname, such as `db.example.com`. Defaults to `DB_TUNNEL_HOST`. */
  host?: string;
  /** Cloudflare Access service token ID. Defaults to `CF_ACCESS_CLIENT_ID`. */
  clientId?: string;
  /** Cloudflare Access service token secret. Defaults to `CF_ACCESS_CLIENT_SECRET`. */
  clientSecret?: string;
  /** How long to wait for Cloudflare to open the tunnel, in milliseconds. */
  timeoutMs?: number;
}

interface Settings {
  url: string;
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
}

// Keeps an idle connection from being dropped part way through the pool's
// idle timeout. Unref'd, so it never holds a serverless function open.
const PING_EVERY_MS = 30_000;

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

function open(s: Settings): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(s.url, {
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
      const ping = setInterval(() => ws.ping(), PING_EVERY_MS);
      ping.unref();
      ws.once("close", () => clearInterval(ping));

      // postgres.js only sends its goodbye message to a socket that reports
      // itself open, as a net.Socket would.
      Object.defineProperty(stream, "readyState", {
        get: () => (ws.readyState === WebSocket.OPEN ? "open" : "closed"),
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
