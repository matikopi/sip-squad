// End-to-end API test. Runs the dev server against the real Supabase project
// and walks the whole flow with a throwaway group. Usage: npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import http from 'node:http';
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
process.env.TWILIO_ACCOUNT_SID = 'AC_test';
process.env.TWILIO_AUTH_TOKEN = 'secret';
process.env.TWILIO_FROM = '+15550000000';
process.env.TWILIO_API_BASE = 'http://127.0.0.1:3125';
process.env.APP_URL = 'https://sip-squad.example';
await new Promise((r) => fakeTg.listen(3124, r));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:3124';

const PORT = 3123;
const server = spawn(process.execPath, ['dev.js'], { env: { ...process.env, PORT, ANTHROPIC_API_KEY: '' }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const base = `http://127.0.0.1:${PORT}`;
const group = `test-${Date.now()}`;
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
  const a = await call('POST', '/api/join', { name: 'Ana', group });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.match(a.setCookie, /^sip=.*HttpOnly/, 'session cookie set');
  const b = await call('POST', '/api/join', { name: 'Ben', group });
  assert.equal((await call('POST', '/api/join', { name: 'ana', group })).data.token, a.data.token, 'same account');

  assert.equal((await call('GET', '/api/me')).status, 401);
  // cookie alone is enough to stay signed in
  const viaCookie = await fetch(`${base}/api/me`, { headers: { cookie: a.setCookie.split(';')[0] } });
  assert.equal(viaCookie.status, 200);
  assert.equal((await call('POST', '/api/drinks', { photo: 'nope' }, a.data.token)).status, 400);

  const d1 = await call('POST', '/api/drinks', { photo: jpeg, day: TODAY }, a.data.token);
  assert.equal(d1.status, 200, JSON.stringify(d1.data));
  assert.equal(d1.data.drink.ml, 350); assert.equal(d1.data.drink.source, 'default');
  const d2 = await call('POST', '/api/drinks', { photo: jpeg, day: TODAY, ml: 500 }, b.data.token);
  assert.equal(d2.data.drink.source, 'manual');
  await call('POST', '/api/drinks', { photo: jpeg, day: LAST_WEEK }, b.data.token);

  assert.equal((await call('PATCH', `/api/drinks/${d1.data.drink.id}`, { ml: 750 }, a.data.token)).data.drink.ml, 750);
  assert.equal((await call('PATCH', `/api/drinks/${d1.data.drink.id}`, { ml: 1 }, b.data.token)).status, 404);

  const today = await call('GET', `/api/board?range=today&day=${TODAY}`, null, a.data.token);
  assert.deepEqual(today.data.board.map((r) => [r.name, r.ml, r.cups, r.streak]), [['Ana', 750, 1, 0], ['Ben', 500, 1, 0]]);
  const all = await call('GET', `/api/board?range=all&day=${TODAY}`, null, a.data.token);
  assert.deepEqual(all.data.board.map((r) => [r.name, r.ml]), [['Ben', 850], ['Ana', 750]]);
  const week = await call('GET', `/api/board?range=week&day=${TODAY}`, null, a.data.token);
  assert.equal(week.data.board.find((r) => r.name === 'Ben').ml, 500);

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
  assert.equal(withStreak.data.board.find((r) => r.name === 'Ana').streak, 1, 'streak');
  await call('DELETE', `/api/drinks/${big.data.drink.id}`, null, a.data.token);

  // telegram: webhook rejects a bad secret, links a chat, posts a message when a cup is logged
  assert.equal((await fetch(`${base}/api/telegram`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'nope' }, body: '{}' })).status, 403);
  const hook = (text) => fetch(`${base}/api/telegram`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': webhookSecret() }, body: JSON.stringify({ message: { chat: { id: -100777 }, text } }) });
  assert.equal((await hook(`/link ${group}`)).status, 200);
  assert.match(sent.pop().text, /Linked to <b>test-/);
  assert.equal((await call('GET', '/api/me', null, a.data.token)).data.user.telegram_linked, true);
  const d4 = await call('POST', '/api/drinks', { photo: jpeg, day: TODAY, ml: 300 }, a.data.token);
  const cupMsg = sent.pop();
  assert.equal(cupMsg.chat_id, -100777); assert.match(cupMsg.text, /Ana.*finished cup #3 \(300 ml\)/);
  await hook('/board');
  assert.match(sent.pop().text, /🏆 Ana/);
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
  const boost = await call('POST', '/api/drinks', { photo: jpeg, day: TODAY, ml: before.Ana + 300 - before.Ben }, b.data.token);
  assert.equal(texts.length, 0, 'Ben taking the lead does not text Ben');
  const benMl = before.Ana + 300;
  const pass = await call('POST', '/api/drinks', { photo: jpeg, day: TODAY, ml: 500 }, a.data.token);
  const passText = texts.pop();
  assert.ok(passText, 'overtaking a friend sends one text');
  assert.equal(passText.to, PHONE);
  assert.equal(passText.from, '+15550000000');
  assert.equal(passText.body,
    `Ana just passed you on Sip Squad: ${before.Ana + 500} ml vs your ${benMl} ml today. Your move: https://sip-squad.example`);
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

  for (const d of [d1, d2, d3]) assert.equal((await call('DELETE', `/api/drinks/${d.data.drink.id}`, null, d === d2 ? b.data.token : a.data.token)).status, 200);
  const out = await call('POST', '/api/logout', null, a.data.token);
  assert.match(out.setCookie, /Max-Age=0/);
  console.log('all good (group', group + ')');
} finally { server.kill(); fakeTg.close(); fakeTwilio.close(); }
