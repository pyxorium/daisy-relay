// Daisy's relay on Fly.io (build step 5): the network around tables.js.
//
// tables.js holds the relay's rules (seats per table, passing messages, presence) and is a byte-for-byte
// copy of C:\thunderbird-cafe\daisy-tiles\relay\tables.js (`npm run sync` copies it, and a test checks
// the copy). This file only does the WebSockets, with the `ws` package, and the limits that matter on the
// open internet. The stand-in in daisy-tiles (scripts/relay-standin.mjs) runs the same rules on this
// computer.
//
// The relay passes messages and stores nothing: no match, no move, no record, nothing on disk. While it
// runs it knows which account sits at which seat of which table. A restart (a deploy, or the machine
// sleeping when nobody is connected) costs a reconnect, never the match: both pages keep everything.
//
// It never logs messages, table ids or accounts: only a startup line and, now and then, counts.
//
// Step 6 (the lounge) adds the relay's own identity, did:web:relay.daisy.thunderbird.cafe (its DID document
// at /.well-known/did.json), and a check on players' lounge passes (lounge-auth.js, atproto-pass.js). For
// now the check answers only the probe, POST /lounge/probe: it says whether a pass is good and whose it is,
// and remembers nothing but the pass's id until it expires.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { createRelay, LIMITS } from './tables.js';
import { didDocument, RELAY_HOST } from './lounge-auth.js';

export const DEFAULTS = Object.freeze({
  port: 8080,
  host: '0.0.0.0',
  // Pages from other sites are turned away. Browsers always send Origin with a WebSocket; a client that
  // isn't a browser sends none and is let in (an origin check is a courtesy, not a lock).
  allowedOrigins: ['https://thunderbird.cafe'],
  maxConnections: 1000,
  maxPerIp: 20,                       // a page opens one connection; a household shares one address
  // A frame bigger than this is refused by `ws` before it's read. tables.js answers anything over 64 KB
  // (in characters) with "too big"; this leaves room for multi-byte characters up to that.
  maxFrameBytes: 4 * LIMITS.maxBytes,
  joinWithinMs: 30_000,               // a connection must sit at a table this soon
  maxErrors: 50,                      // errors answered on one connection before it's closed
  heartbeatMs: 30_000,                // ping each connection; one that doesn't answer is dropped
  sweepMs: 60_000,                    // forget tables nobody has been at for 6 hours (tables.js)
  maxBufferedBytes: 4 * 1024 * 1024,  // a page this far behind is dropped (it reconnects and catches up)
  statsMs: 60 * 60_000,               // a counts line in the log, at most this often, only when busy
  publicHost: RELAY_HOST,             // the relay's own name: its identity is did:web:<publicHost>
  probePerMinute: 20,                 // lounge pass checks per address per minute (step 6's probe)
});

const originAllowed = (cfg, origin) => cfg.allowedOrigins.includes('*') || cfg.allowedOrigins.includes(origin);

export function createRelayServer(userConfig = {}) {
  const cfg = { ...DEFAULTS, ...userConfig };
  const relay = createRelay(cfg.now ? { now: cfg.now } : {});
  const conns = new Map();          // ws → { ip, joined, errors, alive, joinTimer }
  const perIp = new Map();
  const timers = [];
  const log = cfg.log || ((line) => console.log(line));

  // The lounge pass check (step 6): Bluesky's packages, loaded the first time a pass arrives, or one
  // handed in (the tests). Without the packages the probe answers "not ready" and the rest runs as before.
  let passChecker = cfg.checkPass ? Promise.resolve(cfg.checkPass) : null;
  const getPassChecker = () => (passChecker ||= import('./atproto-pass.js').then((m) => m.atprotoPassChecker()).catch(() => { passChecker = null; return null; }));
  const probeUse = new Map();         // address → { n, since }

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(JSON.stringify(body));
  };
  // Pages from the allowed sites may call the probe from the browser (CORS); others get no permission.
  const corsFor = (origin) => (origin && originAllowed(cfg, origin)
    ? { 'access-control-allow-origin': origin, vary: 'Origin' } : {});

  async function probe(req, res) {
    const origin = req.headers.origin;
    const cors = corsFor(origin);
    if (origin !== undefined && !cors['access-control-allow-origin']) return json(res, 403, { ok: false, error: 'Forbidden', message: 'pages from this site may not use the relay' });
    const ip = clientIp(req), t = Date.now();
    const u = probeUse.get(ip);
    if (!u || t - u.since > 60_000) probeUse.set(ip, { n: 1, since: t });
    else if (++u.n > cfg.probePerMinute) return json(res, 429, { ok: false, error: 'TooMany', message: 'too many passes from this address; wait a minute' }, cors);
    if (probeUse.size > 10_000) probeUse.clear();
    const m = /^Bearer ([A-Za-z0-9_.=-]+)$/.exec(String(req.headers.authorization || ''));
    if (!m) return json(res, 401, { ok: false, error: 'NoPass', message: 'send the pass as Authorization: Bearer <pass>' }, cors);
    const check = await getPassChecker();
    if (!check) return json(res, 503, { ok: false, error: 'NotReady', message: 'the relay cannot check passes (its atproto packages are missing)' }, cors);
    try {
      const { did, exp } = await check(m[1]);
      return json(res, 200, { ok: true, did, expiresAt: new Date(exp * 1000).toISOString() }, cors);
    } catch (err) {
      return json(res, 401, { ok: false, error: err.code || 'BadPass', message: String(err.message || err) }, cors);
    }
  }

  const server = http.createServer((req, res) => {
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && path === '/.well-known/did.json') {
      return json(res, 200, didDocument(cfg.publicHost), { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
    }
    if (path === '/lounge/probe') {
      if (req.method === 'OPTIONS') {
        const cors = corsFor(req.headers.origin);
        res.writeHead(cors['access-control-allow-origin'] ? 204 : 403, {
          ...cors, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'authorization', 'access-control-max-age': '600',
        });
        return res.end();
      }
      if (req.method === 'POST') {
        req.resume();                   // the pass is in the header; any body is ignored
        probe(req, res).catch(() => { if (!res.headersSent) json(res, 500, { ok: false, error: 'Internal' }); });
        return;
      }
    }
    if (req.method === 'GET' && (path === '/health' || path === '/healthz')) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('ok');
      return;
    }
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end("Daisy's relay: it passes messages between the two pages at a table and stores nothing.\nPlay at https://thunderbird.cafe/webtiles/daisy/\n");
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  // Compression off: nothing to unpack, so no compression bombs, and less work.
  const wss = new WebSocketServer({ noServer: true, maxPayload: cfg.maxFrameBytes, perMessageDeflate: false });
  const clientIp = (req) => String(req.headers['fly-client-ip'] || req.socket.remoteAddress || 'unknown');

  server.on('upgrade', (req, socket, head) => {
    const refuse = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    const path = (req.url || '').split('?')[0];
    if (path !== '/') return refuse(404, 'Not Found');
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(cfg, origin)) return refuse(403, 'Forbidden');
    if (conns.size >= cfg.maxConnections) return refuse(503, 'Service Unavailable');
    const ip = clientIp(req);
    if ((perIp.get(ip) || 0) >= cfg.maxPerIp) return refuse(429, 'Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => onOpen(ws, ip));
  });

  function deliver(out) {
    for (const { conn, msg } of out) {
      const c = conns.get(conn);
      if (!c || conn.readyState !== WebSocket.OPEN) continue;
      if (msg.type === 'joined') { c.joined = true; clearTimeout(c.joinTimer); }
      if (msg.type === 'replaced') c.joined = false;
      if (msg.type === 'error' && ++c.errors >= cfg.maxErrors) { conn.close(1008, 'too many errors'); continue; }
      if (conn.bufferedAmount > cfg.maxBufferedBytes) { conn.terminate(); continue; }
      conn.send(JSON.stringify(msg));
    }
  }

  function onOpen(ws, ip) {
    perIp.set(ip, (perIp.get(ip) || 0) + 1);
    const c = { ip, joined: false, errors: 0, alive: true, joinTimer: null };
    conns.set(ws, c);
    relay.open(ws);
    c.joinTimer = setTimeout(() => { if (!c.joined) ws.close(1008, 'join a table first'); }, cfg.joinWithinMs);
    ws.on('pong', () => { c.alive = true; });
    ws.on('message', (data, isBinary) => {
      c.alive = true;
      if (isBinary) return deliver([{ conn: ws, msg: { type: 'error', why: 'not text' } }]);
      deliver(relay.receive(ws, data.toString('utf8')));
    });
    ws.on('close', () => onClose(ws, c));
    ws.on('error', () => { /* a close always follows */ });
  }

  function onClose(ws, c) {
    if (!conns.delete(ws)) return;
    clearTimeout(c.joinTimer);
    const n = (perIp.get(c.ip) || 1) - 1;
    if (n <= 0) perIp.delete(c.ip); else perIp.set(c.ip, n);
    deliver(relay.close(ws));
  }

  // Dead connections (a phone that lost its signal, a laptop shut) are found by the heartbeat; the other
  // page then hears "gone" and its away countdown starts.
  timers.push(setInterval(() => {
    for (const [ws, c] of conns) {
      if (!c.alive) { ws.terminate(); continue; }
      c.alive = false;
      try { ws.ping(); } catch { /* closing anyway */ }
    }
  }, cfg.heartbeatMs));
  timers.push(setInterval(() => relay.sweep(), cfg.sweepMs));
  let lastStats = '';
  timers.push(setInterval(() => {
    const s = relay.stats();
    const line = `tables ${s.tables}, connections ${s.connections}`;
    if (line !== lastStats && (s.tables || s.connections || lastStats)) log(line);
    lastStats = s.tables || s.connections ? line : '';
  }, cfg.statsMs));
  timers.forEach((t) => t.unref());

  return {
    server, cfg,
    stats: () => relay.stats(),
    listen: () => new Promise((resolve) => server.listen(cfg.port, cfg.host, () => resolve(server.address().port))),
    // Stop: tell every page the relay is going away (1012, "service restart"), so they reconnect at once.
    close: ({ crash = false } = {}) => new Promise((resolve) => {
      timers.forEach(clearInterval);
      for (const ws of conns.keys()) { if (crash) ws.terminate(); else ws.close(1012, 'restarting'); }
      wss.close();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

// ---- Run as a program: `node server.js` (Fly runs it this way) ----
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const env = process.env;
  const cfg = {};
  if (env.PORT) cfg.port = Number(env.PORT);
  if (env.HOST) cfg.host = env.HOST;
  if (env.ALLOWED_ORIGINS) cfg.allowedOrigins = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  if (env.MAX_CONNECTIONS) cfg.maxConnections = Number(env.MAX_CONNECTIONS);
  if (env.MAX_PER_IP) cfg.maxPerIp = Number(env.MAX_PER_IP);
  const r = createRelayServer(cfg);
  const port = await r.listen();
  console.log(`Daisy relay listening on :${port}; pages allowed from ${r.cfg.allowedOrigins.join(', ')}`);
  const stop = async () => { await r.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
