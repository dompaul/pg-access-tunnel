// Read-only check against the real database through the tunnel.
//
//   node --env-file=.env scripts/live-check.mjs
//
// Needs DB_TUNNEL_HOST, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET and the
// usual PGDATABASE, PGUSERNAME, PGPASSWORD. Run `npm run build` first.
import postgres from "postgres";
import { viaTunnel } from "../dist/index.js";

const sql = postgres(
  viaTunnel({
    database: process.env.PGDATABASE,
    username: process.env.PGUSERNAME,
    password: process.env.PGPASSWORD,
    max: 1,
  }),
);

try {
  const started = Date.now();
  const [row] = await sql`
    select current_user as user,
           inet_client_addr()::text as seen_from,
           (select ssl from pg_stat_ssl where pid = pg_backend_pid()) as encrypted`;
  console.log({ ...row, ms: Date.now() - started });
} finally {
  await sql.end();
}
