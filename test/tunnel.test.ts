import type { AddressInfo } from "node:net";
import { WebSocketServer } from "ws";
import { tunnelSocket, viaTunnel } from "../src/index";

const TOKEN = { clientId: "id.access", clientSecret: "secret" };

// Stands in for Cloudflare: checks the service token, then echoes bytes back.
function fakeEdge(status?: number) {
  const seen: Record<string, string | undefined> = {};
  const server = new WebSocketServer({
    port: 0,
    verifyClient: (info, done) => {
      seen.id = info.req.headers["cf-access-client-id"] as string | undefined;
      seen.secret = info.req.headers["cf-access-client-secret"] as string | undefined;
      status ? done(false, status) : done(true);
    },
  });
  server.on("connection", (ws) => ws.on("message", (data) => ws.send(data)));
  const url = () => `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, seen, url };
}

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
      expect((stream as unknown as { readyState: string }).readyState).toBe("open");

      const reply = new Promise<Buffer>((r) => stream.once("data", r));
      stream.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));
      expect([...(await reply)]).toEqual([0, 0, 0, 8, 4, 210, 22, 47]);

      const closed = new Promise((r) => stream.once("close", r));
      stream.end();
      await closed;
      expect((stream as unknown as { readyState: string }).readyState).toBe("closed");
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
