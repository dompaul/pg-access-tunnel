# pg-access-tunnel

Opens [postgres.js](https://github.com/porsager/postgres) connections through a
Cloudflare Tunnel that is protected by a Cloudflare Access service token, so
the database never needs a port open to the internet.

- The database server makes an outbound connection to Cloudflare, so its
  Postgres port can stay closed.
- Cloudflare only lets a connection through when it carries the service token.
- Postgres TLS runs inside the tunnel, so Cloudflare only carries encrypted
  bytes.
- A missing setting throws straight away, naming what is missing, so an app
  that has not been set up fails its build instead of connecting another way.

## How a connection travels

```
app ──wss + service token──▶ Cloudflare Access ──tunnel──▶ cloudflared ──▶ Postgres
```

## Use

Wrap the existing postgres.js config with `viaTunnel`.

```ts
import postgres from "postgres";
import { viaTunnel } from "pg-access-tunnel";

const sql = postgres(
  viaTunnel({
    database: process.env.PGDATABASE,
    username: process.env.PGUSERNAME,
    password: process.env.PGPASSWORD,
    ssl: { rejectUnauthorized: false },
  }),
);
```

`viaTunnel` drops `host` and `port`, because the tunnel decides where to
connect, and switches TLS on if the config leaves it off. `tunnelSocket()`
returns the postgres.js `socket` option on its own.

## Settings

| Variable | What it is |
| --- | --- |
| `DB_TUNNEL_HOST` | The tunnel's public hostname |
| `CF_ACCESS_CLIENT_ID` | Client ID of the Access service token |
| `CF_ACCESS_CLIENT_SECRET` | Client secret of the Access service token |

## Errors

| Message | Meaning |
| --- | --- |
| `... not set` | A setting is missing from the environment |
| `HTTP 401` or `HTTP 403` | Cloudflare refused the service token |
| `HTTP 502` or `HTTP 530` | Cloudflare could not reach the database server |

## Limits

- Node.js runtime only. Edge runtimes cannot open the WebSocket this needs.
- postgres.js only.

## Developing

```bash
npm install
npm run check        # typecheck, tests, build
```

`dist` is committed, because apps install straight from GitHub.

`scripts/live-check.mjs` runs a read-only query through a real tunnel, with the
settings above plus `PGDATABASE`, `PGUSERNAME` and `PGPASSWORD` in the
environment.
