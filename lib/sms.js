// Twilio SMS. Inert unless TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are set.
// Set either TWILIO_FROM (a number you own, e.g. +14155551234) or
// TWILIO_MESSAGING_SERVICE_SID (recommended by Twilio for production).
const SID = () => process.env.TWILIO_ACCOUNT_SID || '';
const AUTH = () => process.env.TWILIO_AUTH_TOKEN || '';
const FROM = () => process.env.TWILIO_FROM || '';
const SERVICE = () => process.env.TWILIO_MESSAGING_SERVICE_SID || '';
const API = () => process.env.TWILIO_API_BASE || 'https://api.twilio.com';

export const APP_URL = () => process.env.APP_URL || 'https://sip-squad.vercel.app';
export const smsEnabled = () => Boolean(SID() && AUTH() && (FROM() || SERVICE()));

export async function sendSms(to, body) {
  const form = new URLSearchParams({ To: to, Body: body });
  if (SERVICE()) form.set('MessagingServiceSid', SERVICE());
  else form.set('From', FROM());
  const res = await fetch(`${API()}/2010-04-01/Accounts/${SID()}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${SID()}:${AUTH()}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`twilio ${res.status}: ${data.message || 'send failed'}`);
  return data.sid;
}

// Kept under one 160-character SMS segment so each text costs one message.
export const verifyText = (code) =>
  `Sip Squad: your code is ${code}. It expires in 10 minutes. Reply STOP to stop texts.`;

export const passedText = (p) =>
  `${p.passer} just passed you on Sip Squad: ${p.passer_ml} ml vs your ${p.their_ml} ml today. Your move: ${APP_URL()}`;
