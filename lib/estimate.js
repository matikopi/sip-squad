// Ask Claude how big the cup in the photo is. Returns { ml, label } or null.
// Only used when ANTHROPIC_API_KEY is set; otherwise the caller falls back to
// the drinker's default cup size.
import Anthropic from '@anthropic-ai/sdk';

let client;

const PROMPT = `You are looking at a photo of a cup, glass, mug or bottle that someone
just finished drinking water from. Estimate the total capacity of the vessel in
millilitres. Use visual cues: hand size, table objects, typical sizes of common
vessels (espresso cup ~60, teacup ~200, standard glass ~250 to 350, mug ~350,
pint ~470, sports bottle ~500 to 1000). If several vessels are visible, pick the
one that is clearly the subject. Assume it was full and is now empty.

Reply with only a JSON object, no prose:
{"ml": <integer>, "label": "<short description, max 6 words>", "confidence": "low"|"medium"|"high"}`;

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

export async function estimateCupMl(photoBase64, mediaType) {
  client ??= new Anthropic();
  const res = await client.beta.messages.create({
    model: 'claude-opus-5',
    max_tokens: 300,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: photoBase64 } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });
  if (res.stop_reason === 'refusal') return null;
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  const parsed = JSON.parse(m[0]);
  const ml = Math.round(Number(parsed.ml));
  if (!Number.isFinite(ml) || ml <= 0) return null;
  return { ml, label: String(parsed.label || '').slice(0, 60) || null };
}
