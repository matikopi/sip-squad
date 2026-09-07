// Web push notifications. No third party and no cost: the browser's own push
// service delivers them. Inert unless VAPID_PRIVATE_KEY is set (generate one
// with `node scripts/vapid.js`).
//
// Payloads are encrypted per RFC 8291 (aes128gcm) and requests are signed with
// a VAPID JWT per RFC 8292, both using only node:crypto.
import crypto from 'node:crypto';

const PRIV = () => process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = () => process.env.VAPID_SUBJECT || 'mailto:hello@sip-squad.app';

export const APP_URL = () => process.env.APP_URL || 'https://sip-squad.vercel.app';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const raw = (s) => Buffer.from(s, 'base64url');

// The public key is derived from the private one rather than read from its own
// environment variable. A VAPID key is 87 characters of base64url including
// hyphens and underscores, and a single character lost while copying it breaks
// every notification in a way that is painful to spot. Deriving it removes that
// whole class of mistake, so only VAPID_PRIVATE_KEY has to be set.
let cache = null;
function keys() {
  const priv = PRIV();
  if (!priv) return null;
  if (cache && cache.priv === priv) return cache;
  const scalar = raw(priv);
  if (scalar.length !== 32) throw new Error(`VAPID_PRIVATE_KEY should be 32 bytes, got ${scalar.length}`);
  const ec = crypto.createECDH('prime256v1');
  ec.setPrivateKey(scalar);
  const pub = ec.getPublicKey();
  const declared = process.env.VAPID_PUBLIC_KEY;
  const publicKey = b64u(pub);
  if (declared && declared !== publicKey) {
    console.warn('VAPID_PUBLIC_KEY does not match the private key; using the derived one.');
  }
  cache = { priv, publicKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  return cache;
}

export const pushEnabled = () => {
  try { return Boolean(keys()); } catch (e) { console.error(e.message); return false; }
};
export const publicKey = () => keys().publicKey;

function vapidKey() {
  const k = keys();
  return crypto.createPrivateKey({
    format: 'jwk',
    key: { kty: 'EC', crv: 'P-256', d: k.priv, x: k.x, y: k.y },
  });
}

function vapidHeader(endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT() }));
  // JOSE wants the raw r||s pair, not the DER encoding node produces by default.
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${body}`), { key: vapidKey(), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${body}.${b64u(sig)}, k=${publicKey()}`;
}

// RFC 8291: derive a content key from the shared ECDH secret and the
// subscription's auth secret, then encrypt one aes128gcm record.
export function encrypt(payload, p256dh, authSecret) {
  const uaPublic = raw(p256dh);
  const auth = raw(authSecret);
  const local = crypto.createECDH('prime256v1');
  local.generateKeys();
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = crypto.hkdfSync('sha256', shared, auth, keyInfo, 32);
  const salt = crypto.randomBytes(16);
  const cek = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
  // 0x02 marks the last record; there is only ever one here.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])),
                              cipher.final(), cipher.getAuthTag()]);

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// Returns 'sent', or 'gone' when the subscription is dead and should be dropped.
export async function sendPush(sub, payload) {
  const body = encrypt(JSON.stringify(payload), sub.p256dh, sub.auth);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidHeader(sub.endpoint),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '86400',
      urgency: 'normal',
    },
    body,
  });
  if (res.status === 404 || res.status === 410) return 'gone';
  if (!res.ok) throw new Error(`push ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  return 'sent';
}

export const passedPayload = (p, url) => ({
  title: `${p.passer} just passed you 💧`,
  body: `${p.passer_ml} ml vs your ${p.their_ml} ml today. Your move.`,
  url,
});

// Every cup anyone logs, sent to everyone else in the group.
export const cupPayload = (c, url) => ({
  title: `${c.name} drank ${c.ml} ml 💧`,
  body: `${c.today_ml} of ${c.goal_ml} ml today`
    + (c.leader && c.leader !== c.name ? `. ${c.leader} leads with ${c.leader_ml} ml.` : '.'),
  url,
});
