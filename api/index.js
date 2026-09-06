// Single Vercel function that handles every /api/* route (see vercel.json).
import { rpc, HttpError } from '../lib/db.js';
import { aiEnabled, estimateCupMl } from '../lib/estimate.js';

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
const withAi = (user) => ({ ...user, ai: aiEnabled() });

function parsePhoto(dataUrl) {
  const m = /^data:image\/(jpeg|jpg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) throw new HttpError(400, 'A photo of the empty cup is required');
  return { mediaType: `image/${m[1] === 'jpg' ? 'jpeg' : m[1]}`, b64: m[2] };
}

// ---------------------------------------------------------------- routes
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('POST', /^\/join$/, async (req, res) => {
  const b = await body(req);
  const out = await rpc('sip_join', { p_name: String(b.name || ''), p_group: String(b.group || '') });
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
  else if (aiEnabled()) {
    const guess = await estimateCupMl(photo.b64, photo.mediaType).catch((e) => { console.error('estimate failed:', e.message); return null; });
    if (guess) { ml = guess.ml; source = 'ai'; label = guess.label; }
  }
  const drink = await rpc('sip_add_drink', {
    p_token: token, p_day: isoDay(b.day), p_ml: ml, p_source: source, p_label: label,
    p_media_type: photo.mediaType, p_photo_b64: photo.b64,
  });
  return { drink };
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
