// Single Vercel function that handles every /api/* route (see vercel.json).
import { rpc, HttpError } from '../lib/db.js';
import { aiEnabled, estimateCupMl } from '../lib/estimate.js';
import * as tg from '../lib/telegram.js';
import * as sms from '../lib/sms.js';
import * as push from '../lib/push.js';

const COOKIE = 'sip';
const COOKIE_MAX_AGE = 400 * 24 * 3600;     // browsers cap cookies at 400 days
const MAX_BODY = 4 * 1024 * 1024;

// ---------------------------------------------------------------- helpers
function readCookie(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}
const tokenOf = (req) => readCookie(req) || (req.headers['x-token'] ? String(req.headers['x-token']) : null);

function requireToken(req) {
  const t = tokenOf(req);
  if (!t) throw new HttpError(401, 'Sign in first');
  return t;
}
const setCookie = (res, token) => res.setHeader('set-cookie',
  `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${token ? COOKIE_MAX_AGE : 0}; HttpOnly; Secure; SameSite=Lax`);

async function body(req) {
  if (req.body !== undefined && req.body !== null && typeof req.body === 'object') return req.body;
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'Photo too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Bad JSON')); }
    });
    req.on('error', reject);
  });
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isoDay = (s) => (ISO_DAY.test(s || '') ? s : new Date().toISOString().slice(0, 10));
const withAi = (user) => ({ ...user, ai: aiEnabled(), telegram: tg.telegramEnabled(), sms: sms.smsEnabled(), push: push.pushEnabled() });

// A photo is optional: most cups are logged with one tap and no camera.
function parsePhoto(dataUrl) {
  if (!dataUrl) return { mediaType: null, b64: null };
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new HttpError(400, 'That photo is not a format we can read');
  return { mediaType: `image/${m[1] === 'jpg' ? 'jpeg' : m[1]}`, b64: m[2] };
}

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

// Signing in is a name and nothing else: everyone shares one board.
route('POST', /^\/join$/, async (req, res) => {
  const b = await body(req);
  const out = await rpc('sip_join', { p_name: String(b.name || ''), p_group: b.group ? String(b.group) : null });
  setCookie(res, out.token);
  return { token: out.token, user: withAi(out.user) };
});

route('POST', /^\/logout$/, async (_req, res) => { setCookie(res, ''); return { ok: true }; });

route('GET', /^\/me$/, async (req) => ({ user: withAi(await rpc('sip_me', { p_token: requireToken(req) })) }));

route('PATCH', /^\/me$/, async (req) => {
  const b = await body(req);
  const num = (v) => (v === undefined || v === null || v === '' ? null : Math.round(Number(v)) || null);
  const user = await rpc('sip_update_me', { p_token: requireToken(req), p_cup_ml: num(b.cup_ml), p_goal_ml: num(b.goal_ml) });
  return { user: withAi(user) };
});

route('POST', /^\/drinks$/, async (req) => {
  const token = requireToken(req);
  const b = await body(req);
  const photo = parsePhoto(b.photo);
  let ml = null, source = null, label = null;
  if (b.ml) { ml = Math.round(Number(b.ml)); source = 'manual'; }
  else if (aiEnabled() && photo.b64) {
    const guess = await estimateCupMl(photo.b64, photo.mediaType).catch((e) => { console.error('estimate failed:', e.message); return null; });
    if (guess) { ml = guess.ml; source = 'ai'; label = guess.label; }
  }
  const drink = await rpc('sip_add_drink', {
    p_token: token, p_day: isoDay(b.day), p_ml: ml, p_source: source, p_label: label,
    p_media_type: photo.mediaType, p_photo_b64: photo.b64,
  });
  await Promise.all([
    tg.telegramEnabled() ? notifyCup(token, drink.id) : null,
    sms.smsEnabled() ? notifyPassed(token, drink.id) : null,
    push.pushEnabled() ? notifyPushCup(token, drink.id) : null,
  ]);
  return { drink };
});

// Best effort: a failed Telegram message must never fail the cup log.
async function notifyCup(token, drinkId) {
  try {
    const ctx = await rpc('sip_notify_context', { p_token: token, p_drink_id: drinkId });
    if (ctx && ctx.chat_id) await tg.send(ctx.chat_id, tg.cupMessage(ctx));
  } catch (e) { console.error('telegram notify failed:', e.message); }
}

// Text the friends this cup just overtook. Best effort, never fails the log.
async function notifyPassed(token, drinkId) {
  try {
    const passed = await rpc('sip_sms_passed', { p_token: token, p_drink_id: drinkId });
    await Promise.all((passed || []).map((p) =>
      sms.sendSms(p.phone, sms.passedText(p)).catch((e) => console.error('sms failed:', e.message))));
  } catch (e) { console.error('sms lookup failed:', e.message); }
}

// Tell the rest of the group about every cup. Dead subscriptions are dropped.
async function notifyPushCup(token, drinkId) {
  try {
    const targets = await rpc('sip_push_everyone', { p_token: token, p_drink_id: drinkId });
    await Promise.all((targets || []).map(async (t) => {
      try {
        const outcome = await push.sendPush(t, push.cupPayload(t, push.APP_URL()));
        if (outcome === 'gone') await rpc('sip_push_drop', { p_endpoint: t.endpoint });
      } catch (e) { console.error('push failed:', e.message); }
    }));
  } catch (e) { console.error('push lookup failed:', e.message); }
}

// ---- web push --------------------------------------------------------------
route('GET', /^\/push\/key$/, async () => {
  if (!push.pushEnabled()) throw new HttpError(404, 'Push is not set up');
  return { key: push.publicKey() };
});

route('POST', /^\/push\/subscribe$/, async (req) => {
  if (!push.pushEnabled()) throw new HttpError(404, 'Push is not set up');
  const b = await body(req);
  const sub = b.subscription || {};
  const user = await rpc('sip_push_subscribe', {
    p_token: requireToken(req), p_endpoint: String(sub.endpoint || ''),
    p_p256dh: String((sub.keys || {}).p256dh || ''), p_auth: String((sub.keys || {}).auth || ''),
  });
  return { user: withAi(user) };
});

route('POST', /^\/push\/unsubscribe$/, async (req) => {
  const b = await body(req);
  const user = await rpc('sip_push_unsubscribe', {
    p_token: requireToken(req), p_endpoint: b.endpoint ? String(b.endpoint) : null });
  return { user: withAi(user) };
});

// Sends a push to the caller's own devices so they can check it works.
route('POST', /^\/push\/test$/, async (req) => {
  if (!push.pushEnabled()) throw new HttpError(404, 'Push is not set up');
  const targets = await rpc('sip_push_mine', { p_token: requireToken(req) });
  let sent = 0;
  await Promise.all((targets || []).map(async (t) => {
    try {
      const outcome = await push.sendPush(t, { title: 'Sip Squad 💧', body: 'Notifications are working.', url: push.APP_URL() });
      if (outcome === 'gone') await rpc('sip_push_drop', { p_endpoint: t.endpoint });
      else sent += 1;
    } catch (e) { console.error('test push failed:', e.message); }
  }));
  return { sent };
});

// ---- phone number, verified by texting a code -------------------------------
route('POST', /^\/phone$/, async (req) => {
  if (!sms.smsEnabled()) throw new HttpError(404, 'Texts are not set up');
  const b = await body(req);
  const started = await rpc('sip_start_phone_verify', { p_token: requireToken(req), p_phone: String(b.phone || '') });
  try {
    await sms.sendSms(started.phone, sms.verifyText(started.code));
  } catch (e) {
    console.error('verify sms failed:', e.message);
    throw new HttpError(502, 'Could not text that number. Check it and try again.');
  }
  return { sent: true };
});

route('POST', /^\/phone\/confirm$/, async (req) => {
  const b = await body(req);
  return { user: withAi(await rpc('sip_confirm_phone', { p_token: requireToken(req), p_code: String(b.code || '') })) };
});

route('DELETE', /^\/phone$/, async (req) =>
  ({ user: withAi(await rpc('sip_remove_phone', { p_token: requireToken(req) })) }));

route('POST', /^\/phone\/toggle$/, async (req) => {
  const b = await body(req);
  return { user: withAi(await rpc('sip_set_sms', { p_token: requireToken(req), p_enabled: Boolean(b.enabled) })) };
});

// Telegram webhook: "/link <code>", "/unlink", "/board" sent in a group chat.
route('POST', /^\/telegram$/, async (req) => {
  if (!tg.telegramEnabled()) throw new HttpError(404, 'Telegram not configured');
  if (req.headers['x-telegram-bot-api-secret-token'] !== tg.webhookSecret()) throw new HttpError(403, 'Bad secret');
  const msg = (await body(req)).message;
  const text = (msg && msg.text || '').trim();
  const chatId = msg && msg.chat && msg.chat.id;
  const m = /^\/(link|unlink|board|today|start|help)(?:@\w+)?(?:\s+(.*))?$/s.exec(text);
  if (!chatId || !m) return { ok: true };
  const [, cmd, arg] = m;
  let reply;
  try {
    if (cmd === 'link') {
      const g = await rpc('sip_link_telegram', { p_code: arg || 'everyone', p_chat_id: chatId });
      reply = `Linked to <b>${g.code}</b> (${g.members} member${g.members === 1 ? '' : 's'}). Every finished cup will be posted here. Send /board for the leaderboard.`;
    } else if (cmd === 'unlink') {
      const g = await rpc('sip_unlink_telegram', { p_chat_id: chatId });
      reply = g.code ? `Unlinked from <b>${g.code}</b>.` : 'This chat was not linked.';
    } else if (cmd === 'board' || cmd === 'today') {
      const b = await rpc('sip_board_by_chat', { p_chat_id: chatId, p_day: isoDay(null) });
      reply = b ? tg.boardMessage(b) : 'This chat is not linked yet. Send /link here.';
    } else reply = 'Sip Squad bot. Commands: /link, /board, /unlink.';
  } catch (e) { reply = e instanceof HttpError ? e.message : 'Something broke.'; }
  await tg.send(chatId, reply).catch((e) => console.error('telegram reply failed:', e.message));
  return { ok: true };
});

// One-time webhook registration. Knowing the bot token proves you own the bot.
route('GET', /^\/telegram\/setup$/, async (req, _res, _m, url) => {
  if (!tg.telegramEnabled()) throw new HttpError(404, 'Set TELEGRAM_BOT_TOKEN on Vercel first');
  if (url.searchParams.get('token') !== process.env.TELEGRAM_BOT_TOKEN) throw new HttpError(403, 'Wrong token');
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  await tg.setWebhook(`https://${host}/api/telegram`);
  const me = await tg.getMe();
  return { ok: true, bot: `@${me.username}`, webhook: `https://${host}/api/telegram`, next: `Add @${me.username} to your Telegram group and send: /link` };
});

route('PATCH', /^\/drinks\/(\d+)$/, async (req, _res, m) => {
  const b = await body(req);
  return { drink: await rpc('sip_update_drink', { p_token: requireToken(req), p_id: Number(m[1]), p_ml: Math.round(Number(b.ml)) || 0 }) };
});

route('DELETE', /^\/drinks\/(\d+)$/, async (req, _res, m) =>
  rpc('sip_delete_drink', { p_token: requireToken(req), p_id: Number(m[1]) }));

route('GET', /^\/board$/, async (req, _res, _m, url) =>
  rpc('sip_board', { p_token: requireToken(req), p_range: url.searchParams.get('range') || 'today', p_day: isoDay(url.searchParams.get('day')) }));

route('GET', /^\/photo\/([0-9a-f-]{36})$/, async (_req, res, m) => {
  const photo = await rpc('sip_photo', { p_id: m[1] });
  if (!photo) throw new HttpError(404, 'No such photo');
  res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  return { raw: Buffer.from(photo.data, 'base64'), type: photo.media_type };
});

// ---------------------------------------------------------------- handler
export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
  res.setHeader('cache-control', 'no-store');
  try {
    for (const r of routes) {
      const m = r.method === req.method && r.pattern.exec(path);
      if (!m) continue;
      const out = await r.handler(req, res, m, url);
      // Slide the cookie forward on every authenticated call, so an app that
      // gets used never expires, and a header-only session gains a cookie.
      const token = tokenOf(req);
      if (token && !res.getHeader('set-cookie')) setCookie(res, token);
      if (out && out.raw) { res.setHeader('content-type', out.type); return res.status(200).end(out.raw); }
      res.setHeader('content-type', 'application/json');
      return res.status(200).end(JSON.stringify(out));
    }
    throw new HttpError(404, 'No such route');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    res.setHeader('content-type', 'application/json');
    res.status(e.status || 500).end(JSON.stringify({ error: e.status ? e.message : 'Something broke' }));
  }
}
