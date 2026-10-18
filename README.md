# Daisy relay

The relay for **Daisy**, the two-computer dice game at https://thunderbird.cafe/webtiles/daisy/ (build
step 5). It runs on Fly.io as its own small app, `thunderbird-daisy-relay` ("daisy-relay" was taken), at **`wss://relay.daisy.thunderbird.cafe/`**.

It **passes messages and stores nothing**: no match, no move, no record, nothing on disk. While it runs, it
knows which account sits at which seat of which table, so it can pass each page's messages to the other
seat and tell each page when the other one comes or goes. The dice come from both players' pages together
(commit and reveal), and each page runs its own copy of the referee, so the relay can't choose a roll or
change a result. A restart (a deploy, or the machine sleeping) costs a reconnect, never the match: both
pages keep everything and ask each other for what they missed.

## Step 6: the relay's identity and lounge passes

The lounge (build step 6) needs to know who a player is. The relay has its own identity,
**`did:web:relay.daisy.thunderbird.cafe`** (its DID document at `/.well-known/did.json`, with one service,
`#daisy_relay`). A player who turns mingling on agrees, when signing in, to the permission
`rpc:cafe.thunderbird.daisy.lounge.enter?aud=did:web:relay.daisy.thunderbird.cafe%23daisy_relay`; the page
then asks the player's own server for a **pass** (`com.atproto.server.getServiceAuth`), a short token signed
with the account's key and addressed to this relay, and the relay checks it.

- `lounge-auth.js`: the identity, and `createPassChecker`: Bluesky's `verifyJwt` (format, expiry, audience,
  method, signature, a second key lookup in case of a rotated key), plus: only accounts (did:plc, did:web;
  not a service or a bare did:key), passes lasting at most 5 minutes, each pass used once.
- `atproto-pass.js`: wired to `@atproto/xrpc-server` (`verifyJwt`) and `@atproto/identity` (account keys from
  plc.directory or the account's own domain, cached an hour).
- **For now the check answers only the probe:** `POST /lounge/probe` with `Authorization: Bearer <pass>`
  says whose pass it is, or why not (20 a minute per address; the allowed pages only). The throwaway probe
  page (`/webtiles/daisy-probe/` in the site, at `http://127.0.0.1:4322`, never committed) uses it.

## Files

- `tables.js`: the relay's rules (seats, passing messages, presence, the house version passed on, limits).
  **A byte-for-byte copy of `C:\thunderbird-cafe\daisy-tiles\relay\tables.js`**, the one source, also run
  by the stand-in relay there. Don't edit it here: change it in daisy-tiles, then `npm run sync`.
- `server.js`: the network around it, with the `ws` package: `GET /health`, the origin check, limits
  (connections in all and per address, frame size, joining within 30 s, too many mistakes), a heartbeat
  that finds dead connections, and a clean stop (each page hears 1012 and reconnects at once).
- `lounge-auth.js`, `atproto-pass.js`: the relay's identity and the lounge pass check (step 6, above).
- `fly.toml`, `Dockerfile`, `.dockerignore`: the Fly app (modelled on the die-relay app).
- `scripts/sync-tables.mjs`: `npm run sync` copies tables.js from daisy-tiles; `--check` only compares.
- `test/`: `lounge-auth.test.mjs` (the pass check with Bluesky's real code: passes signed by real
  keypairs, accepted and refused), `server.test.mjs` (the network layer, the DID document, the probe) and `with-daisy-tiles.test.mjs` (needs daisy-tiles beside
  this folder: the copy matches; the stand-in and this relay answer a script of messages identically; a
  whole match between two real referees through this relay, restarted mid-match, both records check out).

## Run the tests

```
npm install
npm test
```

21 tests, a few seconds. Needs Node 22 or later. (`npm install` the first time after step 6 added the
@atproto packages; it updates `package-lock.json`, which goes into the commit. After that, `npm ci`.)

## Settings

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | 8080 | Listen port |
| `ALLOWED_ORIGINS` | `https://thunderbird.cafe` | Pages allowed to connect, comma-separated (`*` for any). In `fly.toml`: thunderbird.cafe and, while building, `http://127.0.0.1:4321` (the dev page) and `http://127.0.0.1:4322` (step 6's probe); take both off before going public. A client that isn't a browser sends no origin and is let in: the check is a courtesy, not a lock. |
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
