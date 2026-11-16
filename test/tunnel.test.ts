import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { tunnelSocket, viaTunnel } from "../src/index";

const TOKEN = { clientId: "id.access", clientSecret: "secret" };

// Stands in for Cloudflare: checks the service token, then echoes bytes back.
// A silent edge accepts the connection and then never answers anything, not
// even a ping, which is how a connection that died without closing behaves.
function fakeEdge(status?: number, { silent = false } = {}) {
  const seen: Record<string, string | undefined> = {};
  const sockets: WebSocket[] = [];
  const server = new WebSocketServer({
    port: 0,
    autoPong: !silent,
    verifyClient: (info, done) => {
      seen.id = info.req.headers["cf-access-client-id"] as string | undefined;
      seen.secret = info.req.headers["cf-access-client-secret"] as string | undefined;
      status ? done(false, status) : done(true);
    },
  });
  server.on("connection", (ws) => {
    sockets.push(ws);
    if (!silent) ws.on("message", (data) => ws.send(data));
  });
  const url = () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, seen, sockets, url };
}

const readyState = (stream: Duplex) => (stream as unknown as { readyState: string }).readyState;

describe("tunnelSocket", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("names every missing setting", () => {
    delete process.env.DB_TUNNEL_HOST;
    delete process.env.CF_ACCESS_CLIENT_ID;
    delete process.env.CF_ACCESS_CLIENT_SECRET;
    expect(() => tunnelSocket()).toThrow(
      "DB_TUNNEL_HOST, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET not set",
    );
  });

  it("reads its settings from the environment", () => {
    process.env.DB_TUNNEL_HOST = "db.example.test";
    process.env.CF_ACCESS_CLIENT_ID = TOKEN.clientId;
    process.env.CF_ACCESS_CLIENT_SECRET = TOKEN.clientSecret;
    expect(() => tunnelSocket()).not.toThrow();
  });

  it("sends the service token and carries bytes both ways", async () => {
    const edge = fakeEdge();
    try {
      const stream = await tunnelSocket({ host: edge.url(), ...TOKEN })();
      expect(edge.seen).toEqual({ id: TOKEN.clientId, secret: TOKEN.clientSecret });
      // Set before ws loads, so a bundler's empty stand-ins are never used.
      expect(process.env.WS_NO_BUFFER_UTIL).toBe("1");
      expect(process.env.WS_NO_UTF_8_VALIDATE).toBe("1");
      expect(readyState(stream)).toBe("open");

      const reply = new Promise<Buffer>((r) => stream.once("data", r));
      stream.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));
      expect([...(await reply)]).toEqual([0, 0, 0, 8, 4, 210, 22, 47]);

      // The app closing its own connection is not an error.
      const errors: Error[] = [];
      stream.on("error", (e) => errors.push(e));
      const closed = new Promise((r) => stream.once("close", r));
      stream.end();
      await closed;
      expect(readyState(stream)).toBe("closed");
      expect(errors).toEqual([]);
    } finally {
      edge.server.close();
    }
  });

  // Without this, postgres.js never hears that the connection went: the query
  // in flight waits for ever and the next one fails with "WebSocket is not open".
  it("closes the stream when the tunnel closes the connection", async () => {
    const edge = fakeEdge();
    try {
      const stream = await tunnelSocket({ host: edge.url(), ...TOKEN })();
      const failed = new Promise<Error>((r) => stream.once("error", r));
      const closed = new Promise((r) => stream.once("close", r));

      edge.sockets[0].close(1001);

      expect((await failed).message).toBe(
        "pg-access-tunnel: the tunnel closed the connection (WebSocket code 1001).",
      );
      await closed;
      expect(readyState(stream)).toBe("closed");
    } finally {
      edge.server.close();
    }
  });

  it("closes a connection the tunnel has stopped answering", async () => {
    const edge = fakeEdge(undefined, { silent: true });
    try {
      const stream = await tunnelSocket({ host: edge.url(), ...TOKEN, heartbeatMs: 50 })();
      const failed = new Promise<Error>((r) => stream.once("error", r));
      const closed = new Promise((r) => stream.once("close", r));

      // A query sent down a dead connection gets no reply.
      stream.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));

      expect((await failed).message).toBe(
        "pg-access-tunnel: the tunnel did not answer for 50 ms, so the connection was closed.",
      );
      await closed;
      expect(readyState(stream)).toBe("closed");
    } finally {
      edge.server.close();
    }
  });

  it("keeps a connection the tunnel still answers, however long it sits idle", async () => {
    const edge = fakeEdge();
    try {
      const stream = await tunnelSocket({ host: edge.url(), ...TOKEN, heartbeatMs: 20 })();
      const errors: Error[] = [];
      stream.on("error", (e) => errors.push(e));

      await new Promise((r) => setTimeout(r, 300));

      expect(errors).toEqual([]);
      expect(readyState(stream)).toBe("open");
      const closed = new Promise((r) => stream.once("close", r));
      stream.end();
      await closed;
    } finally {
      edge.server.close();
    }
  });

  it("explains a refused service token", async () => {
    const edge = fakeEdge(403);
    try {
      await expect(tunnelSocket({ host: edge.url(), ...TOKEN })()).rejects.toThrow(
        "HTTP 403. Cloudflare refused the service token",
      );
    } finally {
      edge.server.close();
    }
  });

  it("explains a tunnel that cannot reach the server", async () => {
    const edge = fakeEdge(502);
    try {
      await expect(tunnelSocket({ host: edge.url(), ...TOKEN })()).rejects.toThrow(
        "could not reach the database server",
      );
    } finally {
      edge.server.close();
    }
  });
});

describe("viaTunnel", () => {
  const options = { host: "db.example.test", ...TOKEN };

  it("drops host and port and adds the socket", () => {
    const config = viaTunnel({ host: "1.2.3.4", port: 5432, database: "app", max: 10 }, options);
    expect(config).not.toHaveProperty("host");
    expect(config).not.toHaveProperty("port");
    expect(config).toMatchObject({ database: "app", max: 10 });
    expect(typeof (config as { socket?: unknown }).socket).toBe("function");
  });

  it("switches TLS on when the config leaves it off", () => {
    expect(viaTunnel({ database: "app" }, options)).toHaveProperty("ssl", "require");
    expect(viaTunnel({ ssl: false }, options)).toHaveProperty("ssl", "require");
  });

  it("keeps TLS settings the config already has", () => {
    const ssl = { rejectUnauthorized: false };
    expect(viaTunnel({ ssl }, options)).toHaveProperty("ssl", ssl);
  });
});
