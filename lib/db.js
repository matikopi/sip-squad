// Thin PostgREST RPC client. Every database action is a public.sip_* function
// that validates the caller's token itself, so the publishable key is enough.
const URL_ = process.env.SUPABASE_URL || 'https://gygcihfwpdozrvaegijf.supabase.co';
const KEY = process.env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_Nzjqf073J4P7FDfVMGZcRQ_RpGlEXK1';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Postgres error codes raised by the sip_* functions -> HTTP status.
const STATUS = { '28000': 401, P0001: 400, P0002: 404, '22007': 400, '22008': 400, '22P02': 400 };

export async function rpc(fn, args) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (res.ok) return res.status === 204 ? null : res.json();
  const err = await res.json().catch(() => ({}));
  const status = STATUS[err.code];
  if (!status) console.error(`rpc ${fn} failed:`, res.status, err);
  throw new HttpError(status || 502, status ? err.message : 'Database error');
}
