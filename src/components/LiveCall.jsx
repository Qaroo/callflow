import { useEffect, useRef, useState } from 'react';
import CF from '../lib/core.js';
import live, { STATUS, END_REASON, SOCKET, statusOf, isLiveRec, flowOfCall, stepName, watchCall, closePanel, showOnCanvas, refreshList, setListOpen, startAudio, stopAudio,
  shownRec, canReplay, replayPlay, replayPause, replaySeek, replayRate, replayExit, lineStart, stepStart } from '../lib/liveCalls.js';
import { Icon } from './Icon.jsx';

const SPEAKER = { customer: 'לקוח', aiAgent: 'סוכן', agent: 'נציג', human: 'נציג', system: 'מערכת' };
const cleanLine = (t) => String(t || '').replace(/\[[a-z_ -]+\]\s*/gi, '').replace(/[‪-‮⁦-⁩]/g, '').trim();
const pct = (x) => Math.round(Number(x) * 100);
const fmtDur = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const hhmm = (t) => new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
/* the list's time: today's calls by the clock, older ones with the date too */
const whenShort = (t) => {
  const d = new Date(t);
  if (d.toDateString() === new Date().toDateString()) return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }) + ' ' + d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
};
const argText = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v));

function useTick(on) {
  const [, set] = useState(0);
  useEffect(() => { if (!on) return undefined; const t = setInterval(() => set((x) => x + 1), 1000); return () => clearInterval(t); }, [on]);
}

function Duration({ r }) {
  const st = statusOf(r);
  useTick(st === 'active');
  const i = r.info || {};
  if (st === 'active' && i.startTime) return <span className="lc-dur">{fmtDur((Date.now() - new Date(i.startTime).getTime()) / 1000)}</span>;
  if (i.duration != null && st === 'ended') return <span className="lc-dur">{fmtDur(i.duration)}</span>;
  return null;
}

/* an ended call's recording: play it and the panel + canvas follow the call second by second */
const RATES = [1, 1.5, 2];
function Replay({ r }) {
  const p = live.replay || { state: 'idle', t: 0, dur: 0, rate: 1 };
  const dur = p.dur || Number(r.info.duration) || 0;
  const t = Math.min(p.t || 0, dur || Infinity);
  const playing = p.state === 'playing' || (p.state === 'loading' && p.on);
  // where the call moved to a new step: ticks on the bar
  const ticks = (r.moves || []).length && r.info.startTime && live.rec ? [...new Set((stepStartAll(live.rec) || []).slice(1))] : [];
  return (
    <div className={'lc-replay st-' + p.state + (p.on ? ' on' : '')}>
      <div className="lc-rrow">
        <button type="button" className="lc-play" onClick={playing ? replayPause : replayPlay} aria-label={playing ? 'השהה' : 'נגן את ההקלטה'} title={playing ? 'השהה' : 'נגן את ההקלטה'}>
          {p.state === 'loading' && p.on ? <span className="ab-spin" /> : <Icon name={playing ? 'pause' : 'play'} />}
        </button>
        <div className="lc-bar" dir="ltr">
          <input type="range" min="0" max={dur || 1} step="0.1" value={t} aria-label="מיקום בהקלטה"
            style={{ '--pct': (dur ? (t / dur) * 100 : 0) + '%' }} onChange={(e) => replaySeek(Number(e.target.value))} />
          {dur > 0 && ticks.map((s, i) => <i key={i} className="lc-tick" style={{ left: Math.max(0, Math.min(100, (s / dur) * 100)) + '%' }} />)}
        </div>
        <span className="lc-rtime" dir="ltr">{fmtDur(t)} / {fmtDur(dur)}</span>
        <button type="button" className="lc-rate" title="מהירות" onClick={() => replayRate(RATES[(RATES.indexOf(p.rate || 1) + 1) % RATES.length])}>{p.rate || 1}×</button>
        {p.on && <button type="button" className="icon-btn" title="הצג את כל השיחה" aria-label="סיים ניגון והצג את כל השיחה" onClick={replayExit}><Icon name="close" /></button>}
      </div>
      {p.error ? <small className="lc-err">{p.error}</small>
        : !p.on ? <small className="lc-muted">{(r.moves || []).length ? 'נגנו את ההקלטה, והתסריט יזוז לפי מה שקורה בשיחה. לחיצה על שורה בתמלול או על צעד במסלול קופצת אליו.' : 'אין לשיחה הזו נתוני צעדים, אז בזמן הניגון יזוז רק התמלול.'}</small>
          : null}
    </div>
  );
}
const stepStartAll = (rec) => { const out = []; for (let i = 0; ; i++) { const s = stepStart(rec, i); if (s === undefined) break; out.push(s); } return out; };

/* the watched call: status, where it is in the script, what the decision model read each turn, answers, tools, result, transcript */
export function LivePanel() {
  const r = shownRec(); // during a replay: the call as it was at that second of the recording
  const full = live.rec;
  const [min, setMin] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const trRef = useRef(null);
  const n = r ? (r.transcripts || []).length : 0;
  const partialText = r && r.partial ? r.partial.text : '';
  useEffect(() => { const el = trRef.current; if (el) el.scrollTop = el.scrollHeight; }, [n, partialText]);
  if (!live.open || !r) return null;

  const st = statusOf(r);
  const S = STATUS[st] || { label: st, tone: 'wait' };
  const flow = flowOfCall(r);
  const name = (r.meta && r.meta.flowName) || (flow && flow.name) || 'שיחה ' + r.callId.slice(0, 6);
  const moves = r.moves || [];
  const last = moves[moves.length - 1];
  const path = r.path || [];
  const cur = r.step || path[path.length - 1];
  const slots = Object.entries(r.slots || {});
  const tools = r.tools || [];
  const polled = (r.reports || [])[(r.reports || []).length - 1];
  const report = r.liveReport && r.liveReport.report && !(st === 'ended' && polled && polled.report) ? r.liveReport : polled;
  const sock = (r.socket && r.socket.state) || 'idle';
  const au = live.audio || { state: 'off' };
  const canListen = isLiveRec(r) && (sock === 'live' || sock === 'open');
  const replayable = canReplay(full);
  const moving = isLiveRec(r) || (r.replay && !r.replayDone);
  const others = (r.events || []).filter((e) => e.event !== 'script_moved' && e.event !== 'script_result');
  const onCanvas = flow && CF.state.id === flow.id && CF.ui.view === 'flows';
  const offTurns = last && last.TurnsOffScript;
  const endReason = r.info && r.info.endReason;

  if (min) {
    return (
      <button type="button" className={'lc-pill glass tone-' + S.tone} onClick={() => setMin(false)} title="פתח את מעקב השיחה">
        <span className="lc-dot" /><b>{S.label}</b><Duration r={r} />
        {cur && <span className="lc-pill-step" dir="auto">{stepName(r, cur)}</span>}
      </button>
    );
  }

  return (
    <section className={'live-panel glass tone-' + S.tone} aria-label="מעקב שיחה חי" dir="rtl">
      <header className="lc-head">
        <span className="lc-dot" />
        <div className="lc-titles">
          <div className="lc-status"><b>{S.label}</b><Duration r={r} />{st === 'ended' && endReason && <small>· {END_REASON[endReason] || endReason}</small>}</div>
          <div className="lc-name" dir="auto">{name}</div>
        </div>
        <button className="icon-btn" type="button" title="מזער" aria-label="מזער" onClick={() => setMin(true)}><Icon name="minus" /></button>
        <button className="icon-btn" type="button" title="סגור" aria-label="סגור" onClick={closePanel}><Icon name="close" /></button>
      </header>

      <div className={'lc-sock s-' + sock} title={r.socket && r.socket.reason ? r.socket.reason : ''}>
        <Icon name="wave" /><span>{SOCKET[sock] || sock}</span>{r.socket && r.socket.endpoint && (sock === 'live' || sock === 'open') && <code dir="ltr">{r.socket.endpoint}</code>}
        {r.pollError && <span className="lc-err"> · סטטוס: {r.pollError}</span>}
      </div>

      {replayable && <Replay r={full} />}
      {!replayable && !r.watching && full.info && (full.info.status === 'ended' || full.info.status === 'failed') && !full.info.recordingId && (
        <div className="lc-replay none"><small className="lc-muted">{full.info.answered === false ? 'אין הקלטה: לא ענו לשיחה.' : 'אין הקלטה לשיחה הזו ב-AIServant.'}</small></div>
      )}

      {(canListen || au.state !== 'off') && (
        <div className={'lc-audio a-' + au.state}>
          {au.state === 'off' || au.state === 'failed'
            ? <button type="button" className="btn-soft" disabled={!canListen} onClick={startAudio}><Icon name="wave" />האזן לשיחה</button>
            : <button type="button" className="btn-soft on" onClick={() => stopAudio()}><Icon name="stop" />{au.state === 'connecting' ? 'מתחבר לשמע…' : 'מפסיק האזנה'}</button>}
          {au.state === 'on' && <span className="lc-eq" aria-hidden="true"><i /><i /><i /><i /></span>}
          {au.error && <small className={au.state === 'failed' ? 'lc-err' : 'lc-muted'}>{au.error}</small>}
        </div>
      )}
      {(r.voicemail || r.unanswered) && <div className="lc-warn"><Icon name="phone" />{r.voicemail ? 'נפל לתא קולי' : 'השיחה הסתיימה לפני שענו'}</div>}

      {cur ? (
        <div className="lc-now">
          <small>{r.replay && !r.replayDone ? 'בהקלטה, השיחה כאן ב' : isLiveRec(r) ? 'השיחה עכשיו ב' : 'השיחה הסתיימה ב'}</small>
          <div className="lc-step" dir="auto">{stepName(r, cur)} <code dir="ltr">{cur}</code></div>
          {r.runningTool && moving && <div className="lc-running"><span className="ab-spin" />מריץ את הכלי <code dir="ltr">{r.runningTool}</code>…</div>}
          {flow && <button className="link" type="button" onClick={showOnCanvas}><Icon name="eye" />{onCanvas ? 'התמקד בצעד' : 'הצג על התסריט'}</button>}
          {!flow && <small className="lc-muted">התסריט של השיחה לא נמצא בסטודיו, אז הצעדים מוצגים כאן בלבד.</small>}
        </div>
      ) : (
        <div className="lc-now empty">
          <small>{isLiveRec(r) ? 'עוד לא הגיע צעד מהסקריפט.' : 'לא התקבלו אירועי סקריפט לשיחה הזאת.'}</small>
          <small className="lc-muted">{sock === 'rejected'
            ? `AIServant לא אישר את ההאזנה (${(r.socket && r.socket.reason) || 'Unauthorized'}), ולכן אין צעדים. הסטטוס והתמלול ממשיכים להתעדכן.`
            : sock === 'live' || sock === 'open'
              ? 'הצעד הנוכחי יופיע עם האירוע script_moved הראשון, אחרי שהלקוח יענה וידבר.'
              : 'הצעד הנוכחי מגיע מהאזנה לשיחה (script_moved). בלי האזנה מוצגים סטטוס ותמלול בלבד.'}</small>
        </div>
      )}

      {path.length > 0 && (
        <div className="lc-sec">
          <div className="lc-sec-t">המסלול</div>
          <div className="lc-path">
            {path.map((k, i) => (replayable && stepStart(full, i) !== undefined
              ? <button type="button" key={i + k} className={'lc-chip seek' + (i === path.length - 1 ? ' last' : '')} dir="auto" title="נגן מהצעד הזה" onClick={() => replaySeek(stepStart(full, i))}>{stepName(r, k)}</button>
              : <span key={i + k} className={'lc-chip' + (i === path.length - 1 ? ' last' : '')} dir="auto">{stepName(r, k)}</span>
            ))}
          </div>
        </div>
      )}

      {offTurns >= 2 && moving && <div className="lc-warn"><Icon name="sparkle" />{offTurns} תורות ברצף בלי התקדמות בתסריט</div>}

      {moves.length > 0 && (
        <div className="lc-sec">
          <div className="lc-sec-t">מה ההחלטה קראה בכל תור</div>
          <ol className="lc-moves">
            {moves.slice(-8).reverse().map((m, i) => {
              const tool = m.Likelihood == null && (m.Pick === 'ok' || m.Pick === 'failed');
              const notTaken = !tool && m.From === m.To && m.Pick && m.Pick !== 'none';
              const low = m.Likelihood != null && m.Likelihood < 0.6;
              return (
                <li key={i} className={(notTaken ? 'not-taken' : '') + (low ? ' low' : '')}>
                  <div className="lm-top">
                    <span dir="auto">{stepName(r, m.From)}</span>
                    {m.From !== m.To && <><Icon name="chevronLeft" /><b dir="auto">{stepName(r, m.To)}</b></>}
                  </div>
                  <div className="lm-pick">
                    {tool ? <span className={'lm-tool ' + m.Pick}>כלי: {m.Pick === 'ok' ? 'הצליח' : 'נכשל'}</span> : <code dir="auto">{m.Pick || 'none'}</code>}
                    {m.Likelihood != null && <span className="lm-bar" title={pct(m.Likelihood) + '%'}><i style={{ width: pct(m.Likelihood) + '%' }} /></span>}
                    {m.Likelihood != null && <span className="lm-p">{pct(m.Likelihood)}%</span>}
                    {notTaken && <span className="lm-flag">{low ? 'מתחת לסף, לא נלקח' : 'נשאר באותו צעד'}</span>}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {slots.length > 0 && (
        <div className="lc-sec">
          <div className="lc-sec-t">תשובות (slots)</div>
          <dl className="lc-slots">{slots.map(([k, v]) => <div key={k}><dt dir="ltr">{k}</dt><dd dir="auto">{argText(v)}</dd></div>)}</dl>
        </div>
      )}

      {tools.length > 0 && (
        <div className="lc-sec">
          <div className="lc-sec-t">כלים שרצו</div>
          {tools.map((t, i) => (
            <div key={i} className={'lc-tool' + (t.Failed ? ' fail' : '')}>
              <div><Icon name={t.Failed ? 'close' : 'check'} /><code dir="ltr">{t.Tool}</code>{t.Failed ? ' נכשל' : ''}</div>
              {t.Arguments && Object.keys(t.Arguments).length > 0 && (
                <dl className="lc-slots">{Object.entries(t.Arguments).map(([k, v]) => <div key={k}><dt dir="ltr">{k}</dt><dd dir="auto">{argText(v)}</dd></div>)}</dl>
              )}
            </div>
          ))}
        </div>
      )}

      {r.result && (
        <div className="lc-result">
          <Icon name="check" />
          <div><b>תוצאת הסקריפט</b><span dir="auto">הסתיימה ב{stepName(r, r.result.FinalStep)} אחרי {(r.result.Path || []).length} צעדים</span></div>
        </div>
      )}

      {report && report.report && (
        <div className="lc-sec">
          <div className="lc-sec-t">{report === r.liveReport ? 'מצב השיחה (חי)' : 'סיכום AIServant'}{report.satisfaction != null && report === r.liveReport ? <span className="lc-sat">{Math.round(Number(report.satisfaction) > 1 ? Number(report.satisfaction) : Number(report.satisfaction) * 100)}%</span> : null}{report.needHuman ? <span className="lc-human">צריך נציג</span> : null}</div>
          <p className="lc-report" dir="auto">{report.report}</p>
        </div>
      )}

      <div className="lc-sec">
        <div className="lc-sec-t">תמלול{n ? ` (${n})` : ''}{r.speaking && isLiveRec(r) ? <span className="lc-speaking">{SPEAKER[r.speaking] || r.speaking} מדבר/ת…</span> : null}</div>
        <div className="lc-tr" ref={trRef}>
          {n === 0 && !partialText && <small className="lc-muted">{st === 'pending' ? 'מחכה שיענו…' : 'עוד אין דיבור.'}</small>}
          {(r.transcripts || []).map((t, i) => (replayable
            ? (
              <button type="button" key={i} className={'lc-line seek sp-' + (t.speaker || 'x') + (r.replay && !r.replayDone && i === n - 1 ? ' current' : '')} title="נגן מהשורה הזאת" onClick={() => replaySeek(lineStart(full, i))}>
                <span className="lc-who">{SPEAKER[t.speaker] || t.speaker}</span>
                <span dir="auto">{cleanLine(t.text)}</span>
              </button>
            ) : (
              <div key={i} className={'lc-line sp-' + (t.speaker || 'x')}>
                <span className="lc-who">{SPEAKER[t.speaker] || t.speaker}</span>
                <span dir="auto">{cleanLine(t.text)}</span>
              </div>
            )))}
          {partialText && isLiveRec(r) && (
            <div className={'lc-line partial sp-' + (r.partial.speaker || 'x')}>
              <span className="lc-who">{SPEAKER[r.partial.speaker] || r.partial.speaker}</span>
              <span dir="auto">{cleanLine(partialText)}…</span>
            </div>
          )}
        </div>
      </div>

      {others.length > 0 && (
        <div className="lc-sec">
          <button type="button" className="link" onClick={() => setShowEvents((x) => !x)}>
            <Icon name={showEvents ? 'chevronDown' : 'chevronLeft'} />כל האירועים מהשרת ({others.length})
          </button>
          {showEvents && (
            <ol className="lc-events" dir="ltr">
              {others.slice(-60).reverse().map((e, i) => (
                <li key={i}><span>{hhmm(e.at)}</span><b>{e.event}</b><code>{JSON.stringify(e.data).slice(0, 240)}</code></li>
              ))}
            </ol>
          )}
        </div>
      )}
      <div className="lc-foot" dir="ltr"><code>{r.callId}</code></div>
    </section>
  );
}

/* the list of calls: the current account's history from AIServant (live ones first) */
export function LiveList() {
  useEffect(() => {
    const close = (e) => { if (!e.target.closest('.live-list, .live-btn')) setListOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  if (!live.listOpen) return null;
  const calls = live.list;
  return (
    <div className="live-list glass" dir="rtl" role="dialog" aria-label="שיחות">
      <div className="ll-head"><b>שיחות אמיתיות</b>{live.listAccount && <code className="ll-acct" dir="ltr" title={'X-Agency-Id: ' + live.listAccount}>{live.listAccount.slice(0, 10)}{live.listAccount.length > 10 ? '…' : ''}</code>}<button className="link" type="button" onClick={refreshList}>רענון</button></div>
      {live.configured === false && <p className="hint">כדי לראות שיחות צריך את AISERVANT_SHARED_SECRET ב-.env, חשבון (Agency ID ב-.env או בהגדרות), ואת השרת המקומי (npm run dev).</p>}
      {live.listError && <p className="hint err">ההיסטוריה לא נטענה: {live.listError}</p>}
      {live.configured && !live.listError && calls.length === 0 && <p className="hint">אין שיחות בחשבון הזה. שיחה שמחייגים מחלון הייצוא נפתחת כאן מעצמה.</p>}
      {calls.map((c) => {
        const st = statusOf(c);
        const S = STATUS[st] || { label: st, tone: 'wait' };
        const name = (c.meta && c.meta.flowName) || (c.lead && c.lead !== 'לקוח' ? 'שיחה עם ' + c.lead : 'שיחה ' + c.callId.slice(0, 6));
        return (
          <button key={c.callId} type="button" className={'ll-item tone-' + S.tone + (live.rec && live.rec.callId === c.callId ? ' on' : '')}
            onClick={() => { watchCall(c.callId, c.meta); setListOpen(false); }}>
            <span className="lc-dot" />
            <span className="ll-main">
              <b dir="auto">{name}</b>
              <small dir="auto">{S.label}{c.info && c.info.endReason && st !== 'active' ? ' · ' + (END_REASON[c.info.endReason] || c.info.endReason) : ''}
                {c.step ? ' · ' + stepName(c, c.step) : ''}</small>
              {c.lastLine && <small className="ll-line" dir="auto">{cleanLine(c.lastLine.text)}</small>}
            </span>
            <span className="ll-time">{c.info && c.info.recordingId && st === 'ended' && <span className="ll-rec" title="יש הקלטה: פתחו ולחצו נגן"><Icon name="play" /></span>}{c.info && c.info.createdAt ? whenShort(c.info.createdAt) : ''}</span>
          </button>
        );
      })}
    </div>
  );
}

/* toolbar button: number of live calls, pulsing while one runs */
export function LiveButton() {
  useEffect(() => {
    refreshList();
    const t = setInterval(() => { if (document.visibilityState === 'visible') refreshList(); }, 10000);
    return () => clearInterval(t);
  }, []);
  const n = live.list.filter((c) => isLiveRec(c)).length;
  return (
    <button type="button" className={'tb-btn live-btn' + (n ? ' has-live' : '') + (live.listOpen ? ' on' : '')} title="שיחות אמיתיות: סטטוס חי"
      onClick={() => setListOpen(!live.listOpen)}>
      <Icon name="phone" /><span className="tb-label">שיחות</span>{n > 0 && <span className="live-count">{n}</span>}
    </button>
  );
}
