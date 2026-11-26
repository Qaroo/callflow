/* Speech clips: an agency's reply starters and reaction sounds (projects/speech-clips/API.md, from Yoav).
     tables  — per kind ('starter' | 'reaction'): [{ name, description, texts[] }]; the call's decision model ("החלטה") picks an option
     clips   — per voice (Cartesia voice id, a GUID) + kind + text: a mono WAV and its word timestamps
   Two backends with the same contract:
     'aiservant' — AIServant's /SpeechClips endpoints (X-Api-Key + X-Agency-Id added here; the agency comes from the server config)
     'local'     — a stand-in on this machine (data/speech/<agency>/) that enforces the same rules, for while the API isn't live.
   SPEECH_CLIPS_BACKEND in .env picks one (default 'local'). */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const KINDS = ['starter', 'reaction'];
export const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const REQUIRED = { starter: ['understood', 'understood_long', 'great_question', 'good_question'], reaction: ['understood'] };
const NAME = /^[a-z][a-z0-9_]*$/;

/* the local stand-in's built-in tables (AIServant has its own; these only make the page usable before it's live) */
const BUILTIN = {
  starter: [
    { name: 'understood', description: 'הבנתי - the caller gave information or answered; acknowledge it and go on', texts: ['הבנתי,', 'אוקיי,', 'בסדר,'] },
    { name: 'understood_long', description: 'used instead of understood after a long caller turn (12+ words)', texts: ['אוקיי, הבנתי,', 'בסדר גמור, הבנתי,'] },
    { name: 'great_question', description: 'שאלה מצוינת - the caller asked a sharp, insightful question about the offer', texts: ['שאלה מצוינת,'] },
    { name: 'good_question', description: 'שאלה טובה - the caller asked an ordinary practical question', texts: ['שאלה טובה,'] },
  ],
  reaction: [
    { name: 'understood', description: 'mhm - the caller just completed a clear piece of information', texts: ['אהה', 'מממ', 'כן'] },
    { name: 'empathy', description: 'a soft sympathetic sound - the caller just shared something painful or annoying', texts: ['אוי...', 'וואי'] },
  ],
};

/* the same rules AIServant enforces; returns the cleaned table or throws with AIServant-style text */
export function checkTable(kind, table) {
  if (!Array.isArray(table)) throw new Error('the table must be a list of options.');
  const seen = new Set();
  const out = table.map((o) => {
    const name = String((o && o.name) || '');
    if (name === 'none') throw new Error("'none' is ours; leave it out of the table.");
    if (!NAME.test(name)) throw new Error("'" + name + "' is not an option name: lowercase letters, digits and _, starting with a letter.");
    if (seen.has(name)) throw new Error("option names must be unique; '" + name + "' appears twice.");
    seen.add(name);
    const description = String((o && o.description) || '').trim();
    if (!description) throw new Error("'" + name + "' needs a description.");
    const texts = (Array.isArray(o.texts) ? o.texts : []).map((t) => String(t || '').trim()).filter(Boolean);
    if (!texts.length) throw new Error("'" + name + "' needs at least one text.");
    return { name, description, texts };
  });
  const missing = REQUIRED[kind].filter((n) => !seen.has(n));
  if (kind === 'reaction' && (missing.length || out.find((o) => o.name === 'understood').texts.length < 2)) throw new Error("a reactions table needs 'understood' with at least 2 texts.");
  if (missing.length) throw new Error('a starters table needs ' + REQUIRED.starter.map((n) => "'" + n + "'").join(', ') + '; ' + missing.map((n) => "'" + n + "'").join(', ') + (missing.length > 1 ? ' are' : ' is') + ' missing.');
  return out;
}

/* a WAV the API accepts: mono, 16-bit PCM at 16/24 kHz or μ-law at 8 kHz → { rate, duration } */
export function checkWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('the file is not a WAV.');
  let off = 12, fmt = null, dataLen = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === 'data') { dataLen = Math.min(len, buf.length - off - 8); break; }
    off += 8 + len + (len % 2);
  }
  if (!fmt || dataLen === null) throw new Error('the file is not a WAV.');
  if (fmt.channels !== 1) throw new Error('the WAV must be mono.');
  const pcm = fmt.format === 1 && fmt.bits === 16 && (fmt.rate === 16000 || fmt.rate === 24000);
  const mulaw = fmt.format === 7 && fmt.bits === 8 && fmt.rate === 8000;
  if (!pcm && !mulaw) throw new Error('unsupported WAV: use 16-bit PCM at 16 or 24 kHz, or μ-law at 8 kHz.');
  return { rate: fmt.rate, duration: dataLen / (fmt.rate * (fmt.bits / 8)) };
}

export function checkTimestamps(ts, duration) {
  if (!ts || !Array.isArray(ts.words) || !Array.isArray(ts.start) || !Array.isArray(ts.end)) throw new Error('timestamps need words, start and end.');
  if (!ts.words.length) throw new Error('timestamps have no words.');
  if (ts.start.length !== ts.words.length || ts.end.length !== ts.words.length) throw new Error('a word is missing its start or end.');
  let prev = 0;
  for (let i = 0; i < ts.words.length; i++) {
    const s = +ts.start[i], e = +ts.end[i];
    if (!isFinite(s) || !isFinite(e)) throw new Error('a word is missing its start or end.');
    if (s < 0 || e > duration + 0.05 || e < s) throw new Error("the timing of '" + ts.words[i] + "' falls outside the clip.");
    if (s < prev - 0.001) throw new Error('the words are not in order.');
    prev = s;
  }
}

function writeAtomic(file, data) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
const fail = (status, message) => Object.assign(new Error(message), { status });

/* ---------------- local stand-in ---------------- */
function localBackend({ dataDir, agencyId }) {
  const root = () => {
    const a = String(agencyId() || '');
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(a)) throw fail(400, 'no account set');
    return path.join(dataDir, 'speech', a);
  };
  const tableFile = (kind) => path.join(root(), 'tables', kind + '.json');
  const clipDir = (voice, kind) => path.join(root(), 'clips', voice.toLowerCase(), kind);
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };
  const index = (voice, kind) => readJson(path.join(clipDir(voice, kind), 'index.json'), {});
  const table = (kind) => readJson(tableFile(kind), null) || BUILTIN[kind];
  return {
    name: 'local',
    async getTable(kind) { return table(kind); },
    async putTable(kind, t) {
      const clean = checkTable(kind, t);
      fs.mkdirSync(path.dirname(tableFile(kind)), { recursive: true });
      writeAtomic(tableFile(kind), JSON.stringify(clean, null, 1));
    },
    async status(voice, kind, texts) {
      const idx = index(voice, kind);
      return Object.fromEntries(texts.map((t) => [t, !!idx[t] && fs.existsSync(path.join(clipDir(voice, kind), idx[t].file))]));
    },
    async getClip(voice, kind, text) {
      const e = index(voice, kind)[text];
      const f = e && path.join(clipDir(voice, kind), e.file);
      return f && fs.existsSync(f) ? { type: 'audio/wav', body: fs.readFileSync(f), timestamps: e.timestamps } : null;
    },
    async putClip(voice, kind, text, wav, timestamps) {
      if (!table(kind).some((o) => o.texts.includes(text))) throw fail(400, "the text '" + text + "' isn't in the table.");
      const { duration } = checkWav(wav);
      checkTimestamps(timestamps, duration);
      const dir = clipDir(voice, kind);
      fs.mkdirSync(dir, { recursive: true });
      const idx = index(voice, kind);
      const file = crypto.randomBytes(8).toString('hex') + '.wav';
      writeAtomic(path.join(dir, file), wav);
      const old = idx[text];
      idx[text] = { file, timestamps, updatedAt: Date.now() };
      writeAtomic(path.join(dir, 'index.json'), JSON.stringify(idx, null, 1));
      if (old) fs.rmSync(path.join(dir, old.file), { force: true });
    },
  };
}

/* ---------------- AIServant ---------------- */
function aiservantBackend({ api, secret, agencyId }) {
  const base = () => api.replace(/\/+$/, '') + '/SpeechClips/';
  const headers = (extra) => {
    if (!secret || !agencyId()) throw fail(400, 'AISERVANT_SHARED_SECRET and the account must be set');
    return Object.assign({ 'X-Api-Key': secret, 'X-Agency-Id': agencyId() }, extra || {});
  };
  const call = async (url, opts) => {
    let r;
    try { r = await fetch(url, opts); } catch (e) { throw fail(502, 'could not reach AIServant: ' + (e.message || e)); }
    return r;
  };
  const refuse = async (r) => {
    const t = (await r.text()).slice(0, 600) || 'HTTP ' + r.status;
    // AIServant answers 400 with a plain-text reason: shown as it is
    throw fail(r.status === 400 ? 400 : r.status === 404 ? 404 : 502, r.status === 400 ? t : 'AIServant answered ' + r.status + ': ' + t);
  };
  return {
    name: 'aiservant',
    async getTable(kind) {
      const r = await call(base() + kind + '/table', { headers: headers() });
      if (!r.ok) await refuse(r);
      return r.json();
    },
    async putTable(kind, t) {
      const r = await call(base() + kind + '/table', { method: 'PUT', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(t) });
      if (!r.ok) await refuse(r);
    },
    async status(voice, kind, texts) {
      // no "list clips" endpoint: ask for each text (a few at a time)
      const out = {};
      let i = 0;
      const worker = async () => {
        while (i < texts.length) {
          const t = texts[i++];
          const r = await call(base() + encodeURIComponent(voice) + '/' + kind + '/clip?text=' + encodeURIComponent(t), { headers: headers() });
          out[t] = r.ok;
          try { await r.body?.cancel(); } catch (e) { /* drained */ }
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, texts.length) }, worker));
      return out;
    },
    async getClip(voice, kind, text) {
      const r = await call(base() + encodeURIComponent(voice) + '/' + kind + '/clip?text=' + encodeURIComponent(text), { headers: headers() });
      if (r.status === 404) return null;
      if (!r.ok) await refuse(r);
      return { type: r.headers.get('content-type') || 'audio/wav', body: Buffer.from(await r.arrayBuffer()) };
    },
    async putClip(voice, kind, text, wav, timestamps) {
      const form = new FormData();
      form.append('text', text);
      form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'clip.wav');
      form.append('timestamps', JSON.stringify(timestamps));
      const r = await call(base() + encodeURIComponent(voice) + '/' + kind + '/clip', { method: 'PUT', headers: headers(), body: form });
      if (!r.ok) await refuse(r);
    },
  };
}

export default function speechClips(opts) {
  return (opts.backend === 'aiservant' ? aiservantBackend : localBackend)(opts);
}

/* ---------------- Cartesia: a sentence + its word timestamps (POST /tts/sse), as an 8 kHz μ-law WAV ---------------- */
export async function cartesiaSpeak({ key, model, version }, { voice, text, speed }) {
  const body = {
    model_id: model, transcript: text, voice: { id: voice }, language: 'he',
    // 8 kHz, the phone rate: AIServant takes 8 kHz clips as μ-law WAV
    output_format: { container: 'raw', encoding: 'pcm_mulaw', sample_rate: 8000 },
    add_timestamps: true,
  };
  if (speed && isFinite(+speed) && +speed !== 1) body.generation_config = { speed: Math.min(1.5, Math.max(0.6, +speed)) };
  let r;
  try {
    r = await fetch('https://api.cartesia.ai/tts/sse', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Cartesia-Version': version, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
  } catch (e) { throw fail(502, 'אין חיבור ל-Cartesia: ' + (e.message || e)); }
  const raw = await r.text();
  if (!r.ok) {
    let msg = raw.slice(0, 400);
    try { const j = JSON.parse(raw); msg = j.message || j.error || j.title || msg; } catch (e) { /* text */ }
    throw fail(r.status >= 500 || r.status === 401 || r.status === 403 ? 502 : 400, 'Cartesia ' + r.status + ': ' + msg);
  }
  const pcm = [];
  const ts = { words: [], start: [], end: [] };
  for (const frame of raw.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data) continue;
    let ev;
    try { ev = JSON.parse(data); } catch (e) { continue; }
    if (ev.type === 'chunk' && ev.data) pcm.push(Buffer.from(ev.data, 'base64'));
    else if (ev.type === 'timestamps' && ev.word_timestamps) {
      const w = ev.word_timestamps;
      (w.words || []).forEach((x, i) => { ts.words.push(x); ts.start.push(+w.start[i]); ts.end.push(+w.end[i]); });
    } else if (ev.type === 'error') throw fail(400, 'Cartesia: ' + (ev.message || ev.title || 'error'));
  }
  const data = Buffer.concat(pcm);
  if (!data.length) throw fail(502, 'Cartesia returned no audio');
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  // WAVE_FORMAT_MULAW (7), mono, 8000 Hz, 8 bits
  h.writeUInt32LE(16, 16); h.writeUInt16LE(7, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(8000, 24); h.writeUInt32LE(8000, 28); h.writeUInt16LE(1, 32); h.writeUInt16LE(8, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return { wav: Buffer.concat([h, data]), timestamps: ts.words.length ? ts : null };
}
