// lounge.js: Daisy's lounge on the relay (build step 6). No network parts: the WebSocket wiring is in
// server.js and the atproto lookups in atproto-lounge.js, handed in, so all of this is tested in Node.
//
// Who is here: a page joins with a pass (a service-auth token from the player's own server, checked by
// lounge-auth.js) for an account that has a lounge record (cafe.thunderbird.daisy.lounge/self: the
// lasting "I mingle" opt-in). It stays here while it's on Daisy's start screen; the page leaves when it
// opens a table, when mingling is turned off, or after 10 minutes nobody touched it (owner, Oct 18).
// The relay keeps nothing on disk and forgets everyone when it restarts (the pages simply join again).
//
// Page → relay (JSON):  { type: "enter", pass }        join the lounge (once per connection)
//                       { type: "here" }                someone touched the page (keeps it from going idle)
//                       { type: "who" }                 who else is mingling and here now?
//                       { type: "invite", did }         invite someone to a game
//                       { type: "answer", id, play }    play: true = Play; false = Not now (nothing goes to the inviter)
//                       { type: "away" }   { type: "back" }   (Raku step 5b-2: the page is out of sight / in front again)
//                       { type: "enter", pass, away: true }  join already away (Daisy's tab open but not in front)
// Relay → page:         { type: "in", did }   { type: "refused", why }   { type: "replaced" }   { type: "idle" }
//                       { type: "people", at, people: [did, …] }   { type: "people", at, people: [], problem: "blocks" }
//                       { type: "invited", did }        always the same, whatever happens next (privacy)
//                       { type: "knock", id, from, expiresAt }      an invitation (from: the inviter's DID)
//                       { type: "knock-gone", id }      the invitation can't be taken up any more
//                       { type: "table", table, seat, with }        both said yes: go to this table
//                       { type: "error", why }
//                       { type: "someone" }             (to a page that is away) someone arrived in the lounge: no name
//                       { type: "stopped" }             (to a page that is away) 2 hours away, or too many listening: out
//
// Away (Raku step 5b-2, owner Oct 21): a page whose Daisy tab isn't in front says "away" and stays connected
// as a listener: not listed, can't be invited (an invitation on its way lapses), but when another mingler
// arrives (enters, or comes back from away) it may hear "someone" (never who), unless either has blocked the
// other, and at most once every 5 minutes. People already in the lounge when it stepped away don't count.
// Listening lasts up to 2 hours away ("stopped"); "back" puts the page in the lounge again. Pages that never
// say "away" (the Daisy page) work exactly as before.
// Privacy (owner, Oct 17 and 18): only minglers who are here are listed, only to a mingler who is here
// and asks; blocks (direct and by list, either way) keep two players apart, and if the block check fails
// nobody is listed; an inviter learns nothing about what became of an invitation: "invited" is sent
// whether it reached anyone or not, and the page shows "No answer" after a minute unless both go to a table.
export const LOUNGE_LIMITS = Object.freeze({
  idleMs: 10 * 60_000,          // 10 minutes nobody touched the page: out of the lounge
  knockMs: 60_000,              // an invitation lasts about a minute
  whoEveryMs: 5_000,            // "Who else is mingling?" at most every 5 seconds
  maxListed: 30,                // at most this many in a snapshot (one block lookup)
  sameInviteMs: 5 * 60_000,     // the same person again only after 5 minutes
  invites: 10, invitesPerMs: 10 * 60_000,   // at most 10 invitations in 10 minutes
  maxBytes: 8 * 1024,
  signalEveryMs: 5 * 60_000,    // "someone" at most once every 5 minutes per listening page (step 5b-2)
  listenMs: 2 * 60 * 60_000,    // listening lasts up to 2 hours away
  maxListening: 200,            // at most this many listening at once
});
const isDid = (x) => typeof x === 'string' && x.length <= 2048 && /^did:(plc|web):[A-Za-z0-9._:%-]+$/.test(x);

// deps: checkPass(pass) → { did }; hasLoungeRecord(did) → boolean; hiddenFrom(did, others) → Set of the
// others to hide (blocked either way; throws if the lookup failed); newTableId(); newId(); now(); random().
export function createLounge({ checkPass, hasLoungeRecord, hiddenFrom, newTableId, newId, now = () => Date.now(), random = Math.random, limits: given = {} }) {
  const limits = { ...LOUNGE_LIMITS, ...given };       // (a test's partial limits keep the rest)
  const conns = new Map();      // conn → { did, lastHere, lastWho, invites: [time], sent: Map(did → time), entering }
  const byDid = new Map();      // did → conn (one place in the lounge per account)
  const knocks = new Map();     // id → { from, to, expires }
  const out = [];
  const send = (conn, msg) => out.push({ conn, msg });
  const close = (conn, code, why) => out.push({ conn, close: { code, why } });
  const flush = () => out.splice(0);

  function leave(conn) {
    const c = conns.get(conn);
    if (!c || !c.did) return;
    if (byDid.get(c.did) === conn) byDid.delete(c.did);
    for (const [id, k] of knocks) {
      if (k.to === c.did) knocks.delete(id);
      else if (k.from === c.did) { knocks.delete(id); const to = byDid.get(k.to); if (to) send(to, { type: 'knock-gone', id }); }
    }
    c.did = null;
  }

  // ---------- away and the quiet signal (step 5b-2) ----------
  const listening = () => [...conns.entries()].filter(([, x]) => x.did && x.away);
  function goAway(conn, c) {
    if (c.away) return;
    if (listening().length >= limits.maxListening) { leave(conn); send(conn, { type: 'stopped', why: 'full' }); close(conn, 4003, 'stopped'); return; }
    c.away = true; c.awaySince = now();
    // invitations to or from this page lapse, as if it had left (the inviter sees "No answer" as usual)
    for (const [id, k] of knocks) {
      if (k.to === c.did) knocks.delete(id);
      else if (k.from === c.did) { knocks.delete(id); const to = byDid.get(k.to); if (to) send(to, { type: 'knock-gone', id }); }
    }
  }
  // Someone arrived (entered, or came back from away): tell the listening pages, no name, blocks respected,
  // at most once every 5 minutes each. If the block check fails, nobody hears anything.
  async function arrived(conn, c) {
    const t = now();
    const targets = listening().filter(([, x]) => x.did !== c.did && t - x.lastSignal >= limits.signalEveryMs && t - x.awaySince < limits.listenMs);
    for (let i = 0; i < targets.length; i += limits.maxListed) {
      const chunk = targets.slice(i, i + limits.maxListed);
      let hidden;
      try { hidden = await hiddenFrom(c.did, chunk.map(([, x]) => x.did)); } catch { continue; }
      for (const [lc, x] of chunk) {
        if (hidden.has(x.did) || !conns.has(lc) || !x.away || byDid.get(x.did) !== lc) continue;
        x.lastSignal = now();
        send(lc, { type: 'someone' });
      }
    }
  }

  async function enter(conn, c, m) {
    if (c.did || c.entering) return send(conn, { type: 'error', why: 'already in' });
    c.entering = true;
    try {
      let did;
      try { ({ did } = await checkPass(m.pass)); }
      catch (err) { return send(conn, { type: 'refused', why: (err && err.code) || 'BadPass' }); }
      let has = false;
      try { has = await hasLoungeRecord(did); } catch { return send(conn, { type: 'refused', why: 'RecordCheckFailed' }); }
      if (!has) return send(conn, { type: 'refused', why: 'NoLoungeRecord' });
      if (!conns.has(conn)) return;                                      // closed while checking
      const before = byDid.get(did);
      if (before && before !== conn) { leave(before); send(before, { type: 'replaced' }); close(before, 4001, 'replaced'); }
      c.did = did; c.lastHere = now();
      byDid.set(did, conn);
      send(conn, { type: 'in', did });
      if (m.away === true) goAway(conn, c);
      else await arrived(conn, c);
    } finally { c.entering = false; }
  }

  async function who(conn, c) {
    const t = now();
    if (c.lastWho && t - c.lastWho < limits.whoEveryMs) return send(conn, { type: 'error', why: 'too soon' });
    c.lastWho = t;
    let others = [...byDid.keys()].filter((d) => d !== c.did && !conns.get(byDid.get(d)).away && t - conns.get(byDid.get(d)).lastHere < limits.idleMs);
    for (let i = others.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [others[i], others[j]] = [others[j], others[i]]; }
    others = others.slice(0, limits.maxListed);
    const at = new Date(t).toISOString();
    if (!others.length) return send(conn, { type: 'people', at, people: [] });
    let hidden;
    try { hidden = await hiddenFrom(c.did, others); }
    catch { return send(conn, { type: 'people', at, people: [], problem: 'blocks' }); }
    send(conn, { type: 'people', at, people: others.filter((d) => !hidden.has(d) && byDid.has(d)) });
  }

  async function invite(conn, c, m) {
    if (!isDid(m.did) || m.did === c.did) return send(conn, { type: 'error', why: 'who' });
    const t = now();
    c.invites = c.invites.filter((x) => t - x < limits.invitesPerMs);
    const lastTo = c.sent.get(m.did);
    if (c.invites.length >= limits.invites || (lastTo && t - lastTo < limits.sameInviteMs)) return send(conn, { type: 'error', why: 'too many', did: m.did });
    c.invites.push(t);
    c.sent.set(m.did, t);
    send(conn, { type: 'invited', did: m.did });                     // the same answer whatever happens next
    const toConn = byDid.get(m.did);
    if (!toConn || conns.get(toConn).away || t - conns.get(toConn).lastHere >= limits.idleMs) return;
    if ([...knocks.values()].some((k) => k.to === m.did && k.expires > t)) return;   // already looking at one
    let hidden;
    try { hidden = await hiddenFrom(c.did, [m.did]); } catch { return; }            // can't check: nothing sent
    if (hidden.has(m.did) || !byDid.has(m.did) || byDid.get(c.did) !== conn || conns.get(byDid.get(m.did)).away) return;
    const id = newId();
    const expires = now() + limits.knockMs;
    knocks.set(id, { from: c.did, to: m.did, expires });
    send(byDid.get(m.did), { type: 'knock', id, from: c.did, expiresAt: new Date(expires).toISOString() });
  }

  function answer(conn, c, m) {
    const k = typeof m.id === 'string' && knocks.get(m.id);
    if (m.play !== true) { if (k && k.to === c.did) knocks.delete(m.id); return; }   // Not now: dropped; the inviter hears nothing
    if (!k || k.to !== c.did || k.expires < now() || !byDid.has(k.from) || conns.get(byDid.get(k.from)).away) {
      if (k) knocks.delete(m.id);
      return send(conn, { type: 'knock-gone', id: m.id });
    }
    knocks.delete(m.id);
    const table = newTableId();
    const fromConn = byDid.get(k.from);
    send(fromConn, { type: 'table', table, seat: 1, with: c.did });
    send(conn, { type: 'table', table, seat: 2, with: k.from });
  }

  return {
    open(conn) { conns.set(conn, { did: null, lastHere: 0, lastWho: 0, invites: [], sent: new Map(), entering: false, away: false, awaySince: 0, lastSignal: -Infinity }); },
    // A text message: returns what to send / close, once any lookups are done.
    async receive(conn, text) {
      const c = conns.get(conn);
      if (!c) return flush();
      let m = null;
      if (typeof text === 'string' && text.length <= limits.maxBytes) { try { m = JSON.parse(text); } catch { m = null; } }
      if (!m || typeof m !== 'object' || typeof m.type !== 'string') { send(conn, { type: 'error', why: 'not a message' }); return flush(); }
      if (m.type === 'enter') await enter(conn, c, m);
      else if (!c.did) send(conn, { type: 'error', why: 'enter first' });
      else if (m.type === 'away') goAway(conn, c);
      else if (m.type === 'back') { const was = c.away; c.away = false; c.lastHere = now(); if (was) await arrived(conn, c); }
      else if (c.away) send(conn, { type: 'error', why: 'away' });    // away: only "back" (or leaving) until then
      else if (m.type === 'here') c.lastHere = now();
      else if (m.type === 'who') { c.lastHere = now(); await who(conn, c); }
      else if (m.type === 'invite') { c.lastHere = now(); await invite(conn, c, m); }
      else if (m.type === 'answer') { c.lastHere = now(); answer(conn, c, m); }
      else send(conn, { type: 'error', why: 'unknown type' });
      return flush();
    },
    close(conn) { leave(conn); conns.delete(conn); return flush(); },
    // Now and then: idle pages leave; old invitations go.
    sweep() {
      const t = now();
      for (const [conn, c] of conns) {
        if (c.did && c.away && t - c.awaySince >= limits.listenMs) { leave(conn); send(conn, { type: 'stopped', why: 'time' }); close(conn, 4003, 'stopped'); }
        else if (c.did && !c.away && t - c.lastHere >= limits.idleMs) { leave(conn); send(conn, { type: 'idle' }); close(conn, 4002, 'idle'); }
      }
      for (const [id, k] of knocks) if (k.expires < t) { knocks.delete(id); const to = byDid.get(k.to); if (to) send(to, { type: 'knock-gone', id }); }
      return flush();
    },
    stats: () => ({ here: [...conns.values()].filter((x) => x.did && !x.away).length, listening: listening().length, connections: conns.size, knocks: knocks.size }),
  };
}
