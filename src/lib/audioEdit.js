/* Audio editing in the browser: decode, waveform peaks, cut, encode WAV, record from the mic, word timings.
   Every clip is saved as the phone format AIServant takes: WAV, mono, 8 kHz μ-law. */

export const OUT_RATE = 8000;

/* one sound at a time on the page: whoever starts playing stops the previous one */
let owner = null;
export function claimAudio(stop) {
  if (owner && owner !== stop) { const o = owner; owner = null; o(); }
  owner = stop;
}
export function releaseAudio(stop) { if (owner === stop) owner = null; }
let ctx = null;
const audioCtx = () => (ctx = ctx || new (window.AudioContext || window.webkitAudioContext)());

export async function decode(blob) {
  const buf = await blob.arrayBuffer();
  const g711 = decodeG711Wav(buf); // μ-law / A-law WAV: decoded here, not left to the browser
  if (g711) return g711;
  return await audioCtx().decodeAudioData(buf);
}

/* G.711 */
function ulawToLinear(u) {
  u = ~u & 0xff;
  const t = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return (u & 0x80 ? 0x84 - t : t - 0x84) / 32768;
}
function alawToLinear(a) {
  a ^= 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  t = seg === 0 ? t + 8 : seg === 1 ? t + 0x108 : (t + 0x108) << (seg - 1);
  return (a & 0x80 ? t : -t) / 32768;
}
function linearToUlaw(x) {
  let s = Math.max(-32635, Math.min(32635, Math.round(x * 32767)));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += 0x84;
  let exp = 7;
  for (let m = 0x4000; (s & m) === 0 && exp > 0; m >>= 1) exp--;
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}
function decodeG711Wav(ab) {
  const v = new DataView(ab);
  if (ab.byteLength < 44 || v.getUint32(0) !== 0x52494646 || v.getUint32(8) !== 0x57415645) return null; // RIFF / WAVE
  let off = 12, fmt = null;
  while (off + 8 <= ab.byteLength) {
    const id = v.getUint32(off), len = v.getUint32(off + 4, true);
    if (id === 0x666d7420) fmt = { format: v.getUint16(off + 8, true), ch: v.getUint16(off + 10, true), rate: v.getUint32(off + 12, true) };
    if (id === 0x64617461) {
      if (!fmt || (fmt.format !== 7 && fmt.format !== 6)) return null;
      const n = Math.floor(Math.min(len, ab.byteLength - off - 8) / fmt.ch);
      const out = audioCtx().createBuffer(1, Math.max(1, n), fmt.rate);
      const d = out.getChannelData(0);
      const conv = fmt.format === 7 ? ulawToLinear : alawToLinear;
      for (let i = 0; i < n; i++) d[i] = conv(v.getUint8(off + 8 + i * fmt.ch));
      return out;
    }
    off += 8 + len + (len % 2);
  }
  return null;
}

/* n columns of [min, max] over all channels */
export function peaks(buffer, n) {
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const len = buffer.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * len) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * len) / n));
    let lo = 0, hi = 0;
    const step = Math.max(1, Math.floor((b - a) / 400)); // long clips: sample the column
    for (const d of chans) for (let j = a; j < b; j += step) { const v = d[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    out[i] = [lo, hi];
  }
  return out;
}

/* where the sound starts and ends (the silence around it is cut), in seconds */
export function soundBounds(buffer, threshold = 0.02, padSec = 0.06) {
  const d = buffer.getChannelData(0);
  const others = [];
  for (let c = 1; c < buffer.numberOfChannels; c++) others.push(buffer.getChannelData(c));
  const win = Math.max(1, Math.round(buffer.sampleRate * 0.01));
  const loud = (i) => {
    let m = 0;
    for (let j = i; j < Math.min(i + win, d.length); j++) { m = Math.max(m, Math.abs(d[j])); for (const o of others) m = Math.max(m, Math.abs(o[j])); }
    return m > threshold;
  };
  let a = 0;
  while (a < d.length && !loud(a)) a += win;
  let b = d.length - win;
  while (b > a && !loud(b)) b -= win;
  if (a >= d.length) return { start: 0, end: buffer.duration };
  const pad = padSec * buffer.sampleRate;
  return { start: Math.max(0, (a - pad) / buffer.sampleRate), end: Math.min(buffer.duration, (b + win + pad) / buffer.sampleRate) };
}

/* the part [start, end) as a WAV blob: mono, 8 kHz, μ-law */
export async function cutToWav(buffer, start, end) {
  const s = Math.max(0, Math.min(start, buffer.duration));
  const e = Math.max(s, Math.min(end, buffer.duration));
  const frames = Math.max(1, Math.round((e - s) * OUT_RATE));
  const off = new OfflineAudioContext(1, frames, OUT_RATE);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start(0, s, e - s);
  const out = await off.startRendering();
  return encodeMulawWav(out.getChannelData(0), OUT_RATE);
}

export function encodeMulawWav(samples, rate) {
  const b = new ArrayBuffer(44 + samples.length);
  const v = new DataView(b);
  const str = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 7, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, samples.length, true);
  for (let i = 0; i < samples.length; i++) v.setUint8(44 + i, linearToUlaw(samples[i]));
  return new Blob([b], { type: 'audio/wav' });
}

/* word timings { words, start, end } (seconds) after cutting [s, e): words outside are dropped, the rest shifted */
export function cutWords(ts, s, e) {
  const out = { words: [], start: [], end: [] };
  if (!ts) return out;
  ts.words.forEach((w, i) => {
    if (ts.end[i] <= s + 0.01 || ts.start[i] >= e - 0.01) return;
    out.words.push(w);
    out.start.push(+Math.max(0, ts.start[i] - s).toFixed(3));
    out.end.push(+Math.min(e - s, ts.end[i] - s).toFixed(3));
  });
  return out;
}

/* a first guess for word timings: the words spread over where the sound is, by length */
export function guessWords(buffer, words) {
  const { start, end } = soundBounds(buffer);
  const weights = words.map((w) => Math.max(1, w.replace(/[^\p{L}\p{N}]/gu, '').length) + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  const span = Math.max(0.05, end - start);
  const ts = { words: words.slice(), start: [], end: [] };
  let t = start;
  weights.forEach((wt) => { const d = (span * wt) / total; ts.start.push(+t.toFixed(3)); ts.end.push(+(t + d).toFixed(3)); t += d; });
  return ts;
}

export const splitWords = (text) => String(text || '').trim().split(/\s+/).filter(Boolean);

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/* play [start, end) of a buffer; returns { stop, startedAt (context time), offset } */
export function playPart(buffer, start, end, onEnd) {
  const c = audioCtx();
  if (c.state === 'suspended') c.resume();
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(c.destination);
  src.onended = () => onEnd && onEnd();
  src.start(0, start, Math.max(0, end - start));
  return { stop: () => { src.onended = null; try { src.stop(); } catch (e) { /* already stopped */ } }, startedAt: c.currentTime, offset: start, now: () => c.currentTime };
}

/* the microphone: start() → { stop(): Promise<Blob>, level(): 0..1, cancel() } */
export async function startRecording() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('הדפדפן הזה לא מאפשר הקלטה');
  if (!window.MediaRecorder) throw new Error('הדפדפן הזה לא תומך בהקלטה (MediaRecorder)');
  let stream;
  try {
    // no noise suppression or auto gain: a cough or "mmm" is exactly what to keep
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    throw new Error(e && e.name === 'NotAllowedError' ? 'אין הרשאה למיקרופון. אפשר לאשר אותה בסמל המנעול שליד הכתובת.' : e && e.name === 'NotFoundError' ? 'לא נמצא מיקרופון' : 'אי אפשר לפתוח את המיקרופון: ' + ((e && e.message) || e));
  }
  const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const c = audioCtx();
  if (c.state === 'suspended') c.resume();
  const an = c.createAnalyser();
  an.fftSize = 1024;
  const srcNode = c.createMediaStreamSource(stream);
  srcNode.connect(an);
  const data = new Float32Array(an.fftSize);
  const close = () => { stream.getTracks().forEach((t) => t.stop()); try { srcNode.disconnect(); } catch (e) { /* gone */ } };
  rec.start(250);
  return {
    level() { an.getFloatTimeDomainData(data); let m = 0; for (let i = 0; i < data.length; i++) m = Math.max(m, Math.abs(data[i])); return Math.min(1, m * 1.4); },
    stop: () => new Promise((resolve) => {
      rec.onstop = () => { close(); resolve(new Blob(chunks, { type: rec.mimeType || type || 'audio/webm' })); };
      rec.stop();
    }),
    cancel() { rec.onstop = null; try { rec.stop(); } catch (e) { /* stopped */ } close(); },
  };
}
