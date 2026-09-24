// Sip Squad client. Plain JS, no build step.
const $ = (id) => document.getElementById(id);
const store = {
  get token() { try { return localStorage.getItem('token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('token', v) : localStorage.removeItem('token'); } catch {} },
  get who() { try { return localStorage.getItem('who') === 'all' ? 'all' : 'me'; } catch { return 'me'; } },
  set who(v) { try { localStorage.setItem('who', v); } catch {} },
};

// The sizes you can pick, plus your own usual cup if it is not one of them.
// Anything else means changing your usual cup size in settings.
const SIZES = [150, 200, 250, 300, 350, 400, 450, 500];
const sizes = () => (SIZES.includes(me.cup_ml) ? SIZES : [...SIZES, me.cup_ml].sort((a, b) => a - b));
const nearest = (ml) => sizes().reduce((best, s) => (Math.abs(s - ml) < Math.abs(best - ml) ? s : best));

// One picker of chips, used for logging, editing a cup and filling an old day.
function drawPicker(id, selected) {
  $(id).innerHTML = sizes().map((ml) => `
    <button class="chip${ml === selected ? ' on' : ''}" data-ml="${ml}">${ml}<small>ml</small></button>`).join('');
}
function onPick(id, handler) {
  $(id).addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    [...$(id).children].forEach((c) => c.classList.toggle('on', c === chip));
    handler(Number(chip.dataset.ml));
  });
}

let me = null, range = 'today', pollTimer = null;
let board = null, dayOpen = null, cupOpen = null;
let whoMode = store.who;

// A drinking day runs 4am to 4am in YOUR timezone. A glass at 1am belongs to
// the night before, not to a day you have not woken up into yet. Everything
// downstream (the ring, the board, the chart, the labels) reads the day from
// here, and the server stores whatever day the app sends, so this one constant
// moves the boundary everywhere.
const DAY_STARTS_AT = 4;
const localDay = (d = new Date()) => {
  const x = new Date(d.getTime() - DAY_STARTS_AT * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
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
  [...$('who-tabs').children].forEach((x) => x.classList.toggle('active', x.dataset.who === whoMode));
  $('who').textContent = me.name;
  $('goal-ml').textContent = me.goal_ml;
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

const RANGE_LABEL = { today: 'Today so far', week: 'This week, Sunday onwards', month: 'This month', all: 'Everything so far' };

function render(data) {
  const today = localDay();
  const mine = (data.days || []).find((r) => r.day === today && r.user_id === me.id);
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

  renderChart(data);

  // Recent cups
  const feed = data.feed || [];
  $('feed').innerHTML = feed.length ? feed.slice(0, 30).map((d) => `
    <button class="cup${d.photo_id ? '' : ' nophoto'}${d.user_id === me.id ? ' mine' : ''}"
      data-id="${d.id}" title="${esc(d.label || '')}">
      ${d.photo_id ? `<img src="/api/photo/${esc(d.photo_id)}" alt="" loading="lazy">`
                   : '<span class="drop">💧</span>'}
      <div class="cap"><b>${esc(d.name)} · ${d.ml} ml</b>${fmtDayShort(d.day)} ${fmtTime(d.created_at)}</div>
    </button>`).join('') : '<div class="empty">No cups logged in this range. Be the first.</div>';
}

// ------------------------------------------------- day by day, as a chart
const PLOT_H = 150;   // height of the bar area in pixels
const TICK_H = 20;    // the day label under each column
const MAX_COLS = 90;  // enough history to scroll through, not enough to choke

let chartKey = '', chartScroll = 0;

// Me first, then everyone else by name, so a bar keeps its position in a
// column from one day to the next.
const peopleOrder = (data) => (data.board || []).slice().sort((a, b) =>
  a.id === me.id ? -1 : b.id === me.id ? 1 : a.name.localeCompare(b.name));

function chartDays(data) {
  const today = localDay();
  let days = [];
  if (range === 'all') {
    days = [...new Set((data.days || []).map((d) => d.day))].sort();
    if (!days.includes(today)) days.push(today);
  } else {
    // Every day of the range up to today, so days with nothing are visible.
    for (let d = data.since; d <= today; d = dayShift(d, 1)) days.push(d);
  }
  return days.length > MAX_COLS ? days.slice(-MAX_COLS) : days;
}

const tickLabel = (day) => range === 'week'
  ? new Date(day + 'T12:00:00').toLocaleDateString([], { weekday: 'narrow' })
  : String(Number(day.slice(8, 10)));

function renderChart(data) {
  $('days-card').hidden = range === 'today';
  if (range === 'today') return;

  const today = localDay();
  const people = peopleOrder(data);
  const shown = whoMode === 'all' ? people : people.filter((p) => p.id === me.id);
  const by = new Map((data.days || []).map((r) => [`${r.day}|${r.user_id}`, r]));
  const days = chartDays(data);
  const val = (day, p) => (by.get(`${day}|${p.id}`) || {}).ml || 0;

  // Headroom above the tallest bar so the goal line is never at the very top.
  const top = Math.max(me.goal_ml, ...days.map((d) => Math.max(0, ...shown.map((p) => val(d, p))))) * 1.1;
  const colW = Math.max(24, 6 + shown.length * 13);

  const cols = days.map((day) => {
    const bars = shown.map((p) => {
      const ml = val(day, p);
      const h = ml ? Math.max(3, Math.round((ml / top) * PLOT_H)) : 0;
      return `<i class="bar${ml >= p.goal_ml ? ' hit' : ''}${p.id === me.id ? ' mine' : ''}"
        style="height:${h}px"></i>`;
    }).join('');
    return `<button class="col${day === today ? ' now' : ''}" data-day="${day}" style="--w:${colW}px"
      aria-label="${esc(fmtDayLong(day))}, ${val(day, me)} ml">
      <span class="bars" style="height:${PLOT_H}px">${bars}</span>
      <span class="tick">${esc(tickLabel(day))}</span>
    </button>`;
  }).join('');

  const key = `${range}|${whoMode}|${days.length}|${days[0]}`;
  const keep = key === chartKey ? chartScroll : null;

  $('chart').innerHTML = days.length ? `
    <div class="plot-wrap" id="plot-wrap"><div class="plot${shown.length === 1 ? ' solo' : ''}">${cols}</div></div>
    <div class="goal-line" style="bottom:${TICK_H + Math.round((me.goal_ml / top) * PLOT_H)}px">
      <span>${me.goal_ml}</span>
    </div>` : '<div class="empty">Nothing logged yet.</div>';

  const wrap = $('plot-wrap');
  if (wrap) {
    // Newest day is on the right, so start there unless you scrolled already.
    wrap.scrollLeft = keep === null ? wrap.scrollWidth : keep;
    wrap.addEventListener('scroll', () => { chartScroll = wrap.scrollLeft; });
  }
  chartKey = key;

  $('chart-note').textContent =
    (shown.length > 1 ? `Left to right in each day: ${shown.map((p) => p.name).join(', ')}. ` : '')
    + `The dashed line is your goal, ${me.goal_ml} ml. Green means it was met. `
    + 'Tap a day to add or fix your cups.';
}

$('chart').addEventListener('click', (e) => {
  const col = e.target.closest('.col');
  if (col) openDay(col.dataset.day);
});

$('who-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  whoMode = b.dataset.who;
  store.who = whoMode;
  [...$('who-tabs').children].forEach((x) => x.classList.toggle('active', x === b));
  if (board) renderChart(board);
});

// ------------------------------------------------------------- quick add
// The four sizes log straight away: tapping the number you meant is the
// confirmation. Anything else goes through Custom, which asks you to confirm.
let adding = false;

async function addCup(ml) {
  if (adding) return null;
  adding = true;
  $('quick-error').textContent = '';
  try {
    const { drink } = await api('POST', '/api/drinks', { day: localDay(), ml });
    toast(`+${drink.ml} ml 💧`);
    refresh();
    return drink;
  } catch (err) {
    $('quick-error').textContent = err.message;
    return null;
  } finally { adding = false; }
}

$('quick').addEventListener('click', (e) => {
  const b = e.target.closest('.qbtn');
  if (!b) return;
  if (b.id === 'quick-custom') { showCustom($('custom-wrap').hidden); return; }
  b.classList.add('on');
  setTimeout(() => b.classList.remove('on'), 350);
  addCup(Number(b.dataset.ml));
});

function showCustom(open) {
  $('custom-wrap').hidden = !open;
  $('quick-custom').classList.toggle('on', open);
  $('custom-ml').value = '';
  customTyped();
  if (open) $('custom-ml').focus();
}

// The confirm button only exists once there is a sensible number to add.
function customTyped() {
  const typed = $('custom-ml').value.trim();
  const ml = Math.round(Number(typed));
  const ok = typed !== '' && Number.isFinite(ml) && ml >= 30 && ml <= 3000;
  $('custom-add').hidden = !ok;
  if (ok) $('custom-add').textContent = `Add ${ml} ml`;
  $('custom-hint').textContent = typed !== '' && !ok ? 'Anything from 30 to 3000 ml.' : '';
}

$('custom-ml').addEventListener('input', customTyped);
$('custom-ml').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('custom-add').click(); }
});

$('custom-add').addEventListener('click', async () => {
  const ml = Math.round(Number($('custom-ml').value));
  if (!(ml >= 30 && ml <= 3000)) return;
  const btn = $('custom-add');
  btn.disabled = true; btn.textContent = 'Adding…';
  const drink = await addCup(ml);
  btn.disabled = false;
  if (drink) showCustom(false); else customTyped();
});

// ------------------------------------------------------------- ranges
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  range = b.dataset.range;
  [...$('tabs').children].forEach((x) => x.classList.toggle('active', x === b));
  refresh();
});

// ------------------------------------------------------------- one day
// What the whole board drank on one day, from the numbers already loaded.
function dayPeople(day) {
  const names = new Map((board && board.board || []).map((b) => [b.id, b.name]));
  return ((board && board.days) || [])
    .filter((r) => r.day === day)
    .sort((a, b) => b.ml - a.ml)
    .map((r) => `${names.get(r.user_id) || 'Someone'} ${r.ml} ml`)
    .join(' · ');
}

async function openDay(day) {
  dayOpen = day;
  $('day-error').textContent = '';
  $('day-title').textContent = fmtDayLong(day);
  $('day-people').textContent = dayPeople(day);
  $('day-cups').innerHTML = '<div class="empty">Loading…</div>';
  dayMl = nearest(me.cup_ml);
  drawPicker('day-picker', dayMl);
  $('day-add').textContent = `Add ${dayMl} ml to this day`;
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

let dayMl = 350;
onPick('day-picker', (ml) => { dayMl = ml; $('day-add').textContent = `Add ${ml} ml to this day`; });

$('day-add').addEventListener('click', async () => {
  const btn = $('day-add'); btn.disabled = true; $('day-error').textContent = '';
  try {
    await api('POST', '/api/drinks', { day: dayOpen, ml: dayMl });
    toast(`+${dayMl} ml`);
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
    await loadDay();
    refresh();
  } catch (err) { $('day-error').textContent = err.message; e.target.disabled = false; }
});

const closeDay = () => { $('day-sheet').hidden = true; dayOpen = null; };
$('day-close').addEventListener('click', closeDay);
$('day-sheet').addEventListener('click', (e) => { if (e.target === $('day-sheet')) closeDay(); });

// ------------------------------------------------------------- one cup
$('feed').addEventListener('click', (e) => {
  const el = e.target.closest('.cup');
  if (!el) return;
  const drink = ((board && board.feed) || []).find((d) => String(d.id) === el.dataset.id);
  if (!drink) return;
  if (drink.user_id !== me.id) { toast(`That is ${drink.name}'s cup.`); return; }
  openCup(drink);
});

let cupMl = 350;

function openCup(d) {
  cupOpen = d;
  cupMl = d.ml;
  $('cup-error').textContent = '';
  $('cup-title').textContent = fmtDayLong(d.day);
  $('cup-amount').textContent = `${d.ml} ml`;
  $('cup-sub').textContent = `Logged at ${fmtTime(d.created_at)}. Pick another size to change it.`;
  $('cup-img').hidden = !d.photo_id;
  if (d.photo_id) $('cup-img').src = `/api/photo/${d.photo_id}`;
  drawPicker('cup-picker', d.ml);
  $('cup-save').disabled = false;
  $('cup-sheet').hidden = false;
}

onPick('cup-picker', (ml) => {
  cupMl = ml;
  $('cup-amount').textContent = `${ml} ml`;
  $('cup-sub').textContent = ml === cupOpen.ml
    ? `Logged at ${fmtTime(cupOpen.created_at)}. Pick another size to change it.`
    : `Was ${cupOpen.ml} ml. Nothing changes until you tap Save.`;
});

// Nothing changes on the board until Save, same as logging.
$('cup-save').addEventListener('click', async () => {
  if (!cupOpen) return;
  if (cupMl === cupOpen.ml) { closeCup(); return; }
  const btn = $('cup-save'); btn.disabled = true; $('cup-error').textContent = '';
  const day = cupOpen.day;
  try {
    await api('PATCH', `/api/drinks/${cupOpen.id}`, { ml: cupMl });
    closeCup();
    toast('Changed');
    if (dayOpen === day) await loadDay();
    refresh();
  } catch (err) { $('cup-error').textContent = err.message; btn.disabled = false; }
});

$('cup-delete').addEventListener('click', async () => {
  if (!cupOpen) return;
  const btn = $('cup-delete'); btn.disabled = true; $('cup-error').textContent = '';
  const gone = cupOpen;
  try {
    await api('DELETE', `/api/drinks/${gone.id}`);
    closeCup();
    toast('Removed');
    if (dayOpen === gone.day) await loadDay();
    refresh();
  } catch (err) { $('cup-error').textContent = err.message; }
  finally { btn.disabled = false; }
});

const closeCup = () => { $('cup-sheet').hidden = true; cupOpen = null; };
$('cup-close').addEventListener('click', closeCup);
$('cup-sheet').addEventListener('click', (e) => { if (e.target === $('cup-sheet')) closeCup(); });

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
    closeSettings(); toast('Saved'); refresh();
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
