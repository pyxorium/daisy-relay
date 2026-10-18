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
// (atproto-pass.js). This file adds what the lounge needs on top: only real accounts (did:plc, did:web;
// not a service, not a bare did:key, which would vouch for itself), passes that don't ask to last long,
// and each pass used once.
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

const isAccountDid = (s) => typeof s === 'string' && /^did:(plc:[a-z2-7]{24}|web:[a-zA-Z0-9.-]+(%3A\d+)?)$/.test(s);

// verifyJwt: (token, audience, lxm, getSigningKey) → payload, as @atproto/xrpc-server's.
// getSigningKey: (did, forceRefresh) → the account's did:key, as @atproto/identity's resolveAtprotoKey.
export function createPassChecker({ verifyJwt, getSigningKey, audience = AUDIENCE, lxm = LOUNGE_ENTER, now = () => Date.now() }) {
  const used = new Map();       // `${iss} ${jti}` → expiry (ms): each pass works once
  return async function checkPass(token) {
    if (typeof token !== 'string' || !token || token.length > MAX_PASS_LENGTH) throw new PassError('BadPass', 'not a pass');
    // Only accounts: never let a pass name a service (did#…) or a bare did:key (it would vouch for itself).
    let issGuess = null;
    try { issGuess = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')).iss; } catch { /* verifyJwt says why */ }
    if (issGuess !== null && issGuess !== undefined && !isAccountDid(issGuess)) throw new PassError('NotAnAccount', 'the pass must come from an account (did:plc or did:web)');
    let payload;
    try {
      payload = await verifyJwt(token, audience, lxm, getSigningKey);
    } catch (err) {
      throw new PassError((err && err.error) || 'BadPass', String((err && err.message) || err));
    }
    if (!isAccountDid(payload.iss)) throw new PassError('NotAnAccount', 'the pass must come from an account (did:plc or did:web)');
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
