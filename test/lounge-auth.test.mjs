// The lounge pass check (step 6), with Bluesky's real code: passes made and signed by @atproto/crypto
// keypairs with createServiceJwt, checked by the relay's checker around verifyJwt. The keys are looked up
// by a stand-in here (no network); atproto-pass.js wires in @atproto/identity for real.
// Needs `npm install` (the @atproto packages). DAISY_ATPROTO_BUNDLE can name a single bundle of the same
// code instead (how the build chat's sandbox runs it).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPassChecker, didDocument, AUDIENCE, LOUNGE_ENTER, RELAY_DID, MAX_PASS_SECONDS } from '../lounge-auth.js';

async function load() {
  if (process.env.DAISY_ATPROTO_BUNDLE) {
    const b = await import(process.env.DAISY_ATPROTO_BUNDLE);
    return { crypto: b.crypto, verifyJwt: b.verifyJwt, createServiceJwt: b.createServiceJwt };
  }
  try {
    const crypto = await import('@atproto/crypto');
    const { verifyJwt, createServiceJwt } = await import('@atproto/xrpc-server');
    return { crypto, verifyJwt, createServiceJwt };
  } catch { return null; }
}
const atp = await load();
const skip = !atp && 'the @atproto packages are not installed (npm install)';

const ALICE = 'did:plc:rqbqpaaluty5v47jwciowpik';
const BOB = 'did:plc:joer5rzmwgec3dkr4srfmq45';
const WEBBY = 'did:web:example.com';
const now = () => Math.floor(Date.now() / 1000);

async function setup() {
  const keys = {
    [ALICE]: await atp.crypto.Secp256k1Keypair.create(),
    [BOB]: await atp.crypto.P256Keypair.create(),         // both kinds of atproto key
    [WEBBY]: await atp.crypto.Secp256k1Keypair.create(),
  };
  const lookups = [];
  const getSigningKey = async (did, force) => {
    lookups.push([did, force]);
    if (!keys[did]) throw new Error(`could not resolve ${did}`);
    return keys[did].did();
  };
  const check = createPassChecker({ verifyJwt: atp.verifyJwt, getSigningKey });
  const pass = (o = {}) => atp.createServiceJwt({ iss: ALICE, aud: AUDIENCE, lxm: LOUNGE_ENTER, keypair: keys[o.iss || ALICE], ...o });
  return { keys, check, pass, lookups };
}
const refused = async (promise, code) => {
  await assert.rejects(promise, (err) => { assert.equal(err.code, code, `${err.code}: ${err.message}`); return true; });
};

test('the relay\'s DID document: did:web at its own name, with the #daisy_relay service', () => {
  const d = didDocument();
  assert.equal(d.id, RELAY_DID);
  assert.equal(RELAY_DID, 'did:web:relay.daisy.thunderbird.cafe');
  assert.equal(AUDIENCE, 'did:web:relay.daisy.thunderbird.cafe#daisy_relay');
  assert.deepEqual(d.service, [{ id: '#daisy_relay', type: 'DaisyRelay', serviceEndpoint: 'https://relay.daisy.thunderbird.cafe' }]);
});

test('a good pass is accepted and names its account (secp256k1, P-256, did:web)', { skip }, async () => {
  const { check, pass } = await setup();
  assert.deepEqual(Object.keys(await check(await pass())), ['did', 'exp']);
  assert.equal((await check(await pass())).did, ALICE);
  assert.equal((await check(await pass({ iss: BOB }))).did, BOB);
  assert.equal((await check(await pass({ iss: WEBBY }))).did, WEBBY);
});

test('refused: another audience, another method, no method, expired, too long', { skip }, async () => {
  const { check, pass } = await setup();
  await refused(check(await pass({ aud: 'did:web:relay.daisy.thunderbird.cafe' })), 'BadJwtAudience');   // no #daisy_relay
  await refused(check(await pass({ aud: 'did:web:api.bsky.app#bsky_appview' })), 'BadJwtAudience');
  await refused(check(await pass({ lxm: 'cafe.thunderbird.daisy.lounge.other' })), 'BadJwtLexiconMethod');
  await refused(check(await pass({ lxm: null })), 'BadJwtLexiconMethod');
  await refused(check(await pass({ iat: now() - 120, exp: now() - 60 })), 'JwtExpired');
  await refused(check(await pass({ exp: now() + MAX_PASS_SECONDS + 60 })), 'PassTooLong');
  assert.equal((await check(await pass({ exp: now() + MAX_PASS_SECONDS - 5 }))).did, ALICE);
});

test('refused: signed by someone else\'s key (after looking the key up again), an unknown account', { skip }, async () => {
  const { check, pass, keys, lookups } = await setup();
  const stranger = await atp.crypto.Secp256k1Keypair.create();
  const forged = await atp.createServiceJwt({ iss: ALICE, aud: AUDIENCE, lxm: LOUNGE_ENTER, keypair: stranger });
  await refused(check(forged), 'BadJwtSignature');
  assert.deepEqual(lookups.slice(-2), [[ALICE, false], [ALICE, true]]);       // a rotated key gets a second look
  await refused(check(await atp.createServiceJwt({ iss: ALICE, aud: AUDIENCE, lxm: LOUNGE_ENTER, keypair: keys[BOB] })), 'BadJwtSignature');   // another kind of key
  await refused(check(await atp.createServiceJwt({ iss: 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', aud: AUDIENCE, lxm: LOUNGE_ENTER, keypair: stranger })), 'BadPass');
  // A tampered pass: the payload changed after signing.
  const good = await pass();
  const [h, p, s] = good.split('.');
  const body = JSON.parse(Buffer.from(p, 'base64url').toString());
  body.iss = BOB;
  await refused(check(`${h}.${Buffer.from(JSON.stringify(body)).toString('base64url')}.${s}`), 'BadJwtSignature');
  await refused(check(`${h}.${p}.${s.slice(0, -4)}AAAA`), 'BadJwtSignature');
});

test('refused: not an account (a bare did:key vouching for itself, a service), garbage, a used pass', { skip }, async () => {
  const { check, pass } = await setup();
  const self = await atp.crypto.Secp256k1Keypair.create();
  await refused(check(await atp.createServiceJwt({ iss: self.did(), aud: AUDIENCE, lxm: LOUNGE_ENTER, keypair: self })), 'NotAnAccount');
  await refused(check(await atp.createServiceJwt({ iss: `${ALICE}#atproto_labeler`, aud: AUDIENCE, lxm: LOUNGE_ENTER, keypair: self })), 'NotAnAccount');
  await refused(check(''), 'BadPass');
  await refused(check('a.b'), 'BadJwt');
  await refused(check('x'.repeat(5000)), 'BadPass');
  const once = await pass();
  assert.equal((await check(once)).did, ALICE);
  await refused(check(once), 'PassUsed');
  assert.equal((await check(await pass())).did, ALICE);                        // a fresh pass is fine
});

test('atproto-pass.js loads Bluesky\'s packages', { skip: (skip || process.env.DAISY_ATPROTO_BUNDLE) && 'needs the installed packages' }, async () => {
  const { atprotoPassChecker } = await import('../atproto-pass.js');
  const check = atprotoPassChecker();
  await assert.rejects(check('a.b.c'), (err) => typeof err.code === 'string');
});
