// tables.js: the relay's rules, with no network parts, so they're tested in Node and shared by the
// stand-in relay (scripts/relay-standin.mjs) and, in step 5, the real one on Fly.io.
//
// The relay passes messages and stores nothing: no match, no move, no record. It only knows, while it
// runs, which account sits at which seat of which table, so it can pass each message to the other seat
// and tell each page when the other one comes or goes. A relay restart costs a reconnect, never the
// match: both pages keep everything, and each asks the other for what it missed.
//
// Page → relay (JSON):  { type: "join", table, seat: 1 | 2 | "any", did, handle, house?, fresh? }
//                       { type: "send", data }        (data: anything, passed on as it is)
// Relay → page:         { type: "joined", table, seat, other: { did, handle, here, house } | null }
//                       { type: "peer", data }
//                       { type: "presence", seat, state: "here" | "gone", did, handle, house }
//                       { type: "full" }  { type: "held", seat }  { type: "error", why }  { type: "replaced" }
//
// A seat belongs to an account: the same account joining again (a reload, another tab) takes its seat
// back and the older connection is told "replaced". "any" gives an account its own seat if it has one,
// else the first free seat, else "full". (Before sign-in, in step 4, an account is only what the page
// says it is; the dice don't depend on it.)
//
// A page that has none of a seat's kept state joins with `fresh: true`. If its account already holds a
// seat at the table, the relay answers "held" and changes nothing: that seat's game (and its house's
// secret seed) lives in another browser, and only that browser can go on with it (Oct 18).
//
// `house` names the version of the house tile the page runs (its pinned record CID, or a fingerprint of
// the memory copy). The relay only passes it on; each page compares the other's with its own and won't
// start a table with a different referee (step 4). (The relay doesn't check who's who: a page signs in
// to save, and the dice don't depend on the account.)

export const LIMITS = Object.freeze({
  maxBytes: 64 * 1024,        // one message
  burst: 80, perSecond: 40,   // per connection: 80 at once, then 40 a second (the shared view sends 15 a second)
  idleTableMs: 6 * 60 * 60 * 1000,   // a table nobody has been at for 6 hours is forgotten
});
export const isTableId = (x) => typeof x === 'string' && /^[a-z0-9]{8,32}$/.test(x);
const isDid = (x) => typeof x === 'string' && x.length <= 2048 && /^did:[a-z]+:[A-Za-z0-9._:%-]+$/.test(x);
const isHandle = (x) => typeof x === 'string' && x.length > 0 && x.length <= 253 && /^[a-z0-9.-]+$/.test(x);
const withHouse = (house) => (house ? { house } : {});
export const isHouseVersion = (x) => typeof x === 'string' && /^[a-z0-9:]{8,120}$/i.test(x);

export function createRelay({ now = () => Date.now(), limits = LIMITS } = {}) {
  const tables = new Map();     // id → { seats: [seat | null, seat | null], seen }
  const conns = new Map();      // conn → { table, seat, tokens, at }

  const send = (conn, msg) => ({ conn, msg });
  const otherOf = (seat) => (seat === 1 ? 2 : 1);

  function join(conn, m, out) {
    if (conns.get(conn).table) return out.push(send(conn, { type: 'error', why: 'already joined' }));
    if (!isTableId(m.table)) return out.push(send(conn, { type: 'error', why: 'table' }));
    if (!isDid(m.did) || !isHandle(m.handle)) return out.push(send(conn, { type: 'error', why: 'account' }));
    if (!(m.seat === 1 || m.seat === 2 || m.seat === 'any')) return out.push(send(conn, { type: 'error', why: 'seat' }));
    if ('house' in m && !isHouseVersion(m.house)) return out.push(send(conn, { type: 'error', why: 'house' }));
    const house = m.house || null;
    let t = tables.get(m.table);
    if (!t) { t = { seats: [null, null], seen: now() }; tables.set(m.table, t); }
    t.seen = now();
    const own = t.seats.findIndex((s) => s && s.did === m.did) + 1;          // 0: none
    let seat;
    if (own && m.fresh === true) return out.push(send(conn, { type: 'held', seat: own }));
    if (own) seat = own;                                                    // your seat, whatever you asked
    else if (m.seat === 'any') seat = !t.seats[0] ? 1 : !t.seats[1] ? 2 : 0;
    else seat = t.seats[m.seat - 1] ? 0 : m.seat;
    if (!seat) return out.push(send(conn, { type: 'full' }));
    const was = t.seats[seat - 1];
    if (was && was.conn && was.conn !== conn) {
      out.push(send(was.conn, { type: 'replaced' }));
      conns.set(was.conn, { ...conns.get(was.conn), table: null, seat: null });
    }
    t.seats[seat - 1] = { did: m.did, handle: m.handle, house, conn };
    Object.assign(conns.get(conn), { table: m.table, seat });
    const o = t.seats[otherOf(seat) - 1];
    out.push(send(conn, { type: 'joined', table: m.table, seat, other: o ? { did: o.did, handle: o.handle, here: !!o.conn, ...withHouse(o.house) } : null }));
    if (o && o.conn) out.push(send(o.conn, { type: 'presence', seat, state: 'here', did: m.did, handle: m.handle, ...withHouse(house) }));
  }

  function allowed(c) {
    const t = now();
    c.tokens = Math.min(limits.burst, c.tokens + ((t - c.at) / 1000) * limits.perSecond);
    c.at = t;
    if (c.tokens < 1) return false;
    c.tokens -= 1;
    return true;
  }

  return {
    // A new connection (any object that stands for it).
    open(conn) { conns.set(conn, { table: null, seat: null, tokens: limits.burst, at: now() }); },

    // A text message from a connection. Returns what to send: [{ conn, msg }].
    receive(conn, text) {
      const out = [];
      const c = conns.get(conn);
      if (!c) return out;
      if (typeof text !== 'string' || text.length > limits.maxBytes) return [send(conn, { type: 'error', why: 'too big' })];
      if (!allowed(c)) return [send(conn, { type: 'error', why: 'too many' })];
      let m;
      try { m = JSON.parse(text); } catch { return [send(conn, { type: 'error', why: 'not JSON' })]; }
      if (!m || typeof m !== 'object') return [send(conn, { type: 'error', why: 'not a message' })];
      if (m.type === 'join') { join(conn, m, out); return out; }
      if (m.type === 'send') {
        if (!c.table) return [send(conn, { type: 'error', why: 'join a table first' })];
        const t = tables.get(c.table);
        t.seen = now();
        const o = t.seats[otherOf(c.seat) - 1];
        if (o && o.conn) out.push(send(o.conn, { type: 'peer', data: m.data }));
        return out;                       // nobody there: dropped (the pages ask again when they're both back)
      }
      return [send(conn, { type: 'error', why: 'unknown type' })];
    },

    // A connection closed.
    close(conn) {
      const out = [];
      const c = conns.get(conn);
      conns.delete(conn);
      if (!c || !c.table) return out;
      const t = tables.get(c.table);
      const mine = t && t.seats[c.seat - 1];
      if (!mine || mine.conn !== conn) return out;
      mine.conn = null;
      t.seen = now();
      const o = t.seats[otherOf(c.seat) - 1];
      if (o && o.conn) out.push(send(o.conn, { type: 'presence', seat: c.seat, state: 'gone', did: mine.did, handle: mine.handle, ...withHouse(mine.house) }));
      return out;
    },

    // Forget tables nobody has been at for a while (call now and then).
    sweep() {
      for (const [id, t] of tables) if (t.seats.every((s) => !s || !s.conn) && now() - t.seen > limits.idleTableMs) tables.delete(id);
    },

    stats: () => ({ tables: tables.size, connections: conns.size }),
  };
}
