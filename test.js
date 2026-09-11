// End-to-end API test. Runs the dev server against the real Supabase project
// and walks the whole flow with a throwaway group. Usage: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import http from 'node:http';
import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import { webhookSecret } from './lib/telegram.js';

// Fake Telegram API that records what the app sends.
const sent = [];
const fakeTg = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  if (req.url.endsWith('/sendMessage')) sent.push(b);
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ok: true, result: req.url.endsWith('/getMe') ? { username: 'sipsquad_bot' } : {} }));
});

// Fake Twilio API that records the texts the app sends.
const texts = [];
const fakeTwilio = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const form = new URLSearchParams(Buffer.concat(chunks).toString());
  assert.match(req.headers.authorization || '', /^Basic /, 'twilio call is authenticated');
  assert.match(req.url, /^\/2010-04-01\/Accounts\/AC_test\/Messages\.json$/);
  texts.push({ to: form.get('To'), from: form.get('From'), body: form.get('Body') });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ sid: 'SM' + texts.length }));
});
await new Promise((r) => fakeTwilio.listen(3125, r));

// Fake push service. Holds a browser-style subscription key pair and decrypts
// each delivery, so the test proves a real device could read it.
const pushes = [];
const undecryptable = [];
const uaKeys = crypto.createECDH('prime256v1'); uaKeys.generateKeys();
const uaAuth = crypto.randomBytes(16);
const b64u = (b) => Buffer.from(b).toString('base64url');
// The app only accepts https endpoints, as real push services are, so the
// fake one gets a self-signed certificate and the app is told to trust it.
const fakeSubscription = (path) => ({ endpoint: `https://localhost:3127/${stamp}${path}`,
  keys: { p256dh: b64u(uaKeys.getPublicKey()), auth: b64u(uaAuth) } });
let pushStatus = 201;
const fakePush = https.createServer({
  key: fs.readFileSync('./test-fixtures/localhost-key.pem'),
  cert: fs.readFileSync('./test-fixtures/localhost-cert.pem'),
}, async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  if (pushStatus >= 400) { res.statusCode = pushStatus; return res.end('gone'); }
  // A real push service would just forward the bytes; decrypting here is how
  // the test proves a device could read them. Never throw: an undecryptable
  // delivery is a finding to assert on, not a crash.
  try {
    const salt = body.subarray(0, 16), idlen = body[20];
    const asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
    const ikm = crypto.hkdfSync('sha256', uaKeys.computeSecret(asPublic), uaAuth,
      Buffer.concat([Buffer.from('WebPush: info\0'), uaKeys.getPublicKey(), asPublic]), 32);
    const cek = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
    const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
    const dec = crypto.createDecipheriv('aes-128-gcm', Buffer.from(cek), Buffer.from(nonce));
    dec.setAuthTag(ct.subarray(ct.length - 16));
    const plain = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
    pushes.push({ path: req.url, auth: req.headers.authorization,
                  payload: JSON.parse(plain.subarray(0, plain.length - 1).toString('utf8')) });
  } catch (e) {
    undecryptable.push({ path: req.url, error: e.message });
  }
  res.statusCode = 201; res.end('');
});
await new Promise((r) => fakePush.listen(3127, r));
process.env.VAPID_PUBLIC_KEY = 'BHgw_JqirB808txjRdewLXC3JIt6TfjAJA7gbNsoYSoeXALg24duLjXkSXjPVAIb7aim0u21dhygxXZzEtIhWDQ';
process.env.VAPID_PRIVATE_KEY = 'A2rn2rXBZ_oItt02TyYlkkZfSeaPdcPnw1K-gar8A4w';
process.env.NODE_EXTRA_CA_CERTS = './test-fixtures/localhost-cert.pem';
process.env.TWILIO_ACCOUNT_SID = 'AC_test';
process.env.TWILIO_AUTH_TOKEN = 'secret';
process.env.TWILIO_FROM = '+15550000000';
process.env.TWILIO_API_BASE = 'http://127.0.0.1:3125';
process.env.APP_URL = 'https://sip-squad.example';
await new Promise((r) => fakeTg.listen(3124, r));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:3124';

// Everyone now shares one board, so a test run against the real project would
// put fake names on it. Point SUPABASE_URL at a scratch database instead.
if (!process.env.SUPABASE_URL && !process.env.SIP_TEST_ALLOW_PROD) {
  console.error('Refusing to run: this would add test accounts to the live board.\n' +
    'Set SUPABASE_URL to a scratch project, or SIP_TEST_ALLOW_PROD=1 to override.');
  process.exit(1);
}

const PORT = 3123;
const server = spawn(process.execPath, ['dev.js'], { env: { ...process.env, PORT, ANTHROPIC_API_KEY: '' }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const base = `http://127.0.0.1:${PORT}`;
const stamp = Date.now();
const group = `test-${stamp}`;
// Dates are relative so the suite does not break when the clock rolls over.
const noon = new Date(); noon.setUTCHours(12, 0, 0, 0);
const iso = (offsetDays) => new Date(noon.getTime() + offsetDays * 86400000).toISOString().slice(0, 10);
const TODAY = iso(0), YESTERDAY = iso(-1), LAST_WEEK = iso(-7);
// A distinct number per run: verified numbers are unique across the database.
const PHONE = `+1415555${String(Date.now()).slice(-4)}`;

const call = async (method, p, body, token) => {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-token': token } : {}) }, body: body && JSON.stringify(body) });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, data: await res.json().catch(() => null), setCookie };
};
const jpeg = 'data:image/jpeg;base64,' + Buffer.alloc(700, 1).toString('base64');

try {
  // Signing in takes a name and nothing else.
  const a = await call('POST', '/api/join', { name: `Ana ${stamp}` });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.match(a.setCookie, /^sip=.*HttpOnly/, 'session cookie set');
  assert.match(a.setCookie, /Max-Age=345[0-9]{5}/, 'cookie lasts about 400 days');
  assert.equal(a.data.user.group, 'everyone', 'one shared board');
  const b = await call('POST', '/api/join', { name: `Ben ${stamp}` });
  assert.equal((await call('POST', '/api/join', { name: `ana ${stamp}` })).data.token, a.data.token, 'same name, same account');
  assert.equal((await call('POST', '/api/join', { name: '' })).status, 400, 'a name is required');

  // Staying signed in: the cookie alone works, and every call slides it forward.
  const cookie = a.setCookie.split(';')[0];
  const viaCookieOnly = await fetch(`${base}/api/me`, { headers: { cookie } });
  assert.equal(viaCookieOnly.status, 200, 'cookie alone identifies you');
  assert.equal((await viaCookieOnly.json()).user.name, `Ana ${stamp}`);
  assert.match(viaCookieOnly.headers.get('set-cookie') || '', /^sip=.*Max-Age=345/, 'cookie renewed on use');
  // A client with only the header token gets a cookie back, so it survives losing storage.
  const viaHeaderOnly = await fetch(`${base}/api/me`, { headers: { 'x-token': a.data.token } });
  assert.match(viaHeaderOnly.headers.get('set-cookie') || '', /^sip=/, 'header-only session gains a cookie');

  assert.equal((await call('GET', '/api/me')).status, 401);
  // cookie alone is enough to stay signed in
  const viaCookie = await fetch(`${base}/api/me`, { headers: { cookie: a.setCookie.split(';')[0] } });
  assert.equal(viaCookie.status, 200);
  // One tap, no photo: that is the normal way to log a cup now.
  const tap = await call('POST', '/api/drinks', { photo: null, day: TODAY }, a.data.token);
  assert.equal(tap.status, 200, JSON.stringify(tap.data));
  assert.equal(tap.data.drink.ml, 350, 'counts as the default cup');
  assert.equal(tap.data.drink.source, 'default');
  assert.equal(tap.data.drink.photo_id, null, 'nothing stored');
  assert.equal((await call('DELETE', `/api/drinks/${tap.data.drink.id}`, null, a.data.token)).status, 200,
    'a photo-less cup can be removed');
  // a malformed photo is still refused
  assert.equal((await call('POST', '/api/drinks', { photo: 'nope' }, a.data.token)).status, 400);

  const d1 = await call('POST', '/api/drinks', { photo: jpeg, day: TODAY }, a.data.token);
  assert.equal(d1.status, 200, JSON.stringify(d1.data));
  assert.equal(d1.data.drink.ml, 350); assert.equal(d1.data.drink.source, 'default');
  const d2 = await call('POST', '/api/drinks', { photo: jpeg, day: TODAY, ml: 500 }, b.data.token);
  assert.equal(d2.data.drink.source, 'manual');
  await call('POST', '/api/drinks', { photo: jpeg, day: LAST_WEEK }, b.data.token);

  assert.equal((await call('PATCH', `/api/drinks/${d1.data.drink.id}`, { ml: 750 }, a.data.token)).data.drink.ml, 750);
  assert.equal((await call('PATCH', `/api/drinks/${d1.data.drink.id}`, { ml: 1 }, b.data.token)).status, 404);

  // The board is shared, so compare only this run's two players.
  const mine = (rows) => rows.filter((r) => r.name.endsWith(String(stamp)));
  const today = await call('GET', `/api/board?range=today&day=${TODAY}`, null, a.data.token);
  assert.deepEqual(mine(today.data.board).map((r) => [r.name, r.ml, r.cups, r.streak]),
    [[`Ana ${stamp}`, 750, 1, 0], [`Ben ${stamp}`, 500, 1, 0]]);
  const all = await call('GET', `/api/board?range=all&day=${TODAY}`, null, a.data.token);
  assert.deepEqual(mine(all.data.board).map((r) => [r.name, r.ml]), [[`Ben ${stamp}`, 850], [`Ana ${stamp}`, 750]]);
  const week = await call('GET', `/api/board?range=week&day=${TODAY}`, null, a.data.token);
  assert.equal(week.data.board.find((r) => r.name === `Ben ${stamp}`).ml, 500);

  // ---- month, and the per-day history behind the "Your days" list
  const month = await call('GET', `/api/board?range=month&day=${TODAY}`, null, a.data.token);
  assert.equal(month.data.range, 'month');
  assert.match(month.data.since, /^\d{4}-\d{2}-01$/, 'a month starts on the 1st');
  assert.ok(month.data.my_days.every((d) => d.cups >= 1), 'every history row carries a cup count');
  const todayRow = month.data.my_days.find((d) => d.day === TODAY);
  assert.equal(todayRow.ml, 750, 'my own total for today');
  assert.equal(todayRow.cups, 1);
  // an unknown range falls back to today rather than erroring
  assert.equal((await call('GET', '/api/board?range=nonsense', null, a.data.token)).data.range, 'today');

  // ---- editing an earlier day
  const dayView = await call('GET', `/api/day?day=${LAST_WEEK}`, null, b.data.token);
  assert.equal(dayView.status, 200);
  assert.equal(dayView.data.cups.length, 1, 'Ben logged one cup a week ago');
  const addedBack = await call('POST', '/api/drinks', { day: LAST_WEEK, ml: 400 }, b.data.token);
  assert.equal(addedBack.status, 200, 'a cup can be added to an earlier day');
  assert.equal(addedBack.data.drink.day, LAST_WEEK);
  const dayView2 = await call('GET', `/api/day?day=${LAST_WEEK}`, null, b.data.token);
  assert.deepEqual(dayView2.data.cups.map((c) => c.ml), [350, 400], 'in the order logged');
  assert.equal((await call('DELETE', `/api/drinks/${addedBack.data.drink.id}`, null, b.data.token)).status, 200);
  // the future is refused
  const future = await call('POST', '/api/drinks', { day: iso(3), ml: 350 }, b.data.token);
  assert.equal(future.status, 400, 'cannot log a cup in the future');
  // a day with nothing on it is an empty list, not an error
  assert.deepEqual((await call('GET', `/api/day?day=${iso(-30)}`, null, b.data.token)).data.cups, []);

  assert.equal((await call('PATCH', '/api/me', { cup_ml: 250, goal_ml: 3000 }, a.data.token)).data.user.cup_ml, 250);
  const d3 = await call('POST', '/api/drinks', { photo: jpeg, day: TODAY }, a.data.token);
  assert.equal(d3.data.drink.ml, 250);

  const photo = await fetch(`${base}/api/photo/${d1.data.drink.photo_id}`);
  assert.equal(photo.status, 200); assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.equal((await photo.arrayBuffer()).byteLength, 700);
  assert.equal((await fetch(`${base}/api/photo/00000000-0000-0000-0000-000000000000`)).status, 404);

  // streak: goal is 3000 by now; 3000 ml yesterday -> streak 1 shows on today's board
  const big = await call('POST', '/api/drinks', { photo: jpeg, day: YESTERDAY, ml: 3000 }, a.data.token);
  const withStreak = await call('GET', `/api/board?range=today&day=${TODAY}`, null, a.data.token);
  assert.equal(withStreak.data.board.find((r) => r.name === `Ana ${stamp}`).streak, 1, 'streak');
  await call('DELETE', `/api/drinks/${big.data.drink.id}`, null, a.data.token);

  // telegram: webhook rejects a bad secret, links a chat, posts a message when a cup is logged
  assert.equal((await fetch(`${base}/api/telegram`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'nope' }, body: '{}' })).status, 403);
  const hook = (text) => fetch(`${base}/api/telegram`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': webhookSecret() }, body: JSON.stringify({ message: { chat: { id: -100777 }, text } }) });
  assert.equal((await hook('/link everyone')).status, 200);
  assert.match(sent.pop().text, /Linked to <b>everyone<\/b>/);
  assert.equal((await call('GET', '/api/me', null, a.data.token)).data.user.telegram_linked, true);
  const d4 = await call('POST', '/api/drinks', { photo: jpeg, day: TODAY, ml: 300 }, a.data.token);
  const cupMsg = sent.pop();
  assert.equal(cupMsg.chat_id, -100777); assert.match(cupMsg.text, new RegExp(`Ana ${stamp}.*finished cup #3 \\(300 ml\\)`));
  await hook('/board');
  const boardMsg = sent.pop().text;
  assert.match(boardMsg, new RegExp(`Ana ${stamp}: <b>1300 ml</b> \\(3 cups\\)`), boardMsg);
  assert.match(boardMsg, new RegExp(`Ben ${stamp}: <b>500 ml</b> \\(1 cup\\)`), boardMsg);
  await hook('/unlink'); assert.match(sent.pop().text, /Unlinked/);
  await call('DELETE', `/api/drinks/${d4.data.drink.id}`, null, a.data.token);

  // ---- sms: verify a number, then get texted when a friend overtakes you
  assert.equal((await call('POST', '/api/phone', { phone: '555' }, b.data.token)).status, 400, 'bad number rejected');
  assert.equal(texts.length, 0);
  assert.equal((await call('POST', '/api/phone', { phone: PHONE.replace(/^(\+1)(\d{3})(\d{3})(\d{4})$/, '$1 ($2) $3-$4') }, b.data.token)).status, 200);
  const codeText = texts.pop();
  assert.equal(codeText.to, PHONE);
  assert.match(codeText.body, /Sip Squad: your code is \d{6}/);
  assert.match(codeText.body, /STOP/, 'opt-out language in the verification text');
  const code = /(\d{6})/.exec(codeText.body)[1];
  // a second request inside a minute is throttled, and a wrong code is refused
  assert.equal((await call('POST', '/api/phone', { phone: PHONE }, b.data.token)).status, 400, 'throttled');
  assert.equal((await call('POST', '/api/phone/confirm', { code: '000000' }, b.data.token)).status, 400, 'wrong code');
  const confirmed = await call('POST', '/api/phone/confirm', { code }, b.data.token);
  assert.equal(confirmed.data.user.phone_last4, PHONE.slice(-4));
  assert.equal(confirmed.data.user.sms_enabled, true);
  assert.equal(texts.length, 0, 'no extra texts while verifying');

  // Put Ben ahead of Ana on today's board, then let Ana overtake him.
  const totals = async () => Object.fromEntries((await call('GET', `/api/board?range=today&day=${TODAY}`, null, a.data.token))
    .data.board.map((r) => [r.name, r.ml]));
  const before = await totals();
  const ANA = `Ana ${stamp}`, BEN = `Ben ${stamp}`;
  const boost = await call('POST', '/api/drinks', { photo: jpeg, day: TODAY, ml: before[ANA] + 300 - before[BEN] }, b.data.token);
  assert.equal(texts.length, 0, 'Ben taking the lead does not text Ben');
  const benMl = before[ANA] + 300;
  const pass = await call('POST', '/api/drinks', { photo: jpeg, day: TODAY, ml: 500 }, a.data.token);
  const passText = texts.pop();
  assert.ok(passText, 'overtaking a friend sends one text');
  assert.equal(passText.to, PHONE);
  assert.equal(passText.from, '+15550000000');
  assert.equal(passText.body,
    `${ANA} just passed you on Sip Squad: ${before[ANA] + 500} ml vs your ${benMl} ml today. Your move: https://sip-squad.example`);
  assert.ok(passText.body.length <= 160, `one segment, got ${passText.body.length}`);

  // opting out stops the texts
  await call('POST', '/api/phone/toggle', { enabled: false }, b.data.token);
  const boost2 = await call('POST', '/api/drinks', { photo: jpeg, day: TODAY, ml: 400 }, b.data.token);  // Ben leads again
  const pass2 = await call('POST', '/api/drinks', { photo: jpeg, day: TODAY, ml: 500 }, a.data.token);   // Ana overtakes again
  assert.equal(texts.length, 0, 'opted out, no text');

  for (const [id, tok] of [[boost.data.drink.id, b.data.token], [boost2.data.drink.id, b.data.token],
                           [pass.data.drink.id, a.data.token], [pass2.data.drink.id, a.data.token]]) {
    assert.equal((await call('DELETE', `/api/drinks/${id}`, null, tok)).status, 200);
  }
  assert.equal((await call('DELETE', '/api/phone', null, b.data.token)).data.user.phone_last4, null);

  // ---- web push: subscribe two devices, then get notified when overtaken
  // The public key is derived from the private one, so a mistyped VAPID_PUBLIC_KEY cannot break it.
  const served = (await call('GET', '/api/push/key')).data.key;
  assert.equal(served.length, 87, 'a full 65-byte key');
  assert.equal(served, process.env.VAPID_PUBLIC_KEY, 'matches the pair in use');
  assert.equal((await call('POST', '/api/push/subscribe', { subscription: { endpoint: 'ftp://nope', keys: { p256dh: 'k', auth: 'a' } } }, b.data.token)).status, 400);
  const phone1 = fakeSubscription('/ben-phone'), laptop = fakeSubscription('/ben-laptop');
  const paths = (list) => new Set(list.map((x) => x.path.replace(`/${stamp}`, '')));
  assert.equal((await call('POST', '/api/push/subscribe', { subscription: phone1 }, b.data.token)).data.user.push_devices, 1);
  assert.equal((await call('POST', '/api/push/subscribe', { subscription: laptop }, b.data.token)).data.user.push_devices, 2);
  // re-subscribing the same endpoint does not duplicate it
  assert.equal((await call('POST', '/api/push/subscribe', { subscription: phone1 }, b.data.token)).data.user.push_devices, 2);

  // the test button reaches both devices
  assert.equal((await call('POST', '/api/push/test', null, b.data.token)).data.sent, 2);
  assert.equal(pushes.length, 2);
  assert.match(pushes[0].payload.title, /Sip Squad/);
  assert.match(pushes[0].auth, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/, 'signed with VAPID');
  pushes.length = 0;

  // Every cup notifies everyone else in the group, on each of their devices.
  const pBefore = await totals();
  const benCup = await call('POST', '/api/drinks', { photo: null, day: TODAY, ml: 250 }, b.data.token);
  assert.equal(pushes.length, 0, 'Ben has the only devices, so his own cup notifies nobody');
  const anaCup = await call('POST', '/api/drinks', { photo: null, day: TODAY, ml: 400 }, a.data.token);
  assert.equal(pushes.length, 2, 'both of Ben devices notified');
  assert.deepEqual(paths(pushes), new Set(['/ben-phone', '/ben-laptop']));
  assert.equal(pushes[0].payload.title, `${ANA} drank 400 ml 💧`);
  assert.match(pushes[0].payload.body, new RegExp(`^${pBefore[ANA] + 400} of \\d+ ml today`), pushes[0].payload.body);
  assert.equal(pushes[0].payload.url, 'https://sip-squad.example');
  pushes.length = 0;

  // a subscription the push service rejects is dropped automatically
  pushStatus = 410;
  assert.equal((await call('POST', '/api/push/test', null, b.data.token)).data.sent, 0);
  assert.equal((await call('GET', '/api/me', null, b.data.token)).data.user.push_devices, 0, 'dead devices dropped');
  pushStatus = 201;

  // unsubscribing removes the device
  await call('POST', '/api/push/subscribe', { subscription: phone1 }, b.data.token);
  assert.equal((await call('POST', '/api/push/unsubscribe', { endpoint: phone1.endpoint }, b.data.token)).data.user.push_devices, 0);
  // Nothing we sent to our own devices was unreadable.
  const mineUnreadable = undecryptable.filter((x) => x.path.startsWith(`/${stamp}`));
  assert.deepEqual(mineUnreadable, [], `undecryptable deliveries: ${JSON.stringify(mineUnreadable)}`);

  for (const [id, tok] of [[benCup.data.drink.id, b.data.token], [anaCup.data.drink.id, a.data.token]]) {
    assert.equal((await call('DELETE', `/api/drinks/${id}`, null, tok)).status, 200);
  }

  for (const d of [d1, d2, d3]) assert.equal((await call('DELETE', `/api/drinks/${d.data.drink.id}`, null, d === d2 ? b.data.token : a.data.token)).status, 200);
  const out = await call('POST', '/api/logout', null, a.data.token);
  assert.match(out.setCookie, /Max-Age=0/);
  console.log('all good (names', `Ana ${stamp} / Ben ${stamp})`);
} finally { server.kill(); fakeTg.close(); fakeTwilio.close(); fakePush.close(); }
