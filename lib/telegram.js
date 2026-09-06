// Telegram group notifications. Inert unless TELEGRAM_BOT_TOKEN is set.
// Setup: create a bot with @BotFather, set TELEGRAM_BOT_TOKEN on Vercel, then
// open /api/telegram/setup?token=<the token> once to register the webhook.
// In a Telegram group: add the bot, send "/link <group code>".
import crypto from 'node:crypto';

const TOKEN = () => process.env.TELEGRAM_BOT_TOKEN || '';
const API = () => process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';

export const telegramEnabled = () => Boolean(TOKEN());
// Telegram echoes this header on every webhook call so we know it is really them.
export const webhookSecret = () => crypto.createHash('sha256').update('sip-squad:' + TOKEN()).digest('hex').slice(0, 40);

async function call(method, body) {
  const res = await fetch(`${API()}/bot${TOKEN()}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`telegram ${method}: ${data.description || res.status}`);
  return data.result;
}

export const send = (chatId, text) => call('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
export const setWebhook = (url) => call('setWebhook', { url, secret_token: webhookSecret(), allowed_updates: ['message'] });
export const getMe = () => call('getMe', {});

const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const flame = (n) => (n > 0 ? ` 🔥${n}` : '');

// Message for a freshly logged cup, from sip_notify_context.
export function cupMessage(c) {
  const lines = [`💧 <b>${esc(c.name)}</b> finished cup #${c.cups_today} (${c.ml} ml). ${c.today_ml} / ${c.goal_ml} ml today.`];
  if (c.goal_hit_now) lines.push(`🎯 Daily goal hit!${c.streak > 1 ? ` ${c.streak}-day streak 🔥` : ''}`);
  if (c.took_lead) lines.push(`👑 ${esc(c.name)} takes the lead.`);
  else if (c.leader_name && c.leader_name !== c.name && c.leader_ml > 0) lines.push(`Leader: ${esc(c.leader_name)} with ${c.leader_ml} ml.`);
  return lines.join('\n');
}

// Leaderboard for the "/board" command, from sip_board_by_chat.
export function boardMessage(b) {
  if (!b.board.length) return `Nobody in <b>${esc(b.code)}</b> yet.`;
  const rows = b.board.map((r, i) => `${i === 0 && r.ml > 0 ? '🏆' : `${i + 1}.`} ${esc(r.name)}: <b>${r.ml} ml</b> (${r.cups} cup${r.cups === 1 ? '' : 's'})${flame(r.streak)}`);
  return `<b>${esc(b.code)}</b> · ${b.day}\n${rows.join('\n')}`;
}
