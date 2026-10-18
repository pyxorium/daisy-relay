// atproto-lounge.js: the lounge's lookups in the atproto network (build step 6), for lounge.js.
//  - hasLoungeRecord(did): does the account have its lounge record (cafe.thunderbird.daisy.lounge/self)?
//    Read from the account's own server (found through its DID document, @atproto/identity).
//  - hiddenFrom(did, others): which of the others must not meet this account: blocked either way, directly
//    or through a block list. Bluesky's public app.bsky.graph.getRelationships (no sign-in; up to 30 others
//    a call). Throws when the lookup fails, so the lounge shows nobody rather than someone blocked.
// (@atproto/identity is loaded when first needed, so the tests can hand in a stand-in resolver.)

export const LOUNGE_COLLECTION = 'cafe.thunderbird.daisy.lounge';
export const APPVIEW = 'https://public.api.bsky.app';
const TIMEOUT_MS = 5000;

const withTimeout = (fetchImpl) => async (url) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try { return await fetchImpl(url, { signal: ac.signal, headers: { accept: 'application/json' } }); }
  finally { clearTimeout(t); }
};

export function atprotoLounge({ fetchImpl = fetch, idResolver = null, appview = APPVIEW } = {}) {
  const get = withTimeout(fetchImpl);
  let resolver = idResolver;
  const ids = async () => {
    if (!resolver) {
      const { IdResolver, MemoryCache } = await import('@atproto/identity');
      resolver = new IdResolver({ didCache: new MemoryCache(), timeout: TIMEOUT_MS });
    }
    return resolver;
  };
  return {
    async hasLoungeRecord(did) {
      const data = await (await ids()).did.resolveAtprotoData(did);
      const pds = String(data.pds || '').replace(/\/+$/, '');
      if (!pds.startsWith('https://')) throw new Error('no https server for this account');
      const url = `${pds}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(did)}&collection=${LOUNGE_COLLECTION}&rkey=self`;
      const res = await get(url);
      if (res.ok) return true;
      if (res.status === 400 || res.status === 404) return false;          // RecordNotFound
      throw new Error(`the account's server answered ${res.status}`);
    },
    async hiddenFrom(did, others) {
      const hidden = new Set();
      for (let i = 0; i < others.length; i += 30) {
        const chunk = others.slice(i, i + 30);
        const q = new URLSearchParams({ actor: did });
        for (const o of chunk) q.append('others', o);
        const res = await get(`${appview}/xrpc/app.bsky.graph.getRelationships?${q}`);
        if (!res.ok) throw new Error(`the block check answered ${res.status}`);
        const body = await res.json();
        for (const r of body.relationships || []) {
          if (r && r.did && (r.blocking || r.blockedBy || r.blockingByList || r.blockedByList)) hidden.add(r.did);
        }
      }
      return hidden;
    },
  };
}
