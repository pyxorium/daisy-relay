// A stand-in for the live relay with the lounge, for the browser checks in daisy-tiles (test/check_page.py):
// the real server.js and lounge.js, with stand-in lookups: a pass is "pass:<did>", every account has its
// lounge record unless listed in DAISY_NO_RECORD, and blocks come from DAISY_BLOCKS ("did>did,did>did").
//
//   node test/lounge-standin.mjs <port>
import { createRelayServer } from '../server.js';

const port = Number(process.argv[2]) || 8788;
const blocks = (process.env.DAISY_BLOCKS || '').split(',').filter(Boolean).map((p) => p.split('>'));
const noRecord = new Set((process.env.DAISY_NO_RECORD || '').split(',').filter(Boolean));
const r = createRelayServer({
  port, host: '127.0.0.1', allowedOrigins: ['*'], log: () => {},
  checkPass: async (p) => {
    if (typeof p === 'string' && p.startsWith('pass:did:')) return { did: p.slice(5), exp: Math.floor(Date.now() / 1000) + 60 };
    throw Object.assign(new Error('not a pass'), { code: 'BadPass' });
  },
  lounge: {
    hasLoungeRecord: async (did) => !noRecord.has(did),
    hiddenFrom: async (did, others) => new Set(others.filter((o) => blocks.some(([x, y]) => (x === did && y === o) || (x === o && y === did)))),
  },
  ...(process.env.DAISY_LOUNGE_FAST ? { loungeLimits: { idleMs: 8000, knockMs: 6000, whoEveryMs: 300, maxListed: 30, sameInviteMs: 1000, invites: 50, invitesPerMs: 60000, maxBytes: 8192 }, loungeSweepMs: 500 } : {}),
});
await r.listen();
console.log(`Daisy relay with the lounge (stand-in lookups) on ws://127.0.0.1:${port}/`);
