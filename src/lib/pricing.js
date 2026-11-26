/* The fast brain's provider: model ids, prices and the model list for the user's key.
   The provider is Google's Generative Language API, so the model ids below are Google's.
   Prices: USD per 1M tokens, paid Standard tier; output includes thinking tokens. They were read from the
   provider's pricing page on 2026-11-23 and change on the dates below, so they are an estimate: the bill is
   whatever the provider charges. On the free tier the cost is $0 (rate limited). */
import { settings } from './settings.js';

export const PRICES_CHECKED = '23.11.2026';
export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const PROVIDER_API = 'https://generativelanguage.googleapis.com/v1beta';
const API = PROVIDER_API;

/* [model id prefix, rows]; a row applies from its `from` date; tier = prompt size above which the second price applies */
const TABLE = [
  ['gemini-4-carbon', [{ in: 2, out: 10 }, { from: '2026-12-01', in: 4, out: 20 }], { free: false }],
  ['gemini-4-argon', [{ in: 2, out: 10 }, { from: '2026-12-01', in: 4, out: 20 }], { free: false }],
  ['gemini-4-neon', [{ in: 3, out: 15 }], { free: false }],
  ['gemini-4-hydrogen', [{ in: 1.5, out: 7.5 }], { free: true }],
  ['gemini-3.8-flash', [{ in: 0.75, out: 3.75 }, { from: '2027-01-01', in: 1.5, out: 7.5 }], { free: true }],
  ['gemini-3.6-flash', [{ in: 0.75, out: 3.75 }, { from: '2027-01-01', in: 1.5, out: 7.5 }], { free: true }],
  ['gemini-3.5-flash-lite', [{ in: 0.3, out: 2.5 }], { free: true }],
  ['gemini-3.1-pro', [{ in: 2, out: 12, tier: 200000, in2: 4, out2: 18 }], { free: false }],
  ['gemini-3.1-flash-lite', [{ in: 0.25, out: 1.5 }], { free: true }],
  ['gemini-3-flash', [{ in: 0.5, out: 3 }], { free: true, note: 'legacy' }],
  ['gemini-2.5-pro', [{ in: 1.25, out: 10, tier: 200000, in2: 2.5, out2: 15 }], { free: true, note: 'deprecated: מ-1.12.2026 מנותב ל-gemini-3.8-flash' }],
  ['gemini-2.5-flash-lite', [{ in: 0.1, out: 0.4 }], { free: true }],
  ['gemini-2.5-flash', [{ in: 0.3, out: 2.5 }], { free: true, note: 'deprecated: מ-1.12.2026 מנותב ל-gemini-3.5-flash-lite' }],
];

export function priceFor(model, date) {
  const id = String(model || '').replace(/^models\//, '');
  // longest matching prefix wins (…-2.5-flash-lite before …-2.5-flash)
  const hit = TABLE.filter(([p]) => id === p || id.startsWith(p + '-') || id.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0];
  if (!hit) return null;
  const day = (date || new Date()).toISOString().slice(0, 10);
  const row = hit[1].filter((r) => !r.from || r.from <= day).pop();
  return Object.assign({ model: hit[0] }, row, hit[2]);
}

/* cost of one request: prompt tokens in, output (+ thinking) tokens out */
export function cost(model, inTok, outTok) {
  const p = priceFor(model);
  if (!p) return null;
  const big = p.tier && inTok > p.tier;
  return (inTok * (big ? p.in2 : p.in) + outTok * (big ? p.out2 : p.out)) / 1e6;
}

export const usd = (v) => (v == null ? '—' : v === 0 ? '$0' : v < 0.001 ? '<$0.001' : v < 0.1 ? '$' + v.toFixed(3) : '$' + v.toFixed(2));
export const ktok = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));

/* the models this key can use for text generation */
let modelCache = null;
export async function listModels(force) {
  if (modelCache && !force) return modelCache;
  const key = (settings.brainKey || '').trim();
  if (!key) return [];
  const out = [];
  let page = '';
  for (let i = 0; i < 5; i++) {
    const r = await fetch(API + '/models?pageSize=200' + (page ? '&pageToken=' + encodeURIComponent(page) : ''), { headers: { 'x-goog-api-key': key } });
    if (!r.ok) { let m = 'HTTP ' + r.status; try { m = (await r.json()).error.message; } catch (e) { /* ignore */ } throw new Error(m); }
    const j = await r.json();
    (j.models || []).forEach((m) => {
      const id = m.name.replace(/^models\//, '');
      if (!(m.supportedGenerationMethods || []).includes('generateContent')) return;
      if (/embedding|tts|image|live|audio|aqa|robotics|lyria|veo|imagen|gemma|learnlm|translate/i.test(id)) return;
      out.push({ id, name: m.displayName || id, inputLimit: m.inputTokenLimit, price: priceFor(id) });
    });
    page = j.nextPageToken;
    if (!page) break;
  }
  // priced (known) models first, newest names first
  out.sort((a, b) => (!!b.price - !!a.price) || b.id.localeCompare(a.id));
  modelCache = out;
  return out;
}

/* the provider's own count of the prompt tokens (no generation) */
export async function countTokens(model, request) {
  const key = (settings.brainKey || '').trim();
  const r = await fetch(`${API}/models/${encodeURIComponent(model)}:countTokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({ generateContentRequest: Object.assign({ model: 'models/' + model }, request) }),
  });
  if (!r.ok) throw new Error('countTokens ' + r.status);
  const j = await r.json();
  return j.totalTokens || 0;
}
