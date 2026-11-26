import { useEffect, useState } from 'react';
import CF from '../lib/core.js';
import { ENV, settings } from '../lib/settings.js';
import { buildMakeCall, applyValues } from '../lib/script.js';
import { placeCall, apiUrl } from '../lib/dialer.js';
import { watchCall, showOnCanvas } from '../lib/liveCalls.js';
import { Icon } from './Icon.jsx';

const splitWords = (s) => String(s || '').split(/[,،\n]/).map((w) => w.trim()).filter(Boolean);

/* A real call (makecall) from a saved flow: number, lead name, and the hot words for this call.
   Used by the export window and by the builder's last step. */
export default function DialPanel({ flow, agent, errors, title }) {
  const scriptWords = (flow && flow.instructions && flow.instructions.hotWords) || '';
  const [to, setTo] = useState('');
  const [leadName, setLeadName] = useState('');
  const [hotWords, setHotWords] = useState(scriptWords);
  const [addLead, setAddLead] = useState(true);
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  useEffect(() => { setArmed(false); }, [to, hotWords, leadName, addLead]);
  useEffect(() => { setHotWords(scriptWords); }, [flow && flow.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const call = { to: to || '0500000000', leadName, hotWords, addLeadToHotWords: addLead };
  const body = flow ? buildMakeCall(flow, agent, call) : null;
  const sent = body ? splitWords(body.instructions.hotWords) : [];
  const changed = hotWords.trim() !== scriptWords.trim();

  const saveToScript = () => {
    if (!flow) return;
    const live = CF.flowById(flow.id) || flow;
    if (live === CF.state) CF.checkpoint();
    live.instructions.hotWords = hotWords.trim();
    CF.commit();
    CF.toast('ה-hotWords נשמרו בתסריט');
  };

  return (
    <div className="dial">
      <div className="section-title"><span>{title || 'חיוג אמיתי'}</span><small>makecall</small></div>
      <div className="dial-row">
        <label className="field"><span>למספר <code>to</code></span>
          <input className="input" dir="ltr" inputMode="tel" value={to} placeholder="0501234567" onChange={(e) => setTo(e.target.value.trim())} />
        </label>
        <label className="field"><span>שם הליד <code>leadInfo.name</code></span>
          <input className="input" dir="auto" value={leadName} placeholder="דנה כהן" onChange={(e) => setLeadName(e.target.value)} />
        </label>
      </div>

      <label className="field"><span>מילים לזיהוי והגייה <code>hotWords</code>
        {changed && <small className="hw-changed">שונה לשיחה הזאת</small>}</span>
        <textarea className="textarea" rows={2} dir="auto" value={hotWords} placeholder="שמות, מותגים ומונחים, מופרדים בפסיק"
          onChange={(e) => setHotWords(e.target.value)} />
      </label>
      <div className="hw-row">
        <label className="req-chk"><input type="checkbox" checked={addLead} onChange={(e) => setAddLead(e.target.checked)} />להוסיף את שם הליד</label>
        <span className="tb-spacer" />
        {changed && <button type="button" className="link" onClick={() => setHotWords(scriptWords)}>חזרה למה שבתסריט</button>}
        {changed && <button type="button" className="link" onClick={saveToScript}><Icon name="check" />שמור בתסריט</button>}
      </div>
      {sent.length > 0 && (
        <div className="hw-chips" dir="auto">
          <small>יישלח:</small>{sent.map((w) => <span key={w} className="hw-chip">{applyValues(w, flow)}</span>)}
        </div>
      )}
      <p className="hint">AIServant משתמש ב-hotWords כדי לזהות את המילים האלה בדיבור של הלקוח ולהגות אותן נכון. השינוי כאן חל רק על השיחה הזאת, אלא אם שומרים אותו בתסריט.</p>

      <div className="dial-meta" dir="auto">
        <span>חשבון <code dir="ltr">{ENV.account || '—'}</code></span>
        <span>שרת <code dir="ltr">{apiUrl('/sip/makecall')}</code></span>
        <span>קול <code dir="ltr">{(agent && agent.cartesiaVoiceId) || settings.voiceId || 'ברירת המחדל של השרת'}</code></span>
      </div>
      <button className={'btn-primary dial-btn' + (armed ? ' armed' : '')} type="button" disabled={busy || !to || !flow || (errors && errors.length > 0)}
        onClick={async () => {
          if (!armed) { setArmed(true); return; }
          setArmed(false); setBusy(true); setResult(null);
          const r = await placeCall(flow, agent, call);
          CF.lastDial = Object.assign({ at: Date.now() }, r); // the builder agent reads the result (callId) from here
          setBusy(false); setResult(r);
          // follow the call live: status, transcript and (once AIServant sends them) the script steps
          const callId = r.ok && r.json && r.json.callId;
          if (callId) {
            watchCall(callId, { flowName: flow.name, flowId: flow.id });
            if (CF.ui.exportOpen && !CF.builder?.state?.run) { CF.ui.exportOpen = false; CF.emit('export'); showOnCanvas(); }
          }
        }}>
        <Icon name="phone" />{busy ? 'שולח…' : armed ? `ללחוץ שוב כדי לחייג עכשיו ל-${to}` : 'חייג'}
      </button>
      {errors && errors.length > 0 && <p className="hint">אי אפשר לחייג עם תסריט ש-AIServant ידחה. תקנו את הבעיות קודם.</p>}
      <p className="hint">זו שיחה אמיתית: הטלפון במספר הזה יצלצל.</p>
      {result && (
        <div className={'verdict ' + (result.ok ? 'ok' : 'bad')}>
          <Icon name={result.ok ? 'check' : 'close'} />
          <span dir="auto" className="pre">{result.ok ? `השיחה נשלחה (${result.status}). המעקב החי נפתח.` : `${result.status ? result.status + ': ' : ''}${result.message}`}</span>
          {result.ok && result.json && result.json.callId && <button type="button" className="link" onClick={() => watchCall(result.json.callId, { flowName: flow.name, flowId: flow.id })}>מעקב חי</button>}
        </div>
      )}
      {body && <details className="example-box"><summary>גוף ה-makecall שיישלח</summary><pre className="json small" dir="ltr">{JSON.stringify(body, null, 2)}</pre></details>}
    </div>
  );
}
