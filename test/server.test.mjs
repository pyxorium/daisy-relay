// The relay's network layer: health, origins, limits, passing messages, restarts.
// (The seat rules themselves are tested in daisy-tiles, test/relay.test.mjs.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import { createRelayServer } from '../server.js';

const A = { did: 'did:plc:rqbqpaaluty5v47jwciowpik', handle: 'pyxorium.com' };
const B = { did: 'did:plc:joer5rzmwgec3dkr4srfmq45', handle: 'thunderbirdwine.bsky.social' };
const C = { did: 'did:plc:ro563p5faldqu44apudq44k4', handle: 'colorado.atprotocol.space' };
const TABLE = 'k7q3m2xw9a';
const SITE = 'https://thunderbird.cafe';
const quiet = { log: () => {} };

async function start(cfg = {}) {
  const r = createRelayServer({ port: 0, host: '127.0.0.1', allowedOrigins: [SITE, 'http://127.0.0.1:4321'], ...quiet, ...cfg });
  const port = await r.listen();
  return { r, port, url: `ws://127.0.0.1:${port}/` };
}

// A page's connection: opens (or fails with the HTTP status), collects messages, `next()` waits for one.
function page(url, { origin = SITE, headers = {} } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin, headers });
    const inbox = [];
    let wake = null, closed = null;
    ws.on('message', (d) => { inbox.push(JSON.parse(d.toString())); if (wake) { wake(); wake = null; } });
    ws.on('close', (code) => { closed = code; if (wake) { wake(); wake = null; } });
    ws.on('unexpected-response', (req, res) => resolve({ refused: res.statusCode }));
    ws.on('error', () => {});
    ws.on('open', () => resolve({
      ws,
      send: (x) => ws.send(typeof x === 'string' ? x : JSON.stringify(x)),
      async next(ms = 3000) {
        const until = Date.now() + ms;
        while (!inbox.length) {
          if (closed !== null) return { closed };
          if (Date.now() > until) throw new Error('nothing arrived');
          await new Promise((r) => { wake = r; setTimeout(r, 50); });
        }
        return inbox.shift();
      },
      closedWith: () => closed,
    }));
  });
}

test('health and a plain page for the address; other paths not found', async () => {
  const { r, port } = await start();
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`).then(async (res) => [res.status, await res.text()]);
  assert.deepEqual(await get('/health'), [200, 'ok']);
  const [s, text] = await get('/');
  assert.equal(s, 200);
  assert.match(text, /stores nothing/);
  assert.equal((await get('/anything'))[0], 404);
  await r.close();
});

test('pages from the allowed sites get in; other sites are turned away; other paths too', async () => {
  const { r, url } = await start();
  const ok = await page(url);
  assert.ok(ok.ws);
  const local = await page(url, { origin: 'http://127.0.0.1:4321' });
  assert.ok(local.ws);
  assert.equal((await page(url, { origin: 'https://example.com' })).refused, 403);
  assert.equal((await page(url, { origin: 'http://localhost:4321' })).refused, 403);
  assert.equal((await page(url.replace(/\/$/, '/elsewhere'))).refused, 404);
  ok.ws.close(); local.ws.close();
  await r.close();
});

test('a table over the real relay: join, messages both ways, presence, "full", "held", "replaced"', async () => {
  const { r, url } = await start();
  const a = await page(url), b = await page(url), c = await page(url), b2 = await page(url);
  a.send({ type: 'join', table: TABLE, seat: 1, ...A });
  assert.deepEqual(await a.next(), { type: 'joined', table: TABLE, seat: 1, other: null });
  b.send({ type: 'join', table: TABLE, seat: 'any', ...B, house: 'bafyreihouseversionaaaa' });
  assert.deepEqual(await b.next(), { type: 'joined', table: TABLE, seat: 2, other: { ...A, here: true } });
  assert.deepEqual(await a.next(), { type: 'presence', seat: 2, state: 'here', ...B, house: 'bafyreihouseversionaaaa' });
  a.send({ type: 'send', data: { kind: 'commit', seq: 1 } });
  assert.deepEqual(await b.next(), { type: 'peer', data: { kind: 'commit', seq: 1 } });
  b.send({ type: 'send', data: { kind: 'die-view', q: [0, 0, 0, 1], z: 5 } });
  assert.deepEqual(await a.next(), { type: 'peer', data: { kind: 'die-view', q: [0, 0, 0, 1], z: 5 } });
  c.send({ type: 'join', table: TABLE, seat: 'any', ...C });
  assert.deepEqual(await c.next(), { type: 'full' });
  b2.send({ type: 'join', table: TABLE, seat: 'any', ...B, fresh: true });
  assert.deepEqual(await b2.next(), { type: 'held', seat: 2 });
  const b3 = await page(url);
  b3.send({ type: 'join', table: TABLE, seat: 'any', ...B });
  assert.equal((await b3.next()).seat, 2);
  assert.deepEqual(await b.next(), { type: 'replaced' });
  assert.equal((await a.next()).state, 'here');
  b3.ws.close();
  assert.equal((await a.next()).state, 'gone');
  for (const p of [a, b, c, b2]) p.ws.close();
  await r.close();
});

test('refusals: not JSON, not text, too big (answered); a frame far too big closes the connection', async () => {
  const { r, url } = await start();
  const a = await page(url);
  a.send('nonsense');
  assert.equal((await a.next()).why, 'not JSON');
  a.ws.send(Buffer.from([1, 2, 3]), { binary: true });
  assert.equal((await a.next()).why, 'not text');
  a.send({ type: 'join', table: TABLE, seat: 1, ...A });
  assert.equal((await a.next()).type, 'joined');
  a.send({ type: 'send', data: { pad: 'x'.repeat(70 * 1024) } });
  assert.equal((await a.next()).why, 'too big');
  a.send('x'.repeat(300 * 1024));                       // over the frame limit: ws closes it (1009)
  assert.deepEqual(await a.next(), { closed: 1009 });
  await r.close();
});

test('a connection that never sits at a table is closed; one that keeps making mistakes is closed', async () => {
  const { r, url } = await start({ joinWithinMs: 200, maxErrors: 5 });
  const idle = await page(url);
  assert.deepEqual(await idle.next(), { closed: 1008 });
  const noisy = await page(url);
  noisy.send({ type: 'join', table: TABLE, seat: 1, ...A });
  assert.equal((await noisy.next()).type, 'joined');
  for (let i = 0; i < 4; i++) { noisy.send('?'); assert.equal((await noisy.next()).why, 'not JSON'); }
  noisy.send('?');
  assert.deepEqual(await noisy.next(), { closed: 1008 });
  await r.close();
});

test('limits: connections per address (Fly\'s fly-client-ip), and in all', async () => {
  const { r, url } = await start({ maxPerIp: 2, maxConnections: 3 });
  const home = { headers: { 'fly-client-ip': '203.0.113.7' } };
  const p1 = await page(url, home), p2 = await page(url, home);
  assert.ok(p1.ws && p2.ws);
  assert.equal((await page(url, home)).refused, 429);
  const other = await page(url, { headers: { 'fly-client-ip': '198.51.100.2' } });
  assert.ok(other.ws);
  assert.equal((await page(url, { headers: { 'fly-client-ip': '198.51.100.3' } })).refused, 503);
  p1.ws.close();
  await new Promise((res) => setTimeout(res, 100));
  const p3 = await page(url, home);
  assert.ok(p3.ws, 'a closed connection frees its place');
  for (const p of [p2, other, p3]) p.ws.close();
  await r.close();
});

test('a dead connection (no answer to the heartbeat) is dropped, and the other page hears "gone"', async () => {
  const { r, url } = await start({ heartbeatMs: 150 });
  const a = await page(url), b = await page(url);
  a.send({ type: 'join', table: TABLE, seat: 1, ...A });
  await a.next();
  b.send({ type: 'join', table: TABLE, seat: 'any', ...B });
  await b.next();
  assert.equal((await a.next()).state, 'here');
  b.ws.pong = () => {};                                   // b stops answering pings, as a phone out of signal
  b.ws._receiver.removeAllListeners('ping');
  b.ws._socket.pause();                                    // …and reads nothing more
  assert.equal((await a.next(2000)).state, 'gone');
  a.ws.close(); b.ws.terminate();
  await r.close();
});

test('stopping (a deploy, a sleep) tells each page 1012; a new relay takes them back at their seats', async () => {
  const first = await start();
  const a = await page(first.url), b = await page(first.url);
  a.send({ type: 'join', table: TABLE, seat: 1, ...A }); await a.next();
  b.send({ type: 'join', table: TABLE, seat: 'any', ...B }); await b.next(); await a.next();
  await first.r.close();
  assert.deepEqual(await a.next(), { closed: 1012 });
  assert.deepEqual(await b.next(), { closed: 1012 });
  const again = await start({ port: first.port });
  const a2 = await page(again.url), b2 = await page(again.url);
  b2.send({ type: 'join', table: TABLE, seat: 2, ...B });
  assert.equal((await b2.next()).seat, 2);
  a2.send({ type: 'join', table: TABLE, seat: 1, ...A });
  assert.equal((await a2.next()).other.did, B.did);
  a2.ws.close(); b2.ws.close();
  await again.r.close();
});

test('the Fly files: one region, sleeps when idle but counts connections, health check, both origins, the Dockerfile ships tables.js', () => {
  const toml = readFileSync(new URL('../fly.toml', import.meta.url), 'utf8');
  assert.match(toml, /^app = 'thunderbird-daisy-relay'$/m);
  assert.match(toml, /^primary_region = 'sjc'$/m);
  assert.match(toml, /auto_stop_machines = 'stop'/);
  assert.match(toml, /min_machines_running = 0/);
  assert.match(toml, /type = 'connections'/);
  assert.match(toml, /path = '\/health'/);
  assert.match(toml, /ALLOWED_ORIGINS = 'https:\/\/thunderbird\.cafe,http:\/\/127\.0\.0\.1:4321'/);
  assert.match(toml, /fly deploy --ha=false/);
  const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(docker, /COPY server\.js tables\.js \.\//);
  assert.match(docker, /npm ci --omit=dev/);
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
  assert.deepEqual(Object.keys(lock.packages), ['', 'node_modules/ws']);
});
