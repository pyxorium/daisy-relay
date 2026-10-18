# Daisy relay

The relay for **Daisy**, the two-computer dice game at https://thunderbird.cafe/webtiles/daisy/ (build
step 5). It runs on Fly.io as its own small app, `thunderbird-daisy-relay` ("daisy-relay" was taken), at **`wss://relay.daisy.thunderbird.cafe/`**.

It **passes messages and stores nothing**: no match, no move, no record, nothing on disk. While it runs, it
knows which account sits at which seat of which table, so it can pass each page's messages to the other
seat and tell each page when the other one comes or goes. The dice come from both players' pages together
(commit and reveal), and each page runs its own copy of the referee, so the relay can't choose a roll or
change a result. A restart (a deploy, or the machine sleeping) costs a reconnect, never the match: both
pages keep everything and ask each other for what they missed.

## Files

- `tables.js`: the relay's rules (seats, passing messages, presence, the house version passed on, limits).
  **A byte-for-byte copy of `C:\thunderbird-cafe\daisy-tiles\relay\tables.js`**, the one source, also run
  by the stand-in relay there. Don't edit it here: change it in daisy-tiles, then `npm run sync`.
- `server.js`: the network around it, with the `ws` package: `GET /health`, the origin check, limits
  (connections in all and per address, frame size, joining within 30 s, too many mistakes), a heartbeat
  that finds dead connections, and a clean stop (each page hears 1012 and reconnects at once).
- `fly.toml`, `Dockerfile`, `.dockerignore`: the Fly app (modelled on the die-relay app).
- `scripts/sync-tables.mjs`: `npm run sync` copies tables.js from daisy-tiles; `--check` only compares.
- `test/`: `server.test.mjs` (the network layer) and `with-daisy-tiles.test.mjs` (needs daisy-tiles beside
  this folder: the copy matches; the stand-in and this relay answer a script of messages identically; a
  whole match between two real referees through this relay, restarted mid-match, both records check out).

## Run the tests

```
npm ci
npm test
```

12 tests, a few seconds. Needs Node 22 or later.

## Settings

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | Listen port |
| `ALLOWED_ORIGINS` | `https://thunderbird.cafe` | Pages allowed to connect, comma-separated (`*` for any). In `fly.toml`: thunderbird.cafe and, during step 5, `http://127.0.0.1:4321` (take it off before going public). A client that isn't a browser sends no origin and is let in: the check is a courtesy, not a lock. |
| `MAX_CONNECTIONS` | 1000 | Connections in all |
| `MAX_PER_IP` | 20 | Connections per address (Fly's `fly-client-ip` header) |

The other limits are `DEFAULTS` in `server.js` and `LIMITS` in `tables.js` (64 KB a message; 80 at once, then
40 a second per connection; tables nobody has been at for 6 hours are forgotten).

**Logs:** a startup line, and now and then a counts line (`tables 1, connections 2`). Never messages,
table ids, accounts or addresses.

## Deploying

**Always exactly one machine.** The tables live in one process's memory; with two machines, a table's two
pages could land on different machines and never meet.

```
fly deploy --ha=false
fly status
```

`fly status` must list **one** machine. If it lists two: `fly scale count 1`.

The machine **sleeps when nobody is connected** (`auto_stop_machines = 'stop'`, `min_machines_running = 0`).
Fly counts open WebSockets as connections, so a game in progress keeps it awake; the first page after a
sleep waits a few seconds while it starts (the page keeps retrying). To keep it always on (later, for the
lounge): `min_machines_running = 1`, then deploy.

**The address:** `relay.daisy.thunderbird.cafe`, DNS at Wix (an A record and an AAAA record to the app's
addresses from `fly ips list`) and a Fly certificate (`fly certs add relay.daisy.thunderbird.cafe`).

**Roll back:** `git revert HEAD`, then `fly deploy --ha=false`.

## Checking it live

- `https://relay.daisy.thunderbird.cafe/health` shows `ok`.
- `fly logs` shows the startup line and counts.
- From the local dev page: `http://127.0.0.1:4321/webtiles/daisy/?relay=wss://relay.daisy.thunderbird.cafe/`
  (the table link carries it to the second window).
