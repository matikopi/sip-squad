// Generates a VAPID keypair for web push. Run once, then put the two lines
// into Vercel's environment variables.
import crypto from 'node:crypto';
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = privateKey.export({ format: 'jwk' });
const b = (s) => Buffer.from(s, 'base64url');
console.log('VAPID_PUBLIC_KEY=' + Buffer.concat([Buffer.from([4]), b(jwk.x), b(jwk.y)]).toString('base64url'));
console.log('VAPID_PRIVATE_KEY=' + jwk.d);
