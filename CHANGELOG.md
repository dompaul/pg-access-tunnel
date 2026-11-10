# Changelog

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
