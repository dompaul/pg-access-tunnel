# Changelog

## 1.0.0

First release.

- `viaTunnel` wraps a postgres.js config so every connection goes through the
  tunnel, with `host` and `port` dropped and TLS switched on.
- `tunnelSocket` gives the postgres.js `socket` option on its own.
- Settings come from `DB_TUNNEL_HOST`, `CF_ACCESS_CLIENT_ID` and
  `CF_ACCESS_CLIENT_SECRET`, and a missing one throws, naming it.
- Clear errors for a refused service token and an unreachable server.
- An idle connection is pinged every 30 seconds so it is not dropped.
