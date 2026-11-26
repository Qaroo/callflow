import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { decode, peaks, soundBounds, cutToWav, cutWords, guessWords, playPart, claimAudio, releaseAudio } from '../lib/audioEdit.js';

const MIN = 0.05; // shortest cut, seconds
const WAVE_H = 76;
const LANE_H = 30;
const fmt = (t) => (t < 0 ? 0 : t).toFixed(2);

/* The waveform of a clip with two handles: drag them (or type the times) to choose the part to keep,
   listen to it, then save it. `source` is a Blob.
   With `words` (the clip's text split into words), a row under the waveform shows where each word is said:
   drag a word's edges to fix them. Timings start from `initialWords` (Cartesia's) or from a guess.
   onSave(wavBlob, { start, end, timestamps }) gets the cut part (8 kHz μ-law) and the timings inside it. */
export default function WaveEditor({ source, onSave, saveLabel, requireChange, autoTrim, busy, words, initialWords, wordsFrom, children }) {
  const [buf, setBuf] = useState(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState({ s: 0, e: 0 });
  const [ts, setTs] = useState(null);
  const [head, setHead] = useState(null);
  const [saving, setSaving] = useState(false);
  const [wordsMoved, setWordsMoved] = useState(false);
  const [usedInitial, setUsedInitial] = useState(false); // the timings shown are the given ones, not a guess
  const wrap = useRef(null);
  const cv = useRef(null);
  const play = useRef(null);
  const drag = useRef(null);
  const [w, setW] = useState(600);
  const lane = !!(words && words.length);
  const H = WAVE_H + (lane ? LANE_H : 0);

  const stopRef = useRef(null);
  stopRef.current = stopRef.current || (() => stopRef.stop && stopRef.stop());

  useEffect(() => {
    let dead = false;
    setBuf(null); setErr(''); setWordsMoved(false);
    decode(source).then((b) => {
      if (dead) return;
      setBuf(b);
      setSel(autoTrim ? (({ start, end }) => ({ s: start, e: end }))(soundBounds(b)) : { s: 0, e: b.duration });
      const given = initialWords && initialWords.words && initialWords.words.length && initialWords.start.length === initialWords.words.length && initialWords.end.length === initialWords.words.length;
      setUsedInitial(!!given);
      if (lane) setTs(given ? { words: initialWords.words.slice(), start: initialWords.start.slice(), end: initialWords.end.slice() } : guessWords(b, words));
    }).catch(() => { if (!dead) setErr('אי אפשר לפענח את הקובץ הזה בדפדפן, אז אין גל ואין חיתוך.'); });
    return () => { dead = true; stop(); };
  }, [source]);

  useEffect(() => {
    const el = wrap.current;
    if (!el || !window.ResizeObserver) return;
    const ro = new ResizeObserver(() => setW(Math.max(120, Math.round(el.clientWidth))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [buf]);

  // draw
  useEffect(() => {
    const c = cv.current;
    if (!c || !buf) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = H * dpr;
    c.style.width = w + 'px'; c.style.height = H + 'px';
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(c);
    const col = (v, d) => (css.getPropertyValue(v) || d).trim() || d;
    const accent = col('--accent', '#007AFF');
    const dim = col('--label-3', '#c7c7cc');
    const label = col('--label', '#000');
    g.clearRect(0, 0, w, H);
    const x = (t) => (t / buf.duration) * w;
    const xs = x(sel.s), xe = x(sel.e);
    g.fillStyle = accent; g.globalAlpha = 0.1; g.fillRect(xs, 0, xe - xs, WAVE_H); g.globalAlpha = 1;
    const cols = Math.floor(w / 2);
    const pk = peaks(buf, cols);
    let max = 0.001; pk.forEach(([lo, hi]) => { max = Math.max(max, -lo, hi); });
    const k = (WAVE_H / 2 - 4) / Math.min(1, max * 1.05);
    for (let i = 0; i < cols; i++) {
      const px = i * 2;
      const [lo, hi] = pk[i];
      g.fillStyle = px >= xs && px <= xe ? accent : dim;
      const y1 = WAVE_H / 2 - hi * k, y2 = WAVE_H / 2 - lo * k;
      g.fillRect(px, y1, 1.4, Math.max(1, y2 - y1));
    }
    [xs, xe].forEach((hx) => {
      g.fillStyle = accent;
      g.fillRect(Math.min(w - 2, Math.max(0, hx - 1)), 0, 2, WAVE_H);
      const gx = Math.min(w - 6, Math.max(6, hx));
      g.beginPath();
      if (g.roundRect) g.roundRect(gx - 5, WAVE_H / 2 - 12, 10, 24, 4); else g.rect(gx - 5, WAVE_H / 2 - 12, 10, 24);
      g.fill();
      g.fillStyle = '#fff';
      g.fillRect(gx - 1.5, WAVE_H / 2 - 6, 1, 12); g.fillRect(gx + 0.5, WAVE_H / 2 - 6, 1, 12);
    });
    // the words row
    if (lane && ts) {
      const y0 = WAVE_H + 3, hh = LANE_H - 6;
      g.font = '600 12px system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      ts.words.forEach((word, i) => {
        const a = x(ts.start[i]), b = x(ts.end[i]);
        const inside = ts.end[i] > sel.s && ts.start[i] < sel.e;
        const now = head != null && head >= ts.start[i] && head < ts.end[i];
        g.fillStyle = now ? accent : inside ? 'rgba(127,127,127,.22)' : 'rgba(127,127,127,.08)';
        g.beginPath();
        if (g.roundRect) g.roundRect(a, y0, Math.max(2, b - a), hh, 5); else g.rect(a, y0, Math.max(2, b - a), hh);
        g.fill();
        g.fillStyle = now ? '#fff' : inside ? label : dim;
        g.save(); g.beginPath(); g.rect(a + 2, y0, Math.max(0, b - a - 4), hh); g.clip();
        g.fillText(word, (a + b) / 2, y0 + hh / 2 + 1);
        g.restore();
        g.fillStyle = accent;
        g.fillRect(a, y0, 2, hh); g.fillRect(b - 2, y0, 2, hh);
      });
    }
    if (head != null) { g.fillStyle = col('--red', '#FF3B30'); g.fillRect(x(head), 0, 1.5, H); }
  }, [buf, sel, head, w, ts, H]);

  function stop() {
    if (play.current) { play.current.stop(); play.current = null; }
    releaseAudio(stopRef.current);
    setHead(null);
  }
  stopRef.stop = stop;
  function toggle() {
    if (play.current) { stop(); return; }
    claimAudio(stopRef.current);
    const p = playPart(buf, sel.s, sel.e, stop);
    play.current = p;
    const tick = () => {
      if (play.current !== p) return;
      setHead(Math.min(sel.e, p.offset + (p.now() - p.startedAt)));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  const posOf = (ev) => {
    const r = cv.current.getBoundingClientRect();
    return { t: Math.max(0, Math.min(buf.duration, ((ev.clientX - r.left) / r.width) * buf.duration)), y: ev.clientY - r.top, px: ev.clientX - r.left, w: r.width };
  };
  const setEdge = (which, t) => setSel((o) => (which === 's' ? { s: Math.max(0, Math.min(t, o.e - MIN)), e: o.e } : { s: o.s, e: Math.min(buf.duration, Math.max(t, o.s + MIN)) }));
  // word edges as one ordered list: start0, end0, start1, end1, … ; `ks` moves together (two words that touch share an edge)
  const setWordPoint = (ks, t) => setTs((o) => {
    const pts = []; o.words.forEach((_, i) => { pts.push(o.start[i], o.end[i]); });
    const a = Math.min(...ks), b = Math.max(...ks);
    const lo = a > 0 ? pts[a - 1] : 0, hi = b < pts.length - 1 ? pts[b + 1] : buf.duration;
    const v = +Math.max(lo, Math.min(hi, t)).toFixed(3);
    ks.forEach((k) => { pts[k] = v; });
    return { words: o.words, start: o.words.map((_, i) => pts[2 * i]), end: o.words.map((_, i) => pts[2 * i + 1]) };
  });
  const down = (ev) => {
    if (!buf) return;
    const p = posOf(ev);
    stop();
    if (lane && ts && p.y > WAVE_H) {
      let best = -1, bestD = 14;
      ts.words.forEach((_, i) => [ts.start[i], ts.end[i]].forEach((t, j) => { const d = Math.abs((t / buf.duration) * p.w - p.px); if (d < bestD) { bestD = d; best = 2 * i + j; } }));
      if (best < 0) return;
      const pts = []; ts.words.forEach((_, i) => { pts.push(ts.start[i], ts.end[i]); });
      const ks = [best];
      if (best % 2 === 1 && best + 1 < pts.length && Math.abs(pts[best + 1] - pts[best]) < 0.015) ks.push(best + 1); // end of a word that touches the next
      if (best % 2 === 0 && best > 0 && Math.abs(pts[best - 1] - pts[best]) < 0.015) ks.push(best - 1); // start of a word that touches the previous
      drag.current = { word: ks };
      setWordsMoved(true);
    } else {
      const which = Math.abs(p.t - sel.s) <= Math.abs(p.t - sel.e) ? 's' : 'e';
      drag.current = { edge: which };
      setEdge(which, p.t);
    }
    cv.current.setPointerCapture(ev.pointerId);
  };
  const move = (ev) => {
    const d = drag.current;
    if (!d) return;
    const { t } = posOf(ev);
    if (d.edge) setEdge(d.edge, t); else setWordPoint(d.word, t);
  };
  const up = () => { drag.current = null; };

  const whole = buf && sel.s <= 0.001 && sel.e >= buf.duration - 0.001;
  const kept = lane && ts ? cutWords(ts, sel.s, sel.e) : null;
  const lost = lane && ts && kept.words.length < ts.words.length;
  const save = async () => {
    stop();
    setSaving(true);
    try { await onSave(await cutToWav(buf, sel.s, sel.e), { start: sel.s, end: sel.e, timestamps: kept }); } finally { setSaving(false); }
  };

  if (err) return <p className="vc-err">{err}</p>;
  if (!buf) return <p className="vc-empty">טוען גל קול…</p>;
  return (
    <div className="wave-ed">
      <div className="wave-box" ref={wrap} dir="ltr">
        <canvas ref={cv} className="wave-cv" role="img" aria-label={'גל הקול. נבחר ' + fmt(sel.s) + ' עד ' + fmt(sel.e) + ' שניות מתוך ' + fmt(buf.duration)}
          onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      </div>
      <div className="wave-ctl">
        <button type="button" className="vc-play sm" aria-label={head != null ? 'עצירה' : 'השמעת החלק שנבחר'} onClick={toggle}><Icon name={head != null ? 'stop' : 'play'} /></button>
        <label className="wave-t">מ-<TimeInput value={sel.s} max={buf.duration} label="התחלה בשניות" onCommit={(t) => { stop(); setEdge('s', t); }} /></label>
        <label className="wave-t">עד<TimeInput value={sel.e} max={buf.duration} label="סוף בשניות" onCommit={(t) => { stop(); setEdge('e', t); }} /></label>
        <span className="wave-len">{fmt(sel.e - sel.s)} מתוך {fmt(buf.duration)} שנ׳</span>
        <span className="tb-spacer" />
        <button type="button" className="btn-soft sm" title="להוריד את השקט בהתחלה ובסוף" onClick={() => { stop(); const b = soundBounds(buf); setSel({ s: b.start, e: b.end }); }}><Icon name="tidy" />חיתוך שקט</button>
        <button type="button" className="btn-soft sm" disabled={whole} onClick={() => { stop(); setSel({ s: 0, e: buf.duration }); }}><Icon name="undo" />הכול</button>
        {lane && <button type="button" className="btn-soft sm" title="לפזר את המילים מחדש על הקול" onClick={() => { stop(); setTs(guessWords(buf, words)); setWordsMoved(false); setUsedInitial(false); }}><Icon name="loop" />סימון מילים מחדש</button>}
      </div>
      {lane && (
        <small className={'wave-words-hint' + (lost ? ' warn' : '')}>
          {lost ? 'חלק מהמילים מחוץ לחלק שנבחר, והן לא יישמרו בזמני המילים. אם זה לא בכוונה, הרחיבו את הבחירה.'
            : usedInitial && !wordsMoved ? (wordsFrom === 'saved' ? 'זמני המילים כפי שנשמרו. אפשר לגרור את קצות המילים בשורה שמתחת לגל.' : 'זמני המילים מ-Cartesia. אפשר לגרור את קצות המילים בשורה שמתחת לגל.')
            : wordsMoved ? 'זמני המילים עודכנו ידנית. AIServant משתמש בהם כשהלקוח קוטע את הסוכן.'
            : 'זמני המילים הם הערכה: גררו את קצות כל מילה בשורה שמתחת לגל עד שהיא יושבת על הקול. AIServant משתמש בהם כשהלקוח קוטע את הסוכן.'}
        </small>
      )}
      <div className="wave-save">
        {children}
        <button type="button" className="btn-primary sm" disabled={saving || busy || (requireChange && whole && !wordsMoved) || (lane && kept && !kept.words.length)} onClick={save}><Icon name="check" />{saving || busy ? 'שומר…' : saveLabel || 'שמירה'}</button>
      </div>
    </div>
  );
}

/* a time field you can type into freely: the value is applied on Enter or when leaving the field */
function TimeInput({ value, max, label, onCommit }) {
  const [draft, setDraft] = useState(null);
  const commit = () => {
    if (draft === null) return;
    const t = parseFloat(String(draft).replace(',', '.'));
    setDraft(null);
    if (isFinite(t)) onCommit(Math.max(0, Math.min(max, t)));
  };
  return (
    <input className="input mono" type="text" inputMode="decimal" dir="ltr" aria-label={label}
      value={draft !== null ? draft : fmt(value)}
      onChange={(e) => setDraft(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } if (e.key === 'Escape') setDraft(null); }} />
  );
}
