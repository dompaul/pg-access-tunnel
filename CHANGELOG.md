# Changelog

## 1.1.0

- A connection the tunnel closes now closes for postgres.js too. ws's stream
  only ended its readable side, which under postgres.js's TLS socket never
  became a "close", so postgres.js kept the dead connection in its pool: the
  query in flight hung for ever, and the next one failed with "WebSocket is
  not open: readyState 3 (CLOSED)". On Vercel this showed as pages timing out
  at build and as functions timing out at 15 seconds. The query in flight now
  fails straight away, naming the WebSocket close code, and the next query
  opens a fresh connection.
- A connection that stops answering is closed instead of left to hang. Each
  open connection pings the tunnel every 5 seconds and closes if a ping goes
  unanswered for 5 seconds, so a dead connection fails its query within about
  10 seconds. A timer that fires late, because the process was frozen between
  requests or busy, asks again instead of closing a connection that may be
  fine.
- New option `heartbeatMs` sets both intervals. The old 30-second keep-alive
  ping is replaced by this one.

## 1.0.1

- Works in apps built with webpack, which is how Next.js builds unless told to
  use Turbopack. Webpack swapped ws's optional native helpers for empty
  modules, so the first larger frame threw "mask is not a function" and the
  connection timed out. ws is now loaded on first connection, with those
  helpers switched off, and uses its own JavaScript versions.

## 1.0.0

First release.

- `viaTunnel` wraps a postgres.js config so every connection goes through the
  tunnel, with `host` and `port` dropped and TLS switched on.
- `tunnelSocket` gives the postgres.js `socket` option on its own.
- Settings come from `DB_TUNNEL_HOST`, `CF_ACCESS_CLIENT_ID` and
  `CF_ACCESS_CLIENT_SECRET`, and a missing one throws, naming it.
- Clear errors for a refused service token and an unreachable server.
- An idle connection is pinged every 30 seconds so it is not dropped.
