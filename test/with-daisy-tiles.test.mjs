// Tests that need C:\thunderbird-cafe\daisy-tiles beside this folder (skipped where it isn't, e.g. in a
// fresh clone of this repo on its own):
//  - tables.js here is a byte-for-byte copy of daisy-tiles' relay/tables.js;
//  - the same messages through the stand-in relay and through this relay give the same answers;
//  - a whole Daisy match, two real houses (daisy-tiles' referee) talking through this relay, with the relay
//    restarted mid-match, ends the same on both pages and the saved records check out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocket } from 'ws';
import { createRelayServer } from '../server.js';

const HERE = dirname(dirname(fileURLToPath(import.meta.url)));
const TILES = join(HERE, '..', 'daisy-tiles');
const skip = !existsSync(join(TILES, 'relay', 'tables.js')) && 'daisy-tiles is not beside this folder';
const from = (p) => import(pathToFileURL(join(TILES, p)).href);

const A = { did: 'did:plc:rqbqpaaluty5v47jwciowpik', handle: 'pyxorium.com' };
const B = { did: 'did:plc:joer5rzmwgec3dkr4srfmq45', handle: 'thunderbirdwine.bsky.social' };
const C = { did: 'did:plc:ro563p5faldqu44apudq44k4', handle: 'colorado.atprotocol.space' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('tables.js is the same as daisy-tiles\' relay/tables.js (npm run sync copies it)', { skip }, () => {
  assert.ok(Buffer.compare(readFileSync(join(HERE, 'tables.js')), readFileSync(join(TILES, 'relay', 'tables.js'))) === 0,
    'tables.js differs from daisy-tiles: run npm run sync');
});

// Plays a script of [page, message] against a relay and returns what each page received, in order.
async function transcript(url, script) {
  const pages = {};
  const got = {};
  for (const [name] of script) {
    if (pages[name]) continue;
    got[name] = [];
    pages[name] = await new Promise((resolve) => {
      const ws = new WebSocket(url, { origin: 'https://thunderbird.cafe' });
      ws.on('message', (d) => got[name].push(JSON.parse(d.toString())));
      ws.on('open', () => resolve(ws));
    });
  }
  for (const [name, msg] of script) {
    if (msg === 'close') pages[name].close();
    else pages[name].send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    await wait(40);
  }
  const seen = JSON.parse(JSON.stringify(got));           // before the pages close (their order is a race)
  for (const ws of Object.values(pages)) ws.close();
  await wait(40);
  return seen;
}

test('the same messages through the stand-in and through this relay get the same answers', { skip }, async () => {
  const { startRelay } = await from('scripts/relay-standin.mjs');
  const T = 'k7q3m2xw9a';
  const script = [
    ['a', { type: 'join', table: T, seat: 1, ...A, house: 'bafyreihouseversionaaaa' }],
    ['a', { type: 'send', data: { kind: 'commit', seq: 1 } }],
    ['b', { type: 'join', table: T, seat: 'any', ...B, house: 'bafyreihouseversionaaaa' }],
    ['a', { type: 'send', data: { kind: 'commit', seq: 1, matchId: '3my4x2bvovy2r' } }],
    ['b', { type: 'send', data: { kind: 'resend', after: 0 } }],
    ['c', { type: 'join', table: T, seat: 'any', ...C }],
    ['d', { type: 'join', table: T, seat: 'any', ...B, fresh: true }],
    ['a', 'not json'],
    ['a', { type: 'what' }],
    ['e', { type: 'send', data: {} }],
    ['b', 'close'],
    ['f', { type: 'join', table: T, seat: 2, ...B }],
    ['f', { type: 'send', data: { kind: 'die-view', q: [0, 0.7071, 0, 0.7071], z: 6.2 } }],
    ['a', { type: 'join', table: T, seat: 1, ...A }],
  ];
  const standin = await startRelay({ port: 0 });
  const viaStandin = await transcript(`ws://127.0.0.1:${standin.port}/`, script);
  await standin.close();
  const real = createRelayServer({ port: 0, host: '127.0.0.1', log: () => {} });
  const port = await real.listen();
  const viaReal = await transcript(`ws://127.0.0.1:${port}/`, script);
  await real.close();
  assert.deepEqual(viaReal, viaStandin);
  assert.equal(viaReal.c[0].type, 'full');
  assert.equal(viaReal.d[0].type, 'held');
});

test('a whole match through this relay, restarted mid-match: both houses agree and both records check out', { skip, timeout: 60000 }, async () => {
  const { createTable, step, viewOf, resultOf } = await from('house/referee.js');
  const { newTid } = await from('house/tid.js');
  const { recordFor, checkRecord } = await from('page/record.js');
  const ctx = {
    now: () => Date.now(),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
    newId: () => newTid(Date.now()),
  };
  const TABLE = 'm4tchtabl3x';
  let server = createRelayServer({ port: 0, host: '127.0.0.1', log: () => {} });
  const port = await server.listen();
  const url = `ws://127.0.0.1:${port}/`;

  // A page, as src/daisy/table.js does it in short: its house, its connection (coming back by itself),
  // the seats from the relay, and a player who banks once a turn is worth 10.
  function makePage(account, ask) {
    const p = { account, seat: null, house: null, ws: null, live: true, result: null, rolls: 0 };
    const deliver = (msg) => {
      const r = step(p.house, msg, ctx);
      p.house = r.state;
      for (const o of r.out) {
        if (o.to === 'peer' && p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ type: 'send', data: o.msg }));
        if (o.to === 'page' && o.msg.result) p.result = o.msg.result;
      }
    };
    p.deliver = deliver;
    const open = () => {
      if (!p.live) return;
      const ws = new WebSocket(url, { origin: 'https://thunderbird.cafe' });
      p.ws = ws;
      ws.on('open', () => ws.send(JSON.stringify({ type: 'join', table: TABLE, seat: p.seat || ask, ...account })));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        if (m.type === 'joined') {
          p.seat = m.seat;
          if (!p.house) p.house = createTable({ me: m.seat });
          deliver({ from: 'page', kind: 'seated', seat: m.seat, ...account });
          if (m.other) deliver({ from: 'page', kind: 'seated', seat: 3 - m.seat, did: m.other.did, handle: m.other.handle });
          deliver({ from: 'page', kind: 'reconnected' });
        } else if (m.type === 'presence' && p.house) {
          deliver({ from: 'page', kind: 'seated', seat: m.seat, did: m.did, handle: m.handle });
          deliver({ from: 'page', kind: 'presence', seat: m.seat, state: m.state === 'here' ? 'back' : 'gone' });
          if (m.state === 'here') deliver({ from: 'page', kind: 'reconnected' });
        } else if (m.type === 'peer' && p.house) deliver({ ...m.data, from: 'peer' });
      });
      ws.on('close', () => { if (p.live) setTimeout(open, 100); });
      ws.on('error', () => {});
    };
    p.start = open;
    p.play = () => {
      if (!p.house) return;
      const v = viewOf(p.house);
      if (v.canPick) deliver({ from: 'player', kind: 'pick', glaze: v.glazes.find((g) => g.free).id });
      else if (v.canBank && v.turnTotal >= 10) deliver({ from: 'player', kind: 'bank' });
      else if (v.canRoll) { p.rolls++; deliver({ from: 'player', kind: 'roll' }); }
    };
    return p;
  }

  const a = makePage(A, 1), b = makePage(B, 'any');
  a.start();
  await wait(100);
  b.start();
  let restarted = false;
  const until = Date.now() + 50000;
  while (!(a.result && b.result)) {
    if (Date.now() > until) throw new Error(`no result: ${JSON.stringify([viewOf(a.house || createTable({ me: 1 })).phase, b.house && viewOf(b.house).phase])}`);
    a.play(); b.play();
    if (!restarted && a.rolls + b.rolls >= 4) {
      restarted = true;
      await server.close({ crash: true });                 // the relay goes away mid-match…
      await wait(300);
      server = createRelayServer({ port, host: '127.0.0.1', log: () => {} });
      await server.listen();                               // …and comes back empty: both pages rejoin
    }
    await wait(15);
  }
  a.live = false; b.live = false;
  a.ws.close(); b.ws.close();
  await server.close();
  assert.ok(restarted, 'the relay was restarted mid-match');
  assert.equal(JSON.stringify(a.house.shared), JSON.stringify(b.house.shared), 'the two houses disagree');
  assert.deepEqual(a.result, b.result);
  assert.deepEqual(resultOf(a.house), a.result);
  assert.equal(a.result.ending, 'won');
  const house = { uri: 'at://did:plc:6vxjigxrqizmbo56gojxico3/ing.dasl.masl/3my4x242zjl26', cid: 'bafyreihouseversionaaaa' };
  assert.equal(checkRecord(recordFor(a.result, 1, house)), null);
  assert.equal(checkRecord(recordFor(b.result, 2, house)), null);
});
