// atproto-pass.js: the lounge pass check wired to Bluesky's own packages (build step 6).
// verifyJwt from @atproto/xrpc-server; account keys from @atproto/identity (did:plc through plc.directory;
// did:web is refused before any lookup, see lounge-auth.js), cached in memory for an hour, refreshed when
// a signature doesn't match (a rotated key).
import { verifyJwt } from '@atproto/xrpc-server';
import { IdResolver, MemoryCache } from '@atproto/identity';
import { createPassChecker } from './lounge-auth.js';

export function atprotoPassChecker(opts = {}) {
  const idResolver = new IdResolver({ didCache: new MemoryCache(), timeout: 5000 });
  return createPassChecker({
    verifyJwt,
    getSigningKey: (did, forceRefresh) => idResolver.did.resolveAtprotoKey(did, forceRefresh),
    ...opts,
  });
}
