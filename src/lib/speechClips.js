/* Speech clips (starters / reactions), through the local server (server/speech-clips.js).
   The agency is added on the server; the browser names the kind, the voice and the text. */
import CF from './core.js';
import { settings } from './settings.js';

export const KINDS = {
  starter: {
    title: 'Starters', he: 'פתיחי תשובה',
    sub: 'המילים הראשונות בתשובה של הסוכן ("הבנתי,", "שאלה טובה,"). הן מתנגנות מיד כשהלקוח מסיים לדבר, בזמן שהמודל עוד כותב את ההמשך.',
    clipsSub: 'קטע לכל נוסח. נוסח בלי קטע בקול של השיחה נאמר בכל זאת, ונוצר בזמן השיחה ב-Cartesia (קצת יותר לאט).',
  },
  reaction: {
    title: 'Reactions', he: 'תגובות בזמן שהלקוח מדבר',
    sub: 'צליל קצר שהסוכן משמיע בזמן שהלקוח עוד מדבר ("מממ", "אוי...", צחוק).',
    clipsSub: 'קטע לכל נוסח. לתגובה בלי קטע בקול של השיחה לא מתנגן כלום.',
  },
};
export const REQUIRED = { starter: ['understood', 'understood_long', 'great_question', 'good_question'], reaction: ['understood'] };
export const NOTES = {
  understood_long: 'נבחרת במקום understood אחרי שהלקוח אמר 12 מילים או יותר. המנוע לא בוחר בה בעצמו, אבל היא צריכה תיאור.',
  'reaction:understood': 'ה"מממ" שמתנגן באקראי ככל שהלקוח מדבר יותר. צריך לפחות 2 נוסחים.',
  great_question: 'אם המנוע בחר פתיח של שאלה אבל אין "?" בדברי הלקוח, השיחה משתמשת ב-understood.',
  good_question: 'אם המנוע בחר פתיח של שאלה אבל אין "?" בדברי הלקוח, השיחה משתמשת ב-understood.',
};
export const NAME = /^[a-z][a-z0-9_]*$/;
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* what the server would refuse, said in Hebrew next to the table (the server's own text is shown too, as is) */
export function tableProblems(kind, table) {
  const out = [];
  const names = new Set();
  table.forEach((o, i) => {
    const label = o.name || 'אפשרות ' + (i + 1);
    if (o.name === 'none') out.push('none שמורה ל-AIServant. אי אפשר להוסיף אותה.');
    else if (!NAME.test(o.name || '')) out.push('"' + label + '": שם באותיות אנגליות קטנות, ספרות ו-_, ומתחיל באות.');
    if (names.has(o.name)) out.push('השם "' + o.name + '" מופיע פעמיים.');
    names.add(o.name);
    if (!(o.description || '').trim()) out.push('"' + label + '": חסר תיאור.');
    if (!(o.texts || []).some((t) => (t || '').trim())) out.push('"' + label + '": צריך לפחות נוסח אחד.');
  });
  REQUIRED[kind].filter((n) => !names.has(n)).forEach((n) => out.push('חסרה האפשרות החובה ' + n + '.'));
  const u = table.find((o) => o.name === 'understood');
  if (kind === 'reaction' && u && u.texts.filter((t) => (t || '').trim()).length < 2) out.push('understood צריכה לפחות 2 נוסחים.');
  return out;
}
/* unsaved table edits, kept while switching between starters and reactions */
export const drafts = {};
export const cleanTable = (table) => table.map((o) => ({ name: (o.name || '').trim(), description: (o.description || '').trim(), texts: (o.texts || []).map((t) => (t || '').trim()).filter(Boolean) }));

async function req(url, opts) {
  const r = await fetch(url, opts);
  let body = null;
  try { body = await r.json(); } catch (e) { /* not JSON */ }
  if (!r.ok) throw Object.assign(new Error((body && (body.error || body.message)) || 'HTTP ' + r.status), { status: r.status });
  return body;
}
const J = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const B = './local-api/speech/';
export const speechConfig = () => req(B + 'config');
export const getTable = (kind) => req(B + kind + '/table');
export const putTable = (kind, table) => req(B + kind + '/table', J('PUT', table));
export const clipStatus = (voice, kind, texts) => req(B + voice + '/' + kind + '/status', J('POST', { texts })).then((r) => r.status);
export const clipUrl = (voice, kind, text, v) => B + voice + '/' + kind + '/clip?text=' + encodeURIComponent(text) + (v ? '&v=' + v : '');
export const savedWords = (voice, kind, text) => req(B + voice + '/' + kind + '/timestamps?text=' + encodeURIComponent(text)).then((r) => r.timestamps).catch(() => null);
export const putClip = (voice, kind, text, audioB64, timestamps) => req(B + voice + '/' + kind + '/clip', J('PUT', { text, audio: audioB64, timestamps }));
export async function speak(voice, text, speed) {
  const r = await req(B + 'tts', J('POST', { voice, text, speed }));
  const bin = atob(r.audio);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { blob: new Blob([bytes], { type: 'audio/wav' }), timestamps: r.timestamps };
}

/* the voices the studio knows (Cartesia voice ids are GUIDs): each agent's, the settings default, and ids typed here */
const LS = 'cf.clipVoices';
const lsGet = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } };
export function knownVoices() {
  const out = [];
  const add = (id, label) => {
    id = (id || '').trim().toLowerCase();
    if (!GUID.test(id)) return;
    const have = out.find((x) => x.id === id);
    if (have) { if (label && !have.labels.includes(label)) have.labels.push(label); return; }
    out.push({ id, labels: label ? [label] : [] });
  };
  (CF.ws.agents || []).forEach((a) => add(a.cartesiaVoiceId, a.name || 'סוכן'));
  add(settings.voiceId, 'ברירת המחדל בהגדרות');
  lsGet(LS, []).forEach((id) => add(id, ''));
  return out;
}
export function rememberVoice(id) { lsSet(LS, [id.toLowerCase()].concat(lsGet(LS, []).filter((x) => x !== id.toLowerCase())).slice(0, 20)); }
export function forgetVoice(id) { lsSet(LS, lsGet(LS, []).filter((x) => x !== id)); }
export const lastVoice = () => lsGet('cf.clipVoice', '');
export const setLastVoice = (id) => lsSet('cf.clipVoice', id);
export const lastKind = () => (lsGet('cf.clipKind', 'starter') === 'reaction' ? 'reaction' : 'starter');
export const setLastKind = (k) => lsSet('cf.clipKind', k);

/* what was last sent to Cartesia for a text (it can differ from the text: spelling, niqqud, [laughter]…), per kind + text */
const PK = 'cf.ttsPrompts';
export const ttsPrompt = (kind, text) => (lsGet(PK, {})[kind + '|' + text]) || text;
export function setTtsPrompt(kind, text, prompt) {
  const m = lsGet(PK, {});
  if (!prompt || prompt === text) delete m[kind + '|' + text]; else m[kind + '|' + text] = prompt;
  lsSet(PK, m);
}
