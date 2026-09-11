// Sip Squad client. Plain JS, no build step.
const $ = (id) => document.getElementById(id);
const store = {
  get token() { try { return localStorage.getItem('token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('token', v) : localStorage.removeItem('token'); } catch {} },
};

// The slider covers ordinary cups. Anything unusual is still possible by
// changing your usual cup size in settings.
const SLIDER = { min: 150, max: 500, step: 50, preset: 350 };
const snap = (ml) => Math.min(SLIDER.max, Math.max(SLIDER.min, Math.round(ml / SLIDER.step) * SLIDER.step));

let me = null, range = 'today', lastLogged = null, pollTimer = null;
let board = null, dayOpen = null;

// Local calendar day, so a cup at 11pm counts for today in YOUR timezone.
const localDay = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const dayShift = (iso, days) => {
  const d = new Date(iso + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return localDay(d);
};
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtDayShort = (day) => day === localDay() ? 'today'
  : day === dayShift(localDay(), -1) ? 'yest'
  : new Date(day + 'T12:00:00').toLocaleDateString([], { weekday: 'short' });
const fmtDayLong = (day) => day === localDay() ? 'Today'
  : day === dayShift(localDay(), -1) ? 'Yesterday'
  : new Date(day + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
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
    const { token, user } = await api('POST', '/api/join', { name: f.get('name') });
    store.token = token; me = user;
    enterHome();
  } catch (err) { $('join-error').textContent = err.message; }
});

function enterHome() {
  show('home');
  $('who').textContent = me.name;
  $('goal-ml').textContent = me.goal_ml;
  hint();
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 30000);
  document.addEventListener('visibilitychange', () => !document.hidden && refresh());
}

// ------------------------------------------------------------- data
async function refresh() {
  if (!me) return;
  try {
    board = await api('GET', `/api/board?range=${range}&day=${localDay()}`);
    render(board);
    $('status').textContent = '';
  } catch (err) {
    if (/sign in/i.test(err.message)) { store.token = null; me = null; show('join'); return; }
    $('status').textContent = err.message;
  }
}

const RANGE_LABEL = { today: 'Today so far', week: 'This week, Monday onwards', month: 'This month', all: 'Everything so far' };

function render(data) {
  const today = localDay();
  const byDay = new Map((data.my_days || []).map((d) => [d.day, d]));
  const mine = byDay.get(today);
  const todayMl = mine ? mine.ml : 0;
  const todayCups = mine ? mine.cups : 0;

  $('today-ml').textContent = todayMl;
  const myRow = (data.board || []).find((b) => b.id === me.id);
  const streak = myRow ? myRow.streak : 0;
  $('today-cups').textContent = (todayCups ? `${todayCups} cup${todayCups === 1 ? '' : 's'}` : 'no cups yet')
    + (streak > 0 ? ` · 🔥 ${streak}` : '');
  const ring = $('ring');
  ring.style.setProperty('--p', Math.min(100, Math.round((todayMl / me.goal_ml) * 100)));
  ring.classList.toggle('done', todayMl >= me.goal_ml);

  // Leaderboard
  $('range-label').textContent = RANGE_LABEL[range] || '';
  const max = Math.max(1, ...(data.board || []).map((b) => b.ml));
  $('board').innerHTML = (data.board || []).length ? data.board.map((b, i) => `
    <li class="${i === 0 && b.ml > 0 ? 'first' : ''} ${b.id === me.id ? 'me' : ''}">
      <div class="rank">${i === 0 && b.ml > 0 ? '🏆' : i + 1}</div>
      <div>
        <div class="name">${esc(b.name)}${b.streak > 0 ? ` <span class="streak">🔥${b.streak}</span>` : ''}</div>
        <div class="bar"><i style="width:${(b.ml / max) * 100}%"></i></div>
      </div>
      <div class="ml">${b.ml} ml<span class="cups">${b.cups} cup${b.cups === 1 ? '' : 's'}</span></div>
    </li>`).join('') : '<div class="empty">Nobody here yet.</div>';

  renderDays(data, byDay);

  // Recent cups
  const feed = data.feed || [];
  $('feed').innerHTML = feed.length ? feed.slice(0, 30).map((d) => `
    <div class="cup${d.photo_id ? '' : ' nophoto'}" title="${esc(d.label || '')}">
      ${d.photo_id ? `<img src="/api/photo/${esc(d.photo_id)}" alt="" loading="lazy">`
                   : '<span class="drop">💧</span>'}
      <div class="cap"><b>${esc(d.name)} · ${d.ml} ml</b>${fmtDayShort(d.day)} ${fmtTime(d.created_at)}</div>
    </div>`).join('') : '<div class="empty">No cups logged in this range. Be the first.</div>';
}

// The day-by-day breakdown under the leaderboard.
function renderDays(data, byDay) {
  $('days-card').hidden = range === 'today';
  if (range === 'today') return;

  const today = localDay();
  let days = [];
  if (range === 'all') {
    days = (data.my_days || []).map((d) => d.day);
  } else {
    // Every day of the range up to today, so blank days are visible too.
    for (let d = data.since; d <= today; d = dayShift(d, 1)) days.push(d);
    days.reverse();
  }

  $('days').innerHTML = days.length ? days.map((day) => {
    const row = byDay.get(day);
    const ml = row ? row.ml : 0;
    const cups = row ? row.cups : 0;
    const pct = Math.min(100, Math.round((ml / me.goal_ml) * 100));
    const hit = ml >= me.goal_ml;
    return `
      <button class="day${hit ? ' hit' : ''}${ml ? '' : ' none'}" data-day="${day}">
        <div>
          <div class="date">${esc(fmtDayLong(day))}</div>
          <div class="sub">${cups ? `${cups} cup${cups === 1 ? '' : 's'}` : 'nothing logged'}${hit ? ' · goal hit' : ''}</div>
        </div>
        <div class="amt">${ml} ml</div>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </button>`;
  }).join('') : '<div class="empty">Nothing logged yet.</div>';
}

$('days').addEventListener('click', (e) => {
  const btn = e.target.closest('.day');
  if (btn) openDay(btn.dataset.day);
});

// ------------------------------------------------------------- log a cup
function hint() {
  $('tap-hint').textContent = `One tap counts as ${me.cup_ml} ml. Slide to correct it after.`;
}

async function logCup(photo) {
  const btn = $('log-cup');
  btn.classList.add('busy');
  $('tap-hint').textContent = photo && me.ai ? 'Looking at your cup…' : 'Saving…';
  try {
    const { drink } = await api('POST', '/api/drinks', { photo, day: localDay() });
    showLogged(drink, photo);
    toast(`+${drink.ml} ml 💧`);
    refresh();
  } catch (err) { toast(err.message, 4000); }
  finally { btn.classList.remove('busy'); hint(); }
}

$('log-cup').addEventListener('click', () => logCup(null));

$('photo-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try { await logCup(await shrink(file)); }
  catch (err) { toast(err.message, 4000); }
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
  $('logged-img').hidden = !photoUrl;
  if (photoUrl) $('logged-img').src = photoUrl;
  const src = { ai: `Looks like ${drink.label || 'a cup'}`, default: 'Your usual cup', manual: 'Set by you' };
  $('logged-title').textContent = `${drink.ml} ml logged`;
  $('logged-sub').textContent = `${src[drink.source] || ''}. Slide to change it.`;
  $('logged-range').value = snap(drink.ml);
  $('logged-value').textContent = drink.ml;
  $('logged').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Show the number while dragging, save once the finger lifts.
$('logged-range').addEventListener('input', (e) => { $('logged-value').textContent = e.target.value; });
$('logged-range').addEventListener('change', async (e) => {
  if (!lastLogged) return;
  const ml = Number(e.target.value);
  try {
    const { drink } = await api('PATCH', `/api/drinks/${lastLogged.id}`, { ml });
    lastLogged = { ...lastLogged, ...drink };
    $('logged-title').textContent = `${drink.ml} ml logged`;
    $('logged-sub').textContent = 'Set by you. Slide to change it.';
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

// ------------------------------------------------------------- ranges
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  range = b.dataset.range;
  [...$('tabs').children].forEach((x) => x.classList.toggle('active', x === b));
  refresh();
});

// ------------------------------------------------------------- one day
async function openDay(day) {
  dayOpen = day;
  $('day-error').textContent = '';
  $('day-title').textContent = fmtDayLong(day);
  $('day-cups').innerHTML = '<div class="empty">Loading…</div>';
  $('day-range').value = SLIDER.preset;
  $('day-value').textContent = SLIDER.preset;
  $('day-sheet').hidden = false;
  await loadDay();
}

async function loadDay() {
  try {
    const data = await api('GET', `/api/day?day=${dayOpen}`);
    const cups = data.cups || [];
    const total = cups.reduce((n, c) => n + c.ml, 0);
    $('day-total').textContent = cups.length
      ? `${total} ml of ${data.goal_ml} ml, ${cups.length} cup${cups.length === 1 ? '' : 's'}`
      : 'Nothing logged on this day yet.';
    $('day-cups').innerHTML = cups.map((c) => `
      <div class="cup-row" data-id="${c.id}">
        <span class="when">${fmtTime(c.created_at)}</span>
        <span class="amt">${c.ml} ml</span>
        <button data-remove="${c.id}" aria-label="Remove this cup">✕</button>
      </div>`).join('');
  } catch (err) { $('day-error').textContent = err.message; }
}

$('day-range').addEventListener('input', (e) => { $('day-value').textContent = e.target.value; });

$('day-add').addEventListener('click', async () => {
  const btn = $('day-add'); btn.disabled = true; $('day-error').textContent = '';
  try {
    await api('POST', '/api/drinks', { day: dayOpen, ml: Number($('day-range').value) });
    toast('Added');
    await loadDay();
    refresh();
  } catch (err) { $('day-error').textContent = err.message; }
  finally { btn.disabled = false; }
});

$('day-cups').addEventListener('click', async (e) => {
  const id = e.target.dataset && e.target.dataset.remove;
  if (!id) return;
  e.target.disabled = true;
  try {
    await api('DELETE', `/api/drinks/${id}`);
    if (lastLogged && String(lastLogged.id) === String(id)) { $('logged').hidden = true; lastLogged = null; }
    await loadDay();
    refresh();
  } catch (err) { $('day-error').textContent = err.message; e.target.disabled = false; }
});

const closeDay = () => { $('day-sheet').hidden = true; dayOpen = null; };
$('day-close').addEventListener('click', closeDay);
$('day-sheet').addEventListener('click', (e) => { if (e.target === $('day-sheet')) closeDay(); });

// ------------------------------------------------------------- settings
$('settings-btn').addEventListener('click', () => {
  $('set-cup').value = me.cup_ml;
  $('set-goal').value = me.goal_ml;
  $('tg').hidden = !me.telegram;
  $('tg-status').textContent = me.telegram_linked
    ? 'Linked. Every cup is posted to your Telegram group. Send /board there for the leaderboard.'
    : 'Not linked. Add the Sip Squad bot to your Telegram group and send: /link';
  renderSms();
  renderPush();
  $('settings').hidden = false;
});
const closeSettings = () => { $('settings').hidden = true; };
$('settings-close').addEventListener('click', closeSettings);
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) closeSettings(); });

$('set-save').addEventListener('click', async () => {
  try {
    const { user } = await api('PATCH', '/api/me', { cup_ml: $('set-cup').value, goal_ml: $('set-goal').value });
    me = user;
    $('goal-ml').textContent = me.goal_ml;
    closeSettings(); hint(); toast('Saved'); refresh();
  } catch (err) { toast(err.message); }
});

$('logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  store.token = null; me = null; clearInterval(pollTimer);
  closeSettings(); show('join');
});

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
    ? 'On for this device. You get a notification whenever anyone in the group drinks.'
    : Notification.permission === 'denied'
      ? 'Notifications are blocked for this site in your browser settings. Allow them there, then come back.'
      : 'Get a notification whenever anyone drinks. Free, no texts.';
  if (Notification.permission !== 'denied') $('push-error').textContent = '';
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
    ? `Texting ••• ${me.phone_last4}. A text arrives when a friend overtakes you.`
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

// ------------------------------------------------------------- boot
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
(async () => {
  // Ask the server who we are even with no token in local storage: the session
  // cookie survives storage being cleared, so this is what keeps people signed
  // in. Only a real 401 sends anyone back to the name screen.
  try {
    me = (await api('GET', '/api/me')).user;
    enterHome();
  } catch (err) {
    if (!/sign in/i.test(err.message)) {
      // Offline or the server is unhappy: do not throw people out over it.
      $('status').textContent = err.message;
    }
    store.token = null;
    show('join');
  }
})();
