// The lounge (step 6): lounge.js on its own (a stand-in clock and lookups), the lookups in
// atproto-lounge.js (a stand-in network), and the whole thing over real WebSockets in server.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createLounge, LOUNGE_LIMITS } from '../lounge.js';
import { atprotoLounge } from '../atproto-lounge.js';
import { createRelayServer } from '../server.js';

const A = 'did:plc:rqbqpaaluty5v47jwciowpik';
const B = 'did:plc:joer5rzmwgec3dkr4srfmq45';
const C = 'did:plc:ro563p5faldqu44apudq44k4';
const D = 'did:plc:hd2efebmfhpqcusfya4lguce';

// A lounge with stand-ins: a pass is "pass:<did>"; records and blocks as given.
function makeLounge({ records = [A, B, C, D], blocks = [], failBlocks = false } = {}) {
  let t = Date.UTC(2026, 9, 18, 18), n = 0, tables = 0;
  const lounge = createLounge({
    checkPass: async (p) => { if (typeof p === 'string' && p.startsWith('pass:')) return { did: p.slice(5) }; throw Object.assign(new Error('bad'), { code: 'BadJwtSignature' }); },
    hasLoungeRecord: async (did) => records.includes(did),
    hiddenFrom: async (did, others) => {
      if (failBlocks) throw new Error('down');
      return new Set(others.filter((o) => blocks.some(([x, y]) => (x === did && y === o) || (x === o && y === did))));
    },
    newTableId: () => `table${String(++tables).padStart(5, '0')}`,
    newId: () => `knock${++n}`,
    now: () => t,
    random: () => 0.5,
  });
  const pages = {};
  const page = (name) => {
    const conn = { name };
    lounge.open(conn);
    pages[name] = conn;
    return conn;
  };
  const say = async (conn, msg) => lounge.receive(conn, JSON.stringify(msg));
  const to = (out, conn) => out.filter((o) => o.conn === conn && o.msg).map((o) => o.msg);
  return { lounge, page, say, to, tick: (ms) => { t += ms; }, now: () => t };
}

test('entering: a good pass and a lounge record; refused without either; one place per account', async () => {
  const L = makeLounge({ records: [A, B] });
  const a = L.page('a'), c = L.page('c'), x = L.page('x'), a2 = L.page('a2');
  assert.deepEqual(L.to(await L.say(a, { type: 'enter', pass: `pass:${A}` }), a), [{ type: 'in', did: A }]);
  assert.deepEqual(L.to(await L.say(x, { type: 'enter', pass: 'forged' }), x), [{ type: 'refused', why: 'BadJwtSignature' }]);
  assert.deepEqual(L.to(await L.say(c, { type: 'enter', pass: `pass:${C}` }), c), [{ type: 'refused', why: 'NoLoungeRecord' }]);
  assert.equal(L.to(await L.say(c, { type: 'who' }), c)[0].why, 'enter first');
  const out = await L.say(a2, { type: 'enter', pass: `pass:${A}` });            // the same account elsewhere
  assert.deepEqual(L.to(out, a), [{ type: 'replaced' }]);
  assert.ok(out.some((o) => o.conn === a && o.close));
  assert.deepEqual(L.to(out, a2), [{ type: 'in', did: A }]);
  assert.equal(L.lounge.stats().here, 1);
});

test('who else is here: only those here, never yourself, blocks either way hidden, at most every 5 s', async () => {
  const L = makeLounge({ blocks: [[A, C]] });                                   // A blocks C
  const a = L.page('a'), b = L.page('b'), c = L.page('c');
  for (const [p, d] of [[a, A], [b, B], [c, C]]) await L.say(p, { type: 'enter', pass: `pass:${d}` });
  let got = L.to(await L.say(a, { type: 'who' }), a)[0];
  assert.equal(got.type, 'people');
  assert.deepEqual(got.people, [B]);                                            // not A itself, not C (blocked)
  assert.equal(L.to(await L.say(a, { type: 'who' }), a)[0].why, 'too soon');
  got = L.to(await L.say(c, { type: 'who' }), c)[0];
  assert.deepEqual(got.people, [B], 'the blocked one doesn\'t see the blocker either');
  L.tick(6000);
  L.lounge.close(b);
  assert.deepEqual(L.to(await L.say(a, { type: 'who' }), a)[0].people, [], 'left: gone from the list');
});

test('if the block check fails, nobody is listed', async () => {
  const L = makeLounge({ failBlocks: true });
  const a = L.page('a'), b = L.page('b');
  await L.say(a, { type: 'enter', pass: `pass:${A}` });
  await L.say(b, { type: 'enter', pass: `pass:${B}` });
  assert.deepEqual(L.to(await L.say(a, { type: 'who' }), a)[0], { type: 'people', at: new Date(L.now()).toISOString(), people: [], problem: 'blocks' });
});

test('an invitation: knock, Play → both get the same new table; the inviter only ever hears "invited"', async () => {
  const L = makeLounge();
  const a = L.page('a'), b = L.page('b');
  await L.say(a, { type: 'enter', pass: `pass:${A}` });
  await L.say(b, { type: 'enter', pass: `pass:${B}` });
  const out = await L.say(a, { type: 'invite', did: B });
  assert.deepEqual(L.to(out, a), [{ type: 'invited', did: B }]);
  const knock = L.to(out, b)[0];
  assert.equal(knock.type, 'knock');
  assert.equal(knock.from, A);
  assert.equal(knock.expiresAt, new Date(L.now() + 60_000).toISOString());
  const yes = await L.say(b, { type: 'answer', id: knock.id, play: true });
  assert.deepEqual(L.to(yes, a), [{ type: 'table', table: 'table00001', seat: 1, with: B }]);
  assert.deepEqual(L.to(yes, b), [{ type: 'table', table: 'table00001', seat: 2, with: A }]);
  assert.deepEqual(L.to(await L.say(b, { type: 'answer', id: knock.id, play: true }), b), [{ type: 'knock-gone', id: knock.id }], 'once only');
});

test('Not now sends nothing back; an invitation runs out after a minute; nothing reaches someone away, blocked or already asked', async () => {
  const L = makeLounge({ blocks: [[C, A]] });                                   // C blocks A
  const a = L.page('a'), b = L.page('b'), c = L.page('c'), d = L.page('d');
  for (const [p, x] of [[a, A], [b, B], [c, C], [d, D]]) await L.say(p, { type: 'enter', pass: `pass:${x}` });
  // Not now: nothing for the inviter.
  let out = await L.say(a, { type: 'invite', did: B });
  const k1 = L.to(out, b)[0];
  out = await L.say(b, { type: 'answer', id: k1.id, play: false });
  assert.deepEqual(out, []);
  // Blocked: the inviter hears "invited", the other hears nothing.
  out = await L.say(a, { type: 'invite', did: C });
  assert.deepEqual(L.to(out, a), [{ type: 'invited', did: C }]);
  assert.deepEqual(L.to(out, c), []);
  // Someone not in the lounge: "invited" all the same.
  assert.deepEqual(L.to(await L.say(a, { type: 'invite', did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' }), a), [{ type: 'invited', did: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa' }]);
  // Already looking at an invitation: a second one doesn't arrive.
  out = await L.say(b, { type: 'invite', did: D });
  assert.equal(L.to(out, d)[0].type, 'knock');
  out = await L.say(a, { type: 'invite', did: D });
  assert.deepEqual(L.to(out, d), []);
  // A minute later: gone; Play then does nothing but say so.
  L.tick(61_000);
  const swept = L.lounge.sweep();
  assert.equal(L.to(swept, d)[0].type, 'knock-gone');
  const late = L.to(out, a);
  assert.deepEqual(late, [{ type: 'invited', did: D }]);
});

test('limits: the same person again only after 5 minutes; at most 10 invitations in 10 minutes', async () => {
  const L = makeLounge();
  const a = L.page('a'), b = L.page('b');
  await L.say(a, { type: 'enter', pass: `pass:${A}` });
  await L.say(b, { type: 'enter', pass: `pass:${B}` });
  await L.say(a, { type: 'invite', did: B });
  assert.equal(L.to(await L.say(a, { type: 'invite', did: B }), a)[0].why, 'too many');
  L.tick(5 * 60_000 + 1);
  assert.equal(L.to(await L.say(a, { type: 'invite', did: B }), a)[0].type, 'invited');
  for (let i = 0; i < 8; i++) assert.equal(L.to(await L.say(a, { type: 'invite', did: `did:plc:${String(i).repeat(24).slice(0, 24)}` }), a)[0].type, 'invited');
  assert.equal(L.to(await L.say(a, { type: 'invite', did: C }), a)[0].why, 'too many');
  assert.equal(L.to(await L.say(a, { type: 'invite', did: A }), a)[0].why, 'who', 'not yourself');
});

test('idle: 10 minutes untouched and you leave quietly; "here" keeps you in; an inviter who leaves takes the invitation along', async () => {
  const L = makeLounge();
  const a = L.page('a'), b = L.page('b');
  await L.say(a, { type: 'enter', pass: `pass:${A}` });
  await L.say(b, { type: 'enter', pass: `pass:${B}` });
  L.tick(9 * 60_000);
  await L.say(a, { type: 'here' });
  L.tick(2 * 60_000);
  const out = L.lounge.sweep();
  assert.deepEqual(L.to(out, b), [{ type: 'idle' }]);
  assert.ok(out.some((o) => o.conn === b && o.close && o.close.code === 4002));
  assert.deepEqual(L.to(out, a), []);
  assert.equal(L.lounge.stats().here, 1);
  // An invitation, then the inviter leaves (opened a table): the card goes.
  const b2 = L.page('b2');
  await L.say(b2, { type: 'enter', pass: `pass:${B}` });
  const k = L.to(await L.say(a, { type: 'invite', did: B }), b2)[0];
  assert.deepEqual(L.to(L.lounge.close(a), b2), [{ type: 'knock-gone', id: k.id }]);
});

test('atproto-lounge: the record read from the account\'s own server; blocks from Bluesky\'s public lookup, 30 at a time', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.startsWith('https://pds.example/xrpc/com.atproto.repo.getRecord')) {
      return new URL(url).searchParams.get('repo') === A ? new Response('{}', { status: 200 }) : new Response('{"error":"RecordNotFound"}', { status: 400 });
    }
    if (url.startsWith('https://appview.example/xrpc/app.bsky.graph.getRelationships')) {
      const q = new URL(url).searchParams;
      const rel = q.getAll('others').map((o) => (o === C ? { did: o, blockedByList: 'at://x/app.bsky.graph.listblock/1' } : o === D ? { did: o, blocking: 'at://x/app.bsky.graph.block/1' } : { did: o }));
      return Response.json({ actor: q.get('actor'), relationships: rel });
    }
    return new Response('', { status: 500 });
  };
  const idResolver = { did: { resolveAtprotoData: async (did) => ({ did, pds: 'https://pds.example' }) } };
  const L = atprotoLounge({ fetchImpl, idResolver, appview: 'https://appview.example' });
  assert.equal(await L.hasLoungeRecord(A), true);
  assert.equal(await L.hasLoungeRecord(B), false);
  assert.match(calls[0], /collection=cafe\.thunderbird\.daisy\.lounge&rkey=self/);
  const many = [B, C, D, ...Array.from({ length: 40 }, (_, i) => `did:plc:${String(i % 10).repeat(24)}`)];
  assert.deepEqual([...(await L.hiddenFrom(A, many))].sort(), [C, D].sort());
  assert.equal(calls.filter((u) => u.includes('getRelationships')).length, 2, '43 others: two lookups');
  const down = atprotoLounge({ fetchImpl: async () => new Response('', { status: 502 }), idResolver, appview: 'https://appview.example' });
  await assert.rejects(down.hiddenFrom(A, [B]));
  await assert.rejects(down.hasLoungeRecord(A));
});

test('hasLoungeRecord: did:plc only, never a did:web document (GHSA-mrhx-c7xc-m3w5)', async () => {
  const looked = [], fetched = [];
  const idResolver = { did: { resolveAtprotoData: async (did) => { looked.push(did); return { did, pds: 'https://pds.example' }; } } };
  const L = atprotoLounge({ fetchImpl: async (url) => { fetched.push(url); return Response.json({}); }, idResolver, appview: 'https://appview.example' });
  for (const did of ['did:web:example.com', 'did:web:evil.example%3A8080', 'did:key:zQ3shokFTS3brHcDQrn82RUDfCZESWL1ZdCEJwekUDPQiYBme', `${A}#atproto_pds`, 'did:plc:short', '', null]) {
    await assert.rejects(L.hasLoungeRecord(did), String(did));
  }
  assert.deepEqual(looked, [], 'no DID document looked up');
  assert.deepEqual(fetched, []);
  assert.equal(await L.hasLoungeRecord(A), true);
  assert.deepEqual(looked, [A]);
});

test('the lounge over real WebSockets at /lounge: enter, who, invite, Play, both sent to one table', async () => {
  const r = createRelayServer({
    port: 0, host: '127.0.0.1', allowedOrigins: ['https://thunderbird.cafe'], log: () => {},
    checkPass: async (p) => { if (p.startsWith('pass:')) return { did: p.slice(5) }; throw Object.assign(new Error('no'), { code: 'BadPass' }); },
    lounge: { hasLoungeRecord: async () => true, hiddenFrom: async () => new Set() },
  });
  const port = await r.listen();
  const open = () => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/lounge`, { origin: 'https://thunderbird.cafe' });
    const inbox = []; let wake = null;
    ws.on('message', (d) => { inbox.push(JSON.parse(d.toString())); if (wake) { wake(); wake = null; } });
    ws.on('open', () => resolve({ ws, send: (m) => ws.send(JSON.stringify(m)), async next() { while (!inbox.length) await new Promise((res) => { wake = res; setTimeout(res, 50); }); return inbox.shift(); } }));
  });
  const a = await open(), b = await open();
  a.send({ type: 'enter', pass: `pass:${A}` });
  assert.deepEqual(await a.next(), { type: 'in', did: A });
  b.send({ type: 'enter', pass: `pass:${B}` });
  assert.deepEqual(await b.next(), { type: 'in', did: B });
  a.send({ type: 'who' });
  assert.deepEqual((await a.next()).people, [B]);
  a.send({ type: 'invite', did: B });
  assert.deepEqual(await a.next(), { type: 'invited', did: B });
  const knock = await b.next();
  assert.equal(knock.type, 'knock');
  b.send({ type: 'answer', id: knock.id, play: true });
  const ta = await a.next(), tb = await b.next();
  assert.equal(ta.type, 'table');
  assert.equal(ta.table, tb.table);
  assert.match(ta.table, /^[a-z0-9]{10}$/);
  assert.deepEqual([ta.seat, tb.seat], [1, 2]);
  assert.deepEqual((await r.loungeStats()).here, 2);
  // A bad pass is refused; the tables at / still work alongside.
  const x = await open();
  x.send({ type: 'enter', pass: 'nope' });
  assert.deepEqual(await x.next(), { type: 'refused', why: 'BadPass' });
  for (const p of [a, b, x]) p.ws.close();
  await r.close();
});

test('the lounge without Bluesky\'s packages or lookups says it isn\'t ready', { timeout: 30000 }, async () => {
  const r = createRelayServer({ port: 0, host: '127.0.0.1', allowedOrigins: ['*'], log: () => {}, checkPass: null, lounge: null });
  const port = await r.listen();
  const ws = new WebSocket(`ws://127.0.0.1:${port}/lounge`);
  // Loading Bluesky's packages the first time can take a few seconds (on Windows especially), so wait for
  // the connection, then for a message or a quiet second and a half.
  const first = await new Promise((resolve) => {
    ws.on('message', (d) => resolve(JSON.parse(d.toString())));
    ws.on('close', () => resolve({ closed: true }));
    ws.on('open', () => setTimeout(() => resolve({ quiet: true }), 1500));
    setTimeout(() => resolve({ slow: true }), 20000);
  });
  assert.ok(!first.slow, 'the lounge connection opened');
  // With the packages installed the lounge is ready (nothing arrives until the page speaks); without, NotReady.
  if (!first.quiet && !first.closed) assert.deepEqual(first, { type: 'refused', why: 'NotReady' });
  ws.terminate();
  await r.close();
});

test('the limits are as decided (owner, Oct 18)', () => {
  assert.equal(LOUNGE_LIMITS.idleMs, 10 * 60_000);
  assert.equal(LOUNGE_LIMITS.knockMs, 60_000);
  assert.equal(LOUNGE_LIMITS.maxListed, 30);
  assert.equal(LOUNGE_LIMITS.sameInviteMs, 5 * 60_000);
  assert.equal(LOUNGE_LIMITS.invites, 10);
});

// ---------- Raku step 5b-2 (Oct 21): away, back, and the quiet signal ----------
test('away: not listed, not invitable (an invitation on its way lapses), but it hears "someone" when a mingler arrives, never who', async () => {
  const L = makeLounge();
  const a = L.page('a'), b = L.page('b'), c = L.page('c');
  await L.say(a, { type: 'enter', pass: `pass:${A}` });
  await L.say(b, { type: 'enter', pass: `pass:${B}` });
  // B invites A, then A steps away before answering: the invitation lapses
  const k = L.to(await L.say(b, { type: 'invite', did: A }), a)[0];
  assert.equal(k.type, 'knock');
  assert.deepEqual(await L.say(a, { type: 'away' }), [], 'stepping away says nothing to anyone');
  assert.deepEqual(L.to(await L.say(a, { type: 'answer', id: k.id, play: true }), a), [{ type: 'error', why: 'away' }], 'away: only "back"');
  L.tick(6000);
  assert.deepEqual(L.to(await L.say(b, { type: 'who' }), b)[0].people, [], 'away: not listed');
  L.tick(5 * 60_000);
  assert.deepEqual(L.to(await L.say(b, { type: 'invite', did: A }), b), [{ type: 'invited', did: A }], 'the inviter hears the same as always');
  assert.equal(L.lounge.stats().knocks, 0, 'no knock reaches a page that is away');
  // C arrives: A (away) hears "someone", B (here) hears nothing; the message carries no name
  const out = await L.say(c, { type: 'enter', pass: `pass:${C}` });
  assert.deepEqual(L.to(out, a), [{ type: 'someone' }]);
  assert.deepEqual(L.to(out, b), []);
  assert.ok(!JSON.stringify(L.to(out, a)).includes(C));
  assert.deepEqual(L.lounge.stats().listening, 1);
  // back: listed again, and its own return counts as an arrival for others who are away
  await L.say(b, { type: 'away' });
  const back = await L.say(a, { type: 'back' });
  assert.deepEqual(L.to(back, b), [{ type: 'someone' }], 'coming back from away is an arrival too');
  L.tick(6000);
  assert.deepEqual(L.to(await L.say(c, { type: 'who' }), c)[0].people, [A], 'back: listed (B is away)');
});

test('the signal: at most once every 5 minutes; not for people already there; blocks either way; nothing if the block check fails', async () => {
  const L = makeLounge({ blocks: [[D, A]] });                                    // D blocks A
  const a = L.page('a'), b = L.page('b'), c = L.page('c'), d = L.page('d');
  await L.say(b, { type: 'enter', pass: `pass:${B}` });                          // B is already here
  await L.say(a, { type: 'enter', pass: `pass:${A}`, away: true });              // A joins away (its tab behind)
  assert.equal(L.lounge.stats().listening, 1);
  L.tick(60_000);
  assert.deepEqual(L.to(await L.say(b, { type: 'here' }), a), [], 'someone already there does not count');
  assert.deepEqual(L.to(await L.say(c, { type: 'enter', pass: `pass:${C}` }), a), [{ type: 'someone' }]);
  L.lounge.close(c);
  const c2 = L.page('c2');
  L.tick(60_000);
  assert.deepEqual(L.to(await L.say(c2, { type: 'enter', pass: `pass:${C}` }), a), [], 'within 5 minutes: no second signal');
  L.tick(5 * 60_000);
  assert.deepEqual(L.to(await L.say(d, { type: 'enter', pass: `pass:${D}` }), a), [], 'blocked either way: never lights the mark');
  L.lounge.close(c2);
  const c3 = L.page('c3');
  assert.deepEqual(L.to(await L.say(c3, { type: 'enter', pass: `pass:${C}` }), a), [{ type: 'someone' }], 'after 5 minutes: again');
  const F = makeLounge({ failBlocks: true });
  const fa = F.page('a'), fb = F.page('b');
  await F.say(fa, { type: 'enter', pass: `pass:${A}`, away: true });
  assert.deepEqual(F.to(await F.say(fb, { type: 'enter', pass: `pass:${B}` }), fa), [], 'the block check failed: nobody hears anything');
});

test('listening lasts up to 2 hours away ("stopped"); away pages never go idle at 10 minutes; at most 200 listening', async () => {
  const L = makeLounge();
  const a = L.page('a'), b = L.page('b');
  await L.say(a, { type: 'enter', pass: `pass:${A}` });
  await L.say(b, { type: 'enter', pass: `pass:${B}` });
  await L.say(a, { type: 'away' });
  L.tick(30 * 60_000);
  await L.say(b, { type: 'here' });
  const swept = L.lounge.sweep();
  assert.deepEqual(L.to(swept, a), [], 'away for 30 minutes: still listening (no idle)');
  L.tick(91 * 60_000);
  await L.say(b, { type: 'here' });
  const later = L.lounge.sweep();
  assert.deepEqual(L.to(later, a), [{ type: 'stopped', why: 'time' }]);
  assert.ok(later.some((o) => o.conn === a && o.close && o.close.code === 4003));
  assert.equal(L.lounge.stats().listening, 0);
  // the cap
  assert.equal(LOUNGE_LIMITS.signalEveryMs, 5 * 60_000);
  assert.equal(LOUNGE_LIMITS.listenMs, 2 * 60 * 60_000);
  assert.equal(LOUNGE_LIMITS.maxListening, 200);
  let n = 0;
  const small = createLounge({ checkPass: async (p) => ({ did: p.slice(5) }), hasLoungeRecord: async () => true, hiddenFrom: async () => new Set(),
    newTableId: () => 'tablexxxx1', newId: () => `k${++n}`, limits: { ...LOUNGE_LIMITS, maxListening: 1 } });
  const p1 = {}, p2 = {};
  small.open(p1); small.open(p2);
  await small.receive(p1, JSON.stringify({ type: 'enter', pass: `pass:${A}`, away: true }));
  const full = await small.receive(p2, JSON.stringify({ type: 'enter', pass: `pass:${B}`, away: true }));
  assert.ok(full.some((o) => o.conn === p2 && o.msg && o.msg.type === 'stopped' && o.msg.why === 'full'));
  assert.equal(small.stats().listening, 1);
});
