import { useEffect, useRef, useState } from 'react';
import CF from '../lib/core.js';
import { Icon } from '../components/Icon.jsx';
import TopNav from '../components/TopNav.jsx';
import WaveEditor from '../components/WaveEditor.jsx';
import { startRecording, claimAudio, releaseAudio, splitWords, blobToBase64 } from '../lib/audioEdit.js';
import {
  KINDS, REQUIRED, NOTES, GUID, tableProblems, cleanTable, drafts, speechConfig, getTable, putTable, clipStatus, clipUrl, putClip, savedWords, speak,
  knownVoices, rememberVoice, forgetVoice, lastVoice, setLastVoice, lastKind, setLastKind, ttsPrompt, setTtsPrompt,
} from '../lib/speechClips.js';

/* one shared player for saved clips; the editor's own playback stops it and vice versa */
const player = { audio: null, key: null, subs: new Set() };
const notify = () => player.subs.forEach((f) => f());
const stopShared = () => { if (player.audio) player.audio.pause(); player.audio = null; player.key = null; notify(); };
function playClip(key, url) {
  if (player.audio) { player.audio.pause(); player.audio = null; }
  if (player.key === key || !url) { player.key = null; releaseAudio(stopShared); notify(); return; }
  claimAudio(stopShared);
  const a = new Audio(url);
  player.audio = a; player.key = key;
  const done = () => { if (player.audio === a) { player.audio = null; player.key = null; releaseAudio(stopShared); notify(); } };
  a.onended = done;
  a.onerror = () => { done(); CF.toast('אי אפשר לנגן את הקטע'); };
  a.play().catch(done);
  notify();
}
function usePlaying() {
  const [, tick] = useState(0);
  useEffect(() => { const f = () => tick((x) => x + 1); player.subs.add(f); return () => player.subs.delete(f); }, []);
  return player.key;
}

/* Voice library: the agency's starter / reaction tables, and a clip per voice for every text in them. */
export default function Voices() {
  const [cfg, setCfg] = useState(null);
  const [kind, setKind] = useState(lastKind);
  const [saved, setSaved] = useState({}); // kind → the table as the server has it
  useEffect(() => { speechConfig().then(setCfg).catch(() => setCfg({ backend: '?', tts: false })); }, []);
  useEffect(() => () => stopShared(), []);
  const pickKind = (k) => { setKind(k); setLastKind(k); };

  return (
    <div className="home me vc-page">
      <TopNav />
      <header className="vc-hero">
        <div>
          <h1>ספריית קול</h1>
          <p>פתיחי התשובה (starters) והתגובות (reactions) של החשבון: טבלה לכל סוג, שההחלטה בוחרת ממנה תוך כדי השיחה, וקטע קול לכל נוסח בכל קול. שינויים נכנסים לתוקף מהשיחה הבאה.</p>
        </div>
        {cfg && cfg.backend === 'local' && (
          <div className="vc-note" role="note"><Icon name="database" /><span><b>מצב מקומי: לא נשלח ל-AIServant.</b> ה-API של יואב עוד לא עלה, אז הטבלאות והקטעים נשמרים במחשב הזה, עם אותם כללים ואותו פורמט. כשיעלה, מעבירים ל-<code dir="ltr">SPEECH_CLIPS_BACKEND=aiservant</code> ב-<code dir="ltr">.env</code>. הטבלאות שמוצגות כאן לפני שמירה הן דוגמה מקומית, לא הטבלאות המובנות של AIServant.</span></div>
        )}
        {cfg && cfg.backend === 'aiservant' && <div className="vc-note ok" role="note"><Icon name="check" /><span>מחובר ל-AIServant.</span></div>}
      </header>

      <div className="vc-kinds" role="tablist" aria-label="סוג">
        {Object.entries(KINDS).map(([k, v]) => (
          <button key={k} type="button" role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => pickKind(k)}>
            <b>{v.title}</b><span>{v.he}</span>
          </button>
        ))}
      </div>

      <TableEditor key={'t:' + kind} kind={kind} onSaved={(t) => setSaved((s) => Object.assign({}, s, { [kind]: t }))} />
      <ClipsGrid key={'c:' + kind} kind={kind} table={saved[kind]} tts={!!(cfg && cfg.tts)} />
    </div>
  );
}

/* ---------------- the table ---------------- */
function TableEditor({ kind, onSaved }) {
  const [server, setServer] = useState(null);
  const [draft, setDraft] = useState(null);
  const [loadErr, setLoadErr] = useState('');
  const [saveErr, setSaveErr] = useState('');
  const [saving, setSaving] = useState(false);
  // rows loaded from the server remember their name (_orig): only those can be required and locked
  const fromServer = (t) => t.map((o) => Object.assign({}, o, { texts: o.texts.slice(), _orig: o.name }));
  const load = (keepDraft) => getTable(kind).then((r) => {
    setServer(r.table);
    setDraft(keepDraft && drafts[kind] ? drafts[kind] : fromServer(r.table));
    if (!keepDraft) delete drafts[kind];
    onSaved(r.table); setLoadErr('');
  }).catch((e) => setLoadErr(e.message));
  useEffect(() => { load(true); }, [kind]);
  useEffect(() => { if (draft && server) { if (JSON.stringify(cleanTable(draft)) !== JSON.stringify(cleanTable(server))) drafts[kind] = draft; else delete drafts[kind]; } }, [draft, server]);

  if (loadErr) return <section className="me-card wide"><p className="vc-err">לא נטענה הטבלה: {loadErr}</p><div><button className="btn-soft sm" type="button" onClick={() => load(true)}>לנסות שוב</button></div></section>;
  if (!draft) return <section className="me-card wide"><p className="vc-empty">טוען את הטבלה…</p></section>;

  const dirty = JSON.stringify(cleanTable(draft)) !== JSON.stringify(cleanTable(server));
  const problems = tableProblems(kind, cleanTable(draft));
  const set = (i, patch) => { setSaveErr(''); setDraft((d) => d.map((o, j) => (j === i ? Object.assign({}, o, patch) : o))); };
  const save = async () => {
    setSaving(true); setSaveErr('');
    try { await putTable(kind, cleanTable(draft)); CF.toast('הטבלה נשמרה'); await load(false); } catch (e) { setSaveErr(e.message); } finally { setSaving(false); }
  };

  return (
    <section className="me-card wide vc-table">
      <div className="me-card-h">
        <span className="sec-ic"><Icon name={kind === 'starter' ? 'bubble' : 'wave'} /></span>
        <div><h2>הטבלה: {KINDS[kind].title}</h2><p>{KINDS[kind].sub} לכל אפשרות יש שם, תיאור באנגלית שהמנוע קורא כדי להחליט מתי לבחור בה, ונוסחים. בכל פעם נבחר אחד מהנוסחים באקראי.</p></div>
      </div>
      <div className="vc-opts">
        {draft.map((o, i) => {
          const req = !!o._orig && REQUIRED[kind].includes(o._orig);
          const note = NOTES[kind + ':' + o.name] || NOTES[o.name];
          return (
            <div key={i} className={'vc-opt' + (req ? ' req' : '')}>
              <div className="vc-opt-h">
                <input className="input mono vc-opt-name" dir="ltr" value={o.name} readOnly={req} placeholder="option_name" aria-label="שם האפשרות"
                  onChange={(e) => set(i, { name: e.target.value.toLowerCase().replace(/\s+/g, '_') })} />
                {req ? <span className="vc-badge" title="אפשרות חובה של AIServant: אי אפשר למחוק או לשנות את השם"><Icon name="key" />חובה</span>
                  : <button type="button" className="icon-btn danger" aria-label={'מחיקת האפשרות ' + o.name} title="מחיקת האפשרות" onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}><Icon name="trash" /></button>}
              </div>
              {note && <small className="vc-opt-note">{note}</small>}
              <textarea className="input vc-opt-desc" dir="ltr" rows={2} value={o.description} placeholder='In English: when this fits. May start with an example, e.g. "שאלה טובה - the caller asked…"' aria-label="תיאור באנגלית"
                onChange={(e) => set(i, { description: e.target.value })} />
              <div className="vc-texts">
                {o.texts.map((t, j) => (
                  <span key={j} className="vc-text">
                    <input className="input" dir="auto" value={t} aria-label="נוסח" size={Math.max(4, (t || '').length + 1)}
                      onChange={(e) => set(i, { texts: o.texts.map((x, k) => (k === j ? e.target.value : x)) })} />
                    <button type="button" className="vc-x" aria-label={'מחיקת הנוסח ' + t} onClick={() => set(i, { texts: o.texts.filter((_, k) => k !== j) })}><Icon name="close" /></button>
                  </span>
                ))}
                <button type="button" className="btn-soft sm" onClick={() => set(i, { texts: o.texts.concat('') })}><Icon name="plus" />נוסח</button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="vc-table-foot">
        <button type="button" className="btn-soft sm" onClick={() => setDraft((d) => d.concat({ name: '', description: '', texts: [''] }))}><Icon name="plus" />אפשרות</button>
        <span className="tb-spacer" />
        {dirty && <button type="button" className="btn-soft sm" onClick={() => { setSaveErr(''); setDraft(fromServer(server)); }}><Icon name="undo" />ביטול השינויים</button>}
        <button type="button" className="btn-primary sm" disabled={!dirty || saving || problems.length > 0} onClick={save}><Icon name="check" />{saving ? 'שומר…' : 'שמירת הטבלה'}</button>
      </div>
      {dirty && problems.length > 0 && <ul className="vc-problems">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>}
      {saveErr && <p className="vc-err" dir="auto">השרת סירב: {saveErr}</p>}
      {dirty && !problems.length && <small className="vc-hint">יש שינויים שלא נשמרו. הקטעים למטה מתייחסים לטבלה השמורה.</small>}
    </section>
  );
}

/* ---------------- clips per voice ---------------- */
function ClipsGrid({ kind, table, tts }) {
  const voices = knownVoices();
  const [voice, setVoice] = useState(() => { const l = lastVoice(); return (GUID.test(l || '') && l) || (voices[0] && voices[0].id) || ''; });
  const first = voices[0] && voices[0].id;
  useEffect(() => { if (!voice && first) setVoice(first); }, [voice, first]);
  const [typed, setTyped] = useState('');
  const [, bump] = useState(0);
  const [status, setStatus] = useState(null);
  const [statusErr, setStatusErr] = useState('');
  const [ver, setVer] = useState({});
  const [open, setOpen] = useState(null); // { text, how: 'tts'|'rec'|'file'|'edit' }
  const [speed, setSpeed] = useState(1);
  const pick = (id) => { setVoice(id); setLastVoice(id); setOpen(null); };
  const texts = table ? [...new Set(table.flatMap((o) => o.texts))] : [];
  const textsKey = texts.join('\u0001');

  const refresh = () => {
    if (!voice || !texts.length) { setStatus({}); return; }
    setStatusErr('');
    return clipStatus(voice, kind, texts).then(setStatus).catch((e) => { setStatus({}); setStatusErr(e.message); });
  };
  useEffect(() => { setStatus(null); refresh(); }, [voice, kind, textsKey]);

  const addTyped = () => {
    const id = typed.trim().toLowerCase();
    if (!GUID.test(id)) { CF.toast('voice id של Cartesia הוא GUID, למשל a0e99841-438c-4a64-b679-ae501e7d6091'); return; }
    rememberVoice(id); setTyped(''); pick(id);
  };
  const shown = voices.some((v) => v.id === voice) || !voice ? voices : voices.concat({ id: voice, labels: [] });
  const have = status ? texts.filter((t) => status[t]).length : 0;

  return (
    <section className="me-card wide vc-clips">
      <div className="me-card-h">
        <span className="sec-ic"><Icon name="speaker" /></span>
        <div><h2>הקטעים לפי קול</h2><p>{KINDS[kind].clipsSub} הקטעים נשמרים כ-WAV מונו 8 kHz (μ-law), עם הזמן של כל מילה.</p></div>
      </div>
      <div className="vc-chips" role="radiogroup" aria-label="קול">
        {shown.map((v) => (
          <span key={v.id} className={'vc-chip' + (v.id === voice ? ' on' : '')}>
            <button type="button" role="radio" aria-checked={v.id === voice} onClick={() => pick(v.id)}>
              <b>{v.labels.length ? v.labels.join(' · ') : 'קול'}</b><code dir="ltr">{v.id.slice(0, 8) + '…' + v.id.slice(-4)}</code>
            </button>
            {!v.labels.length && <button type="button" className="vc-x" title="להסיר מהרשימה (הקטעים נשארים)" aria-label="להסיר מהרשימה" onClick={() => { forgetVoice(v.id); if (v.id === voice) pick(''); else bump((x) => x + 1); }}><Icon name="close" /></button>}
          </span>
        ))}
        <form className="vc-add-voice" onSubmit={(e) => { e.preventDefault(); addTyped(); }}>
          <input className="input mono" dir="ltr" value={typed} placeholder="Cartesia voice id (GUID)" aria-label="voice id" onChange={(e) => setTyped(e.target.value)} />
          <button className="btn-soft sm" type="submit" disabled={!typed.trim()}><Icon name="plus" />הוספה</button>
        </form>
      </div>
      {!voice ? <p className="vc-empty">בחרו קול או הוסיפו voice id. אפשר גם לתת קול לסוכן (Cartesia voice id) או לקבוע ברירת מחדל בהגדרות.</p> : !table ? <p className="vc-empty">טוען…</p> : (<>
        <div className="vc-clips-bar">
          <span className="vc-count">{status ? have + ' מתוך ' + texts.length + ' נוסחים עם קטע בקול הזה' : 'בודק אילו קטעים יש…'}</span>
          <span className="tb-spacer" />
          {tts && <label className="vc-speed">מהירות Cartesia
            <select className="input" value={speed} onChange={(e) => setSpeed(+e.target.value)}>{[0.8, 0.9, 1, 1.1, 1.2].map((s) => <option key={s} value={s}>{s === 1 ? 'רגילה' : s + '×'}</option>)}</select>
          </label>}
        </div>
        {statusErr && <p className="vc-err">{statusErr}</p>}
        {table.map((o) => (
          <div key={o.name} className="vc-group">
            <div className="vc-group-h"><code dir="ltr">{o.name}</code><small dir="ltr">{o.description}</small></div>
            <ul className="vc-list">
              {o.texts.map((t) => (
                <TextRow key={t} text={t} kind={kind} voice={voice} has={status ? !!status[t] : null} ver={ver[t]} tts={tts} speed={speed}
                  open={open && open.text === t ? open.how : null} setOpen={(how) => setOpen(how ? { text: t, how } : null)}
                  onSaved={() => { setVer((v) => Object.assign({}, v, { [t]: Date.now() })); setOpen(null); refresh(); }} />
              ))}
            </ul>
          </div>
        ))}
      </>)}
    </section>
  );
}

function TextRow({ text, kind, voice, has, ver, tts, speed, open, setOpen, onSaved }) {
  const playing = usePlaying();
  const key = kind + ':' + voice + ':' + text;
  const url = clipUrl(voice, kind, text, ver);
  const [src, setSrc] = useState(null); // { blob, words?, label }
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fileRef = useRef(null);
  const words = splitWords(text);
  const [prompt, setPrompt] = useState(() => ttsPrompt(kind, text)); // what Cartesia is asked to say

  useEffect(() => { if (!open) { setSrc(null); setErr(''); } }, [open]);

  const generate = async () => {
    const say = prompt.trim();
    if (!say) { CF.toast('כתבו מה Cartesia יגיד'); return; }
    setTtsPrompt(kind, text, say);
    setSrc(null); setErr(''); setBusy(true);
    try {
      const g = await speak(voice, say, speed);
      setSrc({ blob: g.blob, words: g.timestamps, from: 'cartesia', label: say === text ? 'נוצר ב-Cartesia' : 'נוצר ב-Cartesia מ: "' + say + '"' });
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const edit = async () => {
    if (open === 'edit') { setOpen(null); return; }
    setOpen('edit'); setSrc(null); setErr('');
    try {
      const [r, words] = await Promise.all([fetch(url), savedWords(voice, kind, text)]);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      setSrc({ blob: await r.blob(), words, from: words ? 'saved' : null, label: 'הקטע השמור' });
    } catch (e) { setErr('אי אפשר לטעון את הקטע: ' + e.message); }
  };
  const fromFile = (f) => {
    if (!f) return;
    if (!/^audio\//.test(f.type)) { CF.toast('זה לא קובץ אודיו'); return; }
    if (f.size > 20 * 1024 * 1024) { CF.toast('הקובץ גדול מדי'); return; }
    setOpen('file'); setErr(''); setSrc({ blob: f, label: f.name });
  };
  const save = async (wav, cut) => {
    setBusy(true); setErr('');
    try {
      if (playing === key) playClip(key);
      await putClip(voice, kind, text, await blobToBase64(wav), cut.timestamps);
      CF.toast('נשמר: ' + text);
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <li className={'vc-row vc-trow' + (playing === key ? ' playing' : '') + (open ? ' editing' : '')}>
      <button type="button" className="vc-play" disabled={!has} aria-label={(playing === key ? 'עצירה: ' : 'השמעה: ') + text} onClick={() => playClip(key, url)}>
        <Icon name={playing === key ? 'stop' : 'play'} />
      </button>
      <span className="vc-name" dir="auto">{text}</span>
      <span className="vc-meta">{has === null ? '…' : has ? <span className="vc-ok"><Icon name="check" />יש קטע</span> : <span className="vc-miss">אין קטע</span>}</span>
      <span className="vc-acts">
        {tts && <button type="button" className={'btn-soft sm' + (open === 'tts' ? ' on' : '')} disabled={busy && open === 'tts'} onClick={() => { setSrc(null); setErr(''); setOpen(open === 'tts' ? null : 'tts'); }}><Icon name="sparkle" />Cartesia</button>}
        <button type="button" className={'btn-soft sm' + (open === 'rec' ? ' on' : '')} onClick={() => { setSrc(null); setOpen(open === 'rec' ? null : 'rec'); }}><Icon name="mic" />הקלטה</button>
        <button type="button" className={'btn-soft sm' + (open === 'file' ? ' on' : '')} onClick={() => fileRef.current && fileRef.current.click()}><Icon name="upload" />קובץ</button>
        {has && <button type="button" className={'btn-soft sm' + (open === 'edit' ? ' on' : '')} onClick={edit}><Icon name="scissors" />חיתוך</button>}
      </span>
      <input ref={fileRef} type="file" accept="audio/*" hidden onChange={(e) => { const f = e.target.files[0]; e.target.value = ''; fromFile(f); }} />
      {open && (
        <div className="vc-editor">
          <div className="vc-editor-h"><b dir="auto">{text}</b>{src && <small>{src.label}</small>}<span className="tb-spacer" /><button type="button" className="icon-btn" aria-label="סגירה" onClick={() => setOpen(null)}><Icon name="close" /></button></div>
          {open === 'rec' && !src && <Recorder onDone={(blob) => setSrc({ blob, label: 'הקלטה' })} />}
          {open === 'tts' && (
            <form className="vc-tts-form" onSubmit={(e) => { e.preventDefault(); generate(); }}>
              <label className="vc-tts-label" htmlFor={'tts-' + key}>מה Cartesia יגיד</label>
              <div className="vc-tts-row">
                <input id={'tts-' + key} className="input" dir="auto" maxLength={500} value={prompt} autoFocus onChange={(e) => setPrompt(e.target.value)} />
                <button type="submit" className="btn-primary sm" disabled={busy || !prompt.trim()}><Icon name="sparkle" />{busy ? 'יוצר…' : src ? 'יצירה מחדש' : 'יצירה'}</button>
              </div>
              <small className="vc-hint">
                הקטע יישמר תחת הנוסח "{text}", אבל Cartesia יגיד מה שכתוב כאן: איות אחר, ניקוד, פיסוק או [laughter].
                {prompt.trim() !== text && <> <button type="button" className="link" onClick={() => setPrompt(text)}>חזרה לנוסח</button></>}
              </small>
            </form>
          )}
          {err && <p className="vc-err" dir="auto">{err}</p>}
          {src && (
            <WaveEditor source={src.blob} words={src.words && src.words.words && src.words.words.length ? src.words.words : words} initialWords={src.words || null} wordsFrom={src.from}
              autoTrim={open !== 'edit'} busy={busy}
              saveLabel={has ? 'שמירה במקום הקטע הקיים' : 'שמירה'} onSave={save} />
          )}
        </div>
      )}
    </li>
  );
}

/* record from the microphone, then hand the audio to the editor */
const MAX_REC = 30;
function Recorder({ onDone }) {
  const [phase, setPhase] = useState('idle'); // idle | starting | rec
  const [t, setT] = useState(0);
  const [level, setLevel] = useState(0);
  const [err, setErr] = useState('');
  const rec = useRef(null);
  const timer = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; clearInterval(timer.current); if (rec.current) rec.current.cancel(); rec.current = null; }, []);

  const start = async () => {
    setErr(''); setPhase('starting');
    let r;
    try { r = await startRecording(); } catch (e) { if (alive.current) { setErr(e.message); setPhase('idle'); } return; }
    if (!alive.current) { r.cancel(); return; } // closed while the browser asked for the mic: close it
    rec.current = r;
    claimAudio(() => {}); // stop whatever is playing, so it isn't recorded
    const t0 = performance.now();
    setT(0); setPhase('rec');
    timer.current = setInterval(() => {
      const s = (performance.now() - t0) / 1000;
      setT(s);
      setLevel(rec.current ? rec.current.level() : 0);
      if (s >= MAX_REC) stop();
    }, 60);
  };
  const stop = async () => {
    clearInterval(timer.current);
    const r = rec.current;
    rec.current = null;
    if (!r) return;
    const b = await r.stop();
    if (!alive.current) return;
    setLevel(0); setPhase('idle');
    if (!b.size) { setErr('ההקלטה ריקה'); return; }
    onDone(b);
  };
  return (
    <div className="vc-rec">
      <div className="vc-rec-row">
        {phase === 'rec' ? <button type="button" className="vc-rec-btn on" onClick={stop}><Icon name="stop" />עצירה</button>
          : <button type="button" className="vc-rec-btn" disabled={phase === 'starting'} onClick={start}><Icon name="mic" />{phase === 'starting' ? 'פותח מיקרופון…' : 'הקלטה'}</button>}
        {phase === 'rec' ? (<>
          <span className="vc-rec-dot" aria-hidden="true" />
          <span className="vc-rec-t" dir="ltr">{t.toFixed(1)}s / {MAX_REC}s</span>
          <span className="vc-meter" aria-hidden="true"><i style={{ width: Math.round(level * 100) + '%' }} /></span>
        </>) : <small className="vc-hint">עד {MAX_REC} שניות. אחרי העצירה: חיתוך וסימון המילים.</small>}
      </div>
      {err && <p className="vc-err">{err}</p>}
    </div>
  );
}
