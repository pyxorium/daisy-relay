// lounge-auth.js: the relay's own identity, and the check on a player's lounge pass (build step 6).
//
// A pass is an atproto service-auth token: the player's page asks the player's own server (PDS), through
// com.atproto.server.getServiceAuth, for a short signed token addressed to this relay and to one method.
// The page can only ask for it if the player agreed to the permission
//   rpc:cafe.thunderbird.daisy.lounge.enter?aud=did:web:relay.daisy.thunderbird.cafe%23daisy_relay
// when signing in. The PDS signs it with the account's own signing key, so the relay can check, from the
// account's public DID document, that the account named in the pass really asked for it.
//
// The check itself is Bluesky's: verifyJwt from @atproto/xrpc-server (format, expiry, audience, method,
// signature, with a fresh key lookup if the cached one fails), with keys looked up by @atproto/identity
// (atproto-pass.js). This file adds what the lounge needs on top: only did:plc accounts (not a service,
// not a bare did:key, which would vouch for itself, and not did:web: see below), passes that don't ask to
// last long, and each pass used once.
//
// Why not did:web (Oct 26, as the Rooms relay since Oct 25): @atproto/identity checks every DID document
// it fetches with zod, which has a memory-exhaustion advisory with no fix for zod 3 (GHSA-mrhx-c7xc-m3w5).
// verifyJwt looks the account's document up before the signature is checked, so a pass merely naming a
// did:web account would make the relay fetch a document from a domain its author controls. did:plc
// documents come from plc.directory. A did:web pass is refused before any lookup ("AccountType"), and the
// key lookup itself is guarded too.
export const RELAY_HOST = 'relay.daisy.thunderbird.cafe';
export const RELAY_DID = `did:web:${RELAY_HOST}`;
export const SERVICE_ID = 'daisy_relay';
export const AUDIENCE = `${RELAY_DID}#${SERVICE_ID}`;
export const LOUNGE_ENTER = 'cafe.thunderbird.daisy.lounge.enter';
export const MAX_PASS_SECONDS = 5 * 60;           // a pass asking to last longer than this is refused
export const MAX_PASS_LENGTH = 4096;

// The relay's DID document, served at https://relay.daisy.thunderbird.cafe/.well-known/did.json.
export function didDocument(host = RELAY_HOST) {
  return {
    '@context': ['https://www.w3.org/ns/did/v1'],
    id: `did:web:${host}`,
    service: [{ id: `#${SERVICE_ID}`, type: 'DaisyRelay', serviceEndpoint: `https://${host}` }],
  };
}

export class PassError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export const isAccountDid = (s) => typeof s === 'string' && /^did:plc:[a-z2-7]{24}$/.test(s);
const isWebDid = (s) => typeof s === 'string' && s.startsWith('did:web:');
const notPlc = (did) => new PassError(isWebDid(did) ? 'AccountType' : 'NotAnAccount',
  isWebDid(did) ? 'only did:plc accounts can mingle in the lounge' : 'the pass must come from an account (did:plc)');

// verifyJwt: (token, audience, lxm, getSigningKey) → payload, as @atproto/xrpc-server's.
// getSigningKey: (did, forceRefresh) → the account's did:key, as @atproto/identity's resolveAtprotoKey.
export function createPassChecker({ verifyJwt, getSigningKey, audience = AUDIENCE, lxm = LOUNGE_ENTER, now = () => Date.now() }) {
  const used = new Map();       // `${iss} ${jti}` → expiry (ms): each pass works once
  return async function checkPass(token) {
    if (typeof token !== 'string' || !token || token.length > MAX_PASS_LENGTH) throw new PassError('BadPass', 'not a pass');
    // Only accounts: never let a pass name a service (did#…) or a bare did:key (it would vouch for itself).
    let issGuess = null;
    try { issGuess = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')).iss; } catch { /* verifyJwt says why */ }
    if (issGuess !== null && issGuess !== undefined && !isAccountDid(issGuess)) throw notPlc(issGuess);
    // Belt and braces: never look up a document for anything but a did:plc account.
    const lookUp = (did, forceRefresh) => {
      if (!isAccountDid(did)) throw notPlc(did);
      return getSigningKey(did, forceRefresh);
    };
    let payload;
    try {
      payload = await verifyJwt(token, audience, lxm, lookUp);
    } catch (err) {
      if (err instanceof PassError) throw err;
      throw new PassError((err && err.error) || 'BadPass', String((err && err.message) || err));
    }
    if (!isAccountDid(payload.iss)) throw notPlc(payload.iss);
    const t = now();
    if (payload.exp * 1000 - t > MAX_PASS_SECONDS * 1000) throw new PassError('PassTooLong', `a pass may last at most ${MAX_PASS_SECONDS / 60} minutes`);
    if (typeof payload.jti !== 'string' || !payload.jti) throw new PassError('NoPassId', 'the pass has no id (jti)');
    for (const [k, exp] of used) if (exp < t) used.delete(k);
    const key = `${payload.iss} ${payload.jti}`;
    if (used.has(key)) throw new PassError('PassUsed', 'this pass was used already');
    used.set(key, payload.exp * 1000);
    return { did: payload.iss, exp: payload.exp };
  };
}
