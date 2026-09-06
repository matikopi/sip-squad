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
await new Promise((r) => fakeTg.listen(3124, r));
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
process.env.TELEGRAM_API_BASE = 'http://127.0.0.1:3124';

const PORT = 3123;
const server = spawn(process.execPath, ['dev.js'], { env: { ...process.env, PORT, ANTHROPIC_API_KEY: '' }, stdio: 'inherit' });
await new Promise((r) => setTimeout(r, 800));
const base = `http://127.0.0.1:${PORT}`;
const group = `test-${Date.now()}`;

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

  const d1 = await call('POST', '/api/drinks', { photo: jpeg, day: '2026-09-06' }, a.data.token);
  assert.equal(d1.status, 200, JSON.stringify(d1.data));
  assert.equal(d1.data.drink.ml, 350); assert.equal(d1.data.drink.source, 'default');
  const d2 = await call('POST', '/api/drinks', { photo: jpeg, day: '2026-09-06', ml: 500 }, b.data.token);
  assert.equal(d2.data.drink.source, 'manual');
  await call('POST', '/api/drinks', { photo: jpeg, day: '2026-08-30' }, b.data.token);

  assert.equal((await call('PATCH', `/api/drinks/${d1.data.drink.id}`, { ml: 750 }, a.data.token)).data.drink.ml, 750);
  assert.equal((await call('PATCH', `/api/drinks/${d1.data.drink.id}`, { ml: 1 }, b.data.token)).status, 404);

  const today = await call('GET', '/api/board?range=today&day=2026-09-06', null, a.data.token);
  assert.deepEqual(today.data.board.map((r) => [r.name, r.ml, r.cups, r.streak]), [['Ana', 750, 1, 0], ['Ben', 500, 1, 0]]);
  const all = await call('GET', '/api/board?range=all&day=2026-09-06', null, a.data.token);
  assert.deepEqual(all.data.board.map((r) => [r.name, r.ml]), [['Ben', 850], ['Ana', 750]]);
  const week = await call('GET', '/api/board?range=week&day=2026-09-06', null, a.data.token);
  assert.equal(week.data.board.find((r) => r.name === 'Ben').ml, 500);

  assert.equal((await call('PATCH', '/api/me', { cup_ml: 250, goal_ml: 3000 }, a.data.token)).data.user.cup_ml, 250);
  const d3 = await call('POST', '/api/drinks', { photo: jpeg, day: '2026-09-06' }, a.data.token);
  assert.equal(d3.data.drink.ml, 250);

  const photo = await fetch(`${base}/api/photo/${d1.data.drink.photo_id}`);
  assert.equal(photo.status, 200); assert.equal(photo.headers.get('content-type'), 'image/jpeg');
  assert.equal((await photo.arrayBuffer()).byteLength, 700);
  assert.equal((await fetch(`${base}/api/photo/00000000-0000-0000-0000-000000000000`)).status, 404);

  // streak: goal is 3000 by now; 3000 ml on the day before -> streak 1 shows on today's board
  const big = await call('POST', '/api/drinks', { photo: jpeg, day: '2026-09-05', ml: 3000 }, a.data.token);
  const withStreak = await call('GET', '/api/board?range=today&day=2026-09-06', null, a.data.token);
  assert.equal(withStreak.data.board.find((r) => r.name === 'Ana').streak, 1, 'streak');
  await call('DELETE', `/api/drinks/${big.data.drink.id}`, null, a.data.token);

  // telegram: webhook rejects a bad secret, links a chat, posts a message when a cup is logged
  assert.equal((await fetch(`${base}/api/telegram`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'nope' }, body: '{}' })).status, 403);
  const hook = (text) => fetch(`${base}/api/telegram`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': webhookSecret() }, body: JSON.stringify({ message: { chat: { id: -100777 }, text } }) });
  assert.equal((await hook(`/link ${group}`)).status, 200);
  assert.match(sent.pop().text, /Linked to <b>test-/);
  assert.equal((await call('GET', '/api/me', null, a.data.token)).data.user.telegram_linked, true);
  const d4 = await call('POST', '/api/drinks', { photo: jpeg, day: '2026-09-06', ml: 300 }, a.data.token);
  const cupMsg = sent.pop();
  assert.equal(cupMsg.chat_id, -100777); assert.match(cupMsg.text, /Ana.*finished cup #3 \(300 ml\)/);
  await hook('/board');
  assert.match(sent.pop().text, /🏆 Ana/);
  await hook('/unlink'); assert.match(sent.pop().text, /Unlinked/);
  await call('DELETE', `/api/drinks/${d4.data.drink.id}`, null, a.data.token);

  for (const d of [d1, d2, d3]) assert.equal((await call('DELETE', `/api/drinks/${d.data.drink.id}`, null, d === d2 ? b.data.token : a.data.token)).status, 200);
  const out = await call('POST', '/api/logout', null, a.data.token);
  assert.match(out.setCookie, /Max-Age=0/);
  console.log('all good (group', group + ')');
} finally { server.kill(); fakeTg.close(); }
