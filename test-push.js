// Unit test for the web push crypto. The key pair below is a throwaway used
// only by the tests: never set it in production, generate one with
// `node scripts/vapid.js` instead.
// Unit test for the web push crypto: encrypt a payload the way a push service
// expects, then decrypt it the way the browser would, and check the VAPID
// signature verifies. If this passes, real devices can read our pushes.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.VAPID_PUBLIC_KEY = 'BHgw_JqirB808txjRdewLXC3JIt6TfjAJA7gbNsoYSoeXALg24duLjXkSXjPVAIb7aim0u21dhygxXZzEtIhWDQ';
process.env.VAPID_PRIVATE_KEY = 'A2rn2rXBZ_oItt02TyYlkkZfSeaPdcPnw1K-gar8A4w';
process.env.VAPID_SUBJECT = 'mailto:test@example.com';
const push = await import('./lib/push.js');

const b64u = (b) => Buffer.from(b).toString('base64url');

// Stand in for a browser subscription: its own ECDH key pair plus an auth secret.
const ua = crypto.createECDH('prime256v1');
ua.generateKeys();
const authSecret = crypto.randomBytes(16);
const sub = { endpoint: 'https://push.example.com/abc', p256dh: b64u(ua.getPublicKey()), auth: b64u(authSecret) };

// What the browser does with the body it receives.
function decrypt(body, uaEcdh, auth) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen);
  const shared = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaEcdh.getPublicKey(), asPublic]);
  const ikm = crypto.hkdfSync('sha256', shared, auth, keyInfo, 32);
  const cek = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2, 'last-record delimiter');
  return plain.subarray(0, plain.length - 1).toString('utf8');
}

const payload = JSON.stringify({ title: 'Ana just passed you 💧', body: '900 ml vs your 500 ml today.', url: 'https://sip-squad.vercel.app' });
const body = push.encrypt(payload, sub.p256dh, sub.auth);
assert.equal(body.readUInt32BE(16), 4096, 'record size header');
assert.equal(body[20], 65, 'uncompressed public key length');
assert.equal(decrypt(body, ua, authSecret), payload, 'round trip');

// Two encryptions of the same payload must differ (fresh salt and ephemeral key).
assert.notEqual(push.encrypt(payload, sub.p256dh, sub.auth).toString('base64'), body.toString('base64'));

// A tampered body must not decrypt.
const tampered = Buffer.from(body); tampered[tampered.length - 1] ^= 1;
assert.throws(() => decrypt(tampered, ua, authSecret), /unable to authenticate|bad decrypt|Unsupported state/i);

// The VAPID header: check the JWT verifies against the advertised public key.
let captured;
global.fetch = async (url, opts) => { captured = { url, opts }; return { ok: true, status: 201, text: async () => '' }; };
assert.equal(await push.sendPush(sub, { hello: 'world' }), 'sent');
assert.equal(captured.url, sub.endpoint);
assert.equal(captured.opts.headers['content-encoding'], 'aes128gcm');

const [scheme, tPart, kPart] = captured.opts.headers.authorization.split(/\s+|,\s*/).filter(Boolean);
assert.equal(scheme, 'vapid');
const jwt = tPart.replace(/^t=/, '');
const advertised = kPart.replace(/^k=/, '');
assert.equal(advertised, process.env.VAPID_PUBLIC_KEY, 'k= is our public key');
const [h, p, s] = jwt.split('.');
assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
const claims = JSON.parse(Buffer.from(p, 'base64url'));
assert.equal(claims.aud, 'https://push.example.com', 'aud is the push service origin');
assert.equal(claims.sub, 'mailto:test@example.com');
assert.ok(claims.exp > Math.floor(Date.now() / 1000) && claims.exp <= Math.floor(Date.now() / 1000) + 24 * 3600, 'exp within 24h');

const pubRaw = Buffer.from(process.env.VAPID_PUBLIC_KEY, 'base64url');
const verifyKey = crypto.createPublicKey({ format: 'jwk',
  key: { kty: 'EC', crv: 'P-256', x: b64u(pubRaw.subarray(1, 33)), y: b64u(pubRaw.subarray(33, 65)) } });
assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: verifyKey, dsaEncoding: 'ieee-p1363' },
  Buffer.from(s, 'base64url')), 'VAPID signature verifies');

// A dead subscription is reported so the caller can drop it.
global.fetch = async () => ({ ok: false, status: 410, text: async () => 'gone' });
assert.equal(await push.sendPush(sub, {}), 'gone');
global.fetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
await assert.rejects(() => push.sendPush(sub, {}), /push 500/);

console.log('push crypto ok');
