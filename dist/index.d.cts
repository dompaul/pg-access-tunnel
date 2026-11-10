import { Duplex } from 'node:stream';

interface TunnelOptions {
    /** Tunnel hostname, such as `db.example.com`. Defaults to `DB_TUNNEL_HOST`. */
    host?: string;
    /** Cloudflare Access service token ID. Defaults to `CF_ACCESS_CLIENT_ID`. */
    clientId?: string;
    /** Cloudflare Access service token secret. Defaults to `CF_ACCESS_CLIENT_SECRET`. */
    clientSecret?: string;
    /** How long to wait for Cloudflare to open the tunnel, in milliseconds. */
    timeoutMs?: number;
}
/**
 * A postgres.js `socket` option that opens each connection through the
 * Cloudflare tunnel. Settings are checked straight away, so a missing
 * variable fails the build or the first request, never silently.
 */
declare function tunnelSocket(options?: TunnelOptions): () => Promise<Duplex>;
/**
 * Wraps a postgres.js config so every connection goes through the tunnel.
 *
 *   const sql = postgres(viaTunnel({ database, username, password, ssl }))
 *
 * `host` and `port` are dropped because the tunnel decides where to connect.
 * Postgres TLS is switched on when the config leaves it off, so Cloudflare
 * only ever carries encrypted bytes.
 */
declare function viaTunnel<T extends object>(config: T, options?: TunnelOptions): T;

export { type TunnelOptions, tunnelSocket, viaTunnel };
