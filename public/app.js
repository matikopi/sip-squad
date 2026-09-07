// Sip Squad client. Plain JS, no build step.
const $ = (id) => document.getElementById(id);
const store = {
  get token() { try { return localStorage.getItem('token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('token', v) : localStorage.removeItem('token'); } catch {} },
};
let me = null, range = 'today', lastLogged = null, pollTimer = null;
const CHIP_SIZES = [150, 250, 350, 500, 750, 1000];

// Local calendar day, so a cup at 11pm counts for today in YOUR timezone.
const localDay = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDay = (day) => day === localDay() ? 'today' : new Date(day + 'T12:00:00').toLocaleDateString([], { weekday: 'short' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', ...(store.token ? { 'x-token': store.token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, ms = 2200) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), ms);
}

// ------------------------------------------------------------- screens
function show(screen) {
  $('join').hidden = screen !== 'join';
  $('home').hidden = screen !== 'home';
}

$('join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('join-error').textContent = '';
  try {
    const { token, user } = await api('POST', '/api/join', { name: f.get('name'), group: f.get('group') });
    store.token = token; me = user;
    enterHome();
  } catch (err) { $('join-error').textContent = err.message; }
});

function enterHome() {
  show('home');
  $('group-code').textContent = me.group;
  $('goal-ml').textContent = me.goal_ml;
  $('snap-hint').textContent = me.ai
    ? 'Snap the empty cup. The app guesses the size, you can adjust.'
    : `Snap the empty cup. Counts as ${me.cup_ml} ml unless you adjust.`;
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 30000);
  document.addEventListener('visibilitychange', () => !document.hidden && refresh());
}

// ------------------------------------------------------------- data
async function refresh() {
  if (!me) return;
  try {
    const data = await api('GET', `/api/board?range=${range}&day=${localDay()}`);
    render(data);
    $('status').textContent = '';
  } catch (err) {
    if (/sign in/i.test(err.message)) { store.token = null; me = null; show('join'); return; }
    $('status').textContent = err.message;
  }
}

function render({ board, feed, my_days }) {
  const today = localDay();
  const mine = (my_days || []).find((d) => d.day === today);
  const todayMl = mine ? mine.ml : 0;
  const todayCups = feed.filter((d) => d.user_id === me.id && d.day === today).length;
  const pct = Math.min(100, Math.round((todayMl / me.goal_ml) * 100));
  $('today-ml').textContent = todayMl;
  const myRow = board.find((b) => b.id === me.id);
  const streak = myRow ? myRow.streak : 0;
  $('today-cups').textContent = (todayCups ? `${todayCups} cup${todayCups === 1 ? '' : 's'}` : 'no cups yet') + (streak > 0 ? ` · 🔥 ${streak}-day streak` : '');
  const ring = $('ring');
  ring.style.setProperty('--p', pct);
  ring.classList.toggle('done', todayMl >= me.goal_ml);

  const max = Math.max(1, ...board.map((b) => b.ml));
  $('board').innerHTML = board.length ? board.map((b, i) => `
    <li class="${i === 0 && b.ml > 0 ? 'first' : ''} ${b.id === me.id ? 'me' : ''}">
      <div class="rank">${i === 0 && b.ml > 0 ? '🏆' : i + 1}</div>
      <div><div class="name">${esc(b.name)}${b.streak > 0 ? ` <span class="streak">🔥${b.streak}</span>` : ''}</div><div class="bar"><i style="width:${(b.ml / max) * 100}%"></i></div></div>
      <div class="ml">${b.ml} ml<span class="cups">${b.cups} cup${b.cups === 1 ? '' : 's'}</span></div>
    </li>`).join('') : '<div class="empty">Nobody here yet.</div>';

  $('feed').innerHTML = feed.length ? feed.slice(0, 30).map((d) => `
    <div class="cup" title="${esc(d.label || '')}">
      <img src="/api/photo/${esc(d.photo_id)}" alt="" loading="lazy">
      <div class="cap"><b>${esc(d.name)} · ${d.ml} ml</b>${fmtDay(d.day)} ${fmtTime(d.created_at)}</div>
    </div>`).join('') : '<div class="empty">No cups logged in this range. Be the first.</div>';
}

// ------------------------------------------------------------- snap a cup
$('photo-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const btn = document.querySelector('.snap');
  btn.classList.add('busy');
  $('snap-hint').textContent = me.ai ? 'Looking at your cup…' : 'Saving…';
  try {
    const photo = await shrink(file);
    const { drink } = await api('POST', '/api/drinks', { photo, day: localDay() });
    showLogged(drink, photo);
    toast(`+${drink.ml} ml 💧`);
    refresh();
  } catch (err) { toast(err.message, 4000); }
  finally {
    btn.classList.remove('busy');
    $('snap-hint').textContent = me.ai ? 'Snap the empty cup. The app guesses the size, you can adjust.'
                                       : `Snap the empty cup. Counts as ${me.cup_ml} ml unless you adjust.`;
  }
});

// Downscale on-device so uploads are ~100 KB instead of ~4 MB phone photos.
function shrink(file, max = 800) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.75));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo')); };
    img.src = url;
  });
}

function showLogged(drink, photoUrl) {
  lastLogged = drink;
  $('logged').hidden = false;
  $('logged-img').src = photoUrl;
  const srcText = { ai: `Looks like ${drink.label || 'a cup'}`, default: 'Your default cup', manual: 'Set by you' }[drink.source] || '';
  $('logged-title').textContent = `${drink.ml} ml logged`;
  $('logged-sub').textContent = `${srcText}. Tap a size if it's off.`;
  const sizes = CHIP_SIZES.includes(drink.ml) ? CHIP_SIZES : [...CHIP_SIZES, drink.ml].sort((a, b) => a - b);
  $('logged-chips').innerHTML = sizes.map((ml) =>
    `<button data-ml="${ml}" class="${ml === drink.ml ? 'active' : ''}">${ml}</button>`).join('');
  $('logged').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

$('logged-chips').addEventListener('click', async (e) => {
  const ml = Number(e.target.dataset.ml);
  if (!ml || !lastLogged) return;
  try {
    const { drink } = await api('PATCH', `/api/drinks/${lastLogged.id}`, { ml });
    lastLogged = { ...lastLogged, ...drink };
    $('logged-title').textContent = `${drink.ml} ml logged`;
    $('logged-sub').textContent = 'Set by you.';
    [...$('logged-chips').children].forEach((b) => b.classList.toggle('active', Number(b.dataset.ml) === ml));
    refresh();
  } catch (err) { toast(err.message); }
});
$('logged-undo').addEventListener('click', async () => {
  if (!lastLogged) return;
  try { await api('DELETE', `/api/drinks/${lastLogged.id}`); toast('Removed'); }
  catch (err) { toast(err.message); }
  $('logged').hidden = true; lastLogged = null; refresh();
});
$('logged-done').addEventListener('click', () => { $('logged').hidden = true; lastLogged = null; });

// ------------------------------------------------------------- tabs & settings
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  range = b.dataset.range;
  [...$('tabs').children].forEach((x) => x.classList.toggle('active', x === b));
  refresh();
});

$('settings-btn').addEventListener('click', () => {
  $('set-cup').value = me.cup_ml; $('set-goal').value = me.goal_ml;
  $('set-cup-hint').textContent = me.ai ? 'Used only if the photo guess fails.' : 'Every cup counts as this unless you adjust it.';
  $('tg').hidden = !me.telegram;
  $('tg-status').textContent = me.telegram_linked
    ? 'Linked. Every finished cup is posted to your Telegram group. Send /board there for the leaderboard.'
    : `Not linked. Add the Sip Squad bot to your Telegram group and send: /link ${me.group}`;
  renderSms();
  renderPush();
  $('settings').hidden = false;
});
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').hidden = true; });

// ---- push notifications ----------------------------------------------------
const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function currentSub() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function renderPush() {
  $('push').hidden = !me.push;
  if (!me.push) return;
  const err = $('push-error');
  if (!pushSupported()) {
    $('push-status').textContent = 'This browser cannot do notifications. On an iPhone, add the app to your home screen first, then open it from there.';
    $('push-on').hidden = true; $('push-test').hidden = true;
    return;
  }
  const sub = await currentSub();
  const on = Boolean(sub) && Notification.permission === 'granted';
  $('push-on').textContent = on ? 'Turn off' : 'Turn on';
  $('push-on').hidden = false;
  $('push-test').hidden = !on;
  $('push-status').textContent = on
    ? 'On for this device. You get a notification when a friend overtakes you.'
    : Notification.permission === 'denied'
      ? 'Notifications are blocked in your browser settings for this site. Allow them there, then come back.'
      : 'Get a notification on this device when a friend overtakes you. Free, no texts.';
  if (Notification.permission !== 'denied') err.textContent = '';
}

// The browser wants the VAPID key as bytes, not base64url text.
const urlB64ToBytes = (s) => {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
};

$('push-on').addEventListener('click', async () => {
  const btn = $('push-on'); btn.disabled = true; $('push-error').textContent = '';
  try {
    const existing = await currentSub();
    if (existing && Notification.permission === 'granted') {
      await api('POST', '/api/push/unsubscribe', { endpoint: existing.endpoint }).catch(() => {});
      await existing.unsubscribe();
      toast('Notifications off');
    } else {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('You did not allow notifications');
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { key } = await api('GET', '/api/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToBytes(key) });
      const { user } = await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
      me = user;
      toast('Notifications on 🔔');
    }
  } catch (err) { $('push-error').textContent = err.message; }
  finally { btn.disabled = false; renderPush(); }
});

$('push-test').addEventListener('click', async () => {
  const btn = $('push-test'); btn.disabled = true; $('push-error').textContent = '';
  try {
    const { sent } = await api('POST', '/api/push/test');
    toast(sent ? 'Test sent' : 'No devices to send to');
  } catch (err) { $('push-error').textContent = err.message; }
  finally { btn.disabled = false; }
});

// ---- text messages ---------------------------------------------------------
function renderSms() {
  $('sms').hidden = !me.sms;
  if (!me.sms) return;
  const verified = Boolean(me.phone_last4);
  $('sms-add').hidden = verified || me.phone_pending;
  $('sms-confirm').hidden = !me.phone_pending;
  $('sms-on').hidden = !verified;
  $('sms-toggle').checked = me.sms_enabled;
  $('sms-status').textContent = verified
    ? `Texting ••• ${me.phone_last4}. You get a text when a friend overtakes you, with a link to log a cup.`
    : me.phone_pending ? 'Enter the code we just texted you.'
    : 'Add your number and we will text you when a friend overtakes you. Standard rates apply.';
  $('sms-error').textContent = '';
}

async function smsCall(method, path, payload, btn) {
  $('sms-error').textContent = '';
  if (btn) btn.disabled = true;
  try {
    const out = await api(method, path, payload);
    if (out.user) me = out.user;
    return out;
  } catch (err) { $('sms-error').textContent = err.message; throw err; }
  finally { if (btn) btn.disabled = false; renderSms(); }
}

$('sms-send').addEventListener('click', async () => {
  const phone = $('sms-phone').value.trim();
  if (!phone) { $('sms-error').textContent = 'Enter your number'; return; }
  try { await smsCall('POST', '/api/phone', { phone }, $('sms-send')); me.phone_pending = true; renderSms(); toast('Code sent'); }
  catch {}
});
$('sms-ok').addEventListener('click', async () => {
  try { await smsCall('POST', '/api/phone/confirm', { code: $('sms-code').value }, $('sms-ok')); toast('Texts on 📲'); }
  catch {}
});
$('sms-cancel').addEventListener('click', async () => {
  try { await smsCall('DELETE', '/api/phone', null, $('sms-cancel')); } catch {}
});
$('sms-remove').addEventListener('click', async () => {
  try { await smsCall('DELETE', '/api/phone', null, $('sms-remove')); toast('Number removed'); } catch {}
});
$('sms-toggle').addEventListener('change', async () => {
  try { await smsCall('POST', '/api/phone/toggle', { enabled: $('sms-toggle').checked }, null); } catch {}
});
$('set-save').addEventListener('click', async () => {
  try {
    const { user } = await api('PATCH', '/api/me', { cup_ml: $('set-cup').value, goal_ml: $('set-goal').value });
    me = user; $('settings').hidden = true; $('goal-ml').textContent = me.goal_ml;
    toast('Saved'); refresh();
  } catch (err) { toast(err.message); }
});
$('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  store.token = null; me = null; clearInterval(pollTimer);
  $('settings').hidden = true; show('join');
});

// ------------------------------------------------------------- boot
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
(async () => {
  if (!store.token) return show('join');
  try { me = (await api('GET', '/api/me')).user; enterHome(); }
  catch { store.token = null; show('join'); }
})();
